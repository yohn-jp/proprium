#!/usr/bin/env node
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ledgerPath = path.join(root, "docs/migration/ledger.json");
const args = process.argv.slice(2);
let sourceRoot;
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === "--source-root" && args[index + 1]) {
    sourceRoot = path.resolve(args[index + 1]);
    index += 1;
  } else {
    throw new Error(`Unknown or incomplete argument: ${args[index]}`);
  }
}

const ledger = JSON.parse(await readFile(ledgerPath, "utf8"));
const failures = [];
function check(condition, message) {
  if (!condition) failures.push(message);
}
function expectedIds(prefix, count) {
  return Array.from({ length: count }, (_, index) => `${prefix}${String(index + 1).padStart(2, "0")}`);
}
function equalIds(actual, expected, label) {
  check(JSON.stringify(actual) === JSON.stringify(expected), `${label} IDs must be ${expected[0]}–${expected.at(-1)} in order`);
}
async function exists(base, relative, label) {
  if (typeof relative !== "string" || !relative || relative.includes("*")) {
    check(false, `${label} has an invalid path: ${String(relative)}`);
    return false;
  }
  try {
    await stat(path.resolve(base, relative));
    return true;
  } catch {
    check(false, `${label} path does not exist: ${relative}`);
    return false;
  }
}
function fileFromLocator(value) {
  if (typeof value !== "string") return null;
  const match = /^(?:\.\/)?((?:app|docs|modules|packages|scripts|tests)\/[^\s:'"`]+?\.(?:[cm]?[jt]sx?|json|ya?ml|md|toml|css|html))(?:[:].*)?$/u.exec(value);
  return match?.[1] ?? null;
}
function collectSourceFile(row, output) {
  if (typeof row?.source === "string") output.add(row.source);
  for (const value of row?.sourceFileEvidence ?? []) if (typeof value === "string") output.add(value);
  for (const value of row?.callerAndUiSurfaceExpansion?.observedUiCallsitePaths ?? []) {
    if (typeof value === "string" && !value.includes("*")) output.add(value);
  }
  for (const caller of row?.callerAndUiSurfaceExpansion?.apiOrTransportCallers ?? []) {
    if (typeof caller?.module === "string") output.add(caller.module);
  }
  for (const locator of row?.handlerCallSymbolsExpansion?.symbols?.inlineHandlerLocators ?? []) {
    const file = fileFromLocator(locator);
    if (file) output.add(file);
  }
  const storageEvidence = row?.storageReaderWriterExpansion?.evidence?.evidence ?? [];
  for (const value of storageEvidence) if (typeof value === "string") output.add(value);
  for (const boundary of row?.storageReaderWriterExpansion?.evidence?.observedMutationBoundaries ?? []) {
    for (const symbol of boundary?.sourceSymbols ?? []) if (typeof symbol?.module === "string") output.add(symbol.module);
  }
  const transport = row?.transportActionSurface;
  for (const value of [transport?.http?.registrar?.module, transport?.http?.transportEntry?.module,
    transport?.stdio?.registrar?.module, transport?.stdio?.transportEntry?.module]) {
    if (typeof value === "string") output.add(value);
  }
  for (const value of [...(transport?.http?.toolsWithPersistentEffects ?? []), ...(transport?.stdio?.toolsWithPersistentEffects ?? [])]) {
    if (typeof value?.module === "string") output.add(value.module);
  }
  for (const value of transport?.http?.mutationGuardSymbols ?? []) if (typeof value?.module === "string") output.add(value.module);
}
function jsonPointerValue(value, pointer) {
  if (pointer === "" || pointer === "#") return value;
  const raw = pointer.startsWith("#") ? decodeURIComponent(pointer.slice(1)) : pointer;
  if (!raw.startsWith("/")) throw new Error(`Invalid JSON pointer: ${pointer}`);
  return raw.slice(1).split("/").map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"))
    .reduce((current, key) => {
      if (current === null || typeof current !== "object" || !(key in current)) return undefined;
      return current[key];
    }, value);
}

check(ledger.routeRegistrations?.length === 48 && ledger.routeRegistrationCount === 48, "ledger must contain exactly 48 router registrations");
check(ledger.nonRouterGroups?.length === 12 && ledger.nonRouterGroupCount === 12, "ledger must contain exactly 12 non-router groups");
equalIds((ledger.routeRegistrations ?? []).map(({ id }) => id), expectedIds("R", 48), "Router registration");
equalIds((ledger.nonRouterGroups ?? []).map(({ id }) => id), expectedIds("N", 12), "Non-router group");
const endpointCount = (ledger.routeRegistrations ?? []).reduce((count, route) => count + (route.registeredEndpoints?.length ?? 0), 0);
check(endpointCount === 166 && ledger.registeredEndpointCount === 166, `ledger endpoint count must be 166 (found ${endpointCount})`);

const sourceFiles = new Set();
const rows = [...(ledger.routeRegistrations ?? []), ...(ledger.nonRouterGroups ?? [])];
for (const row of rows) {
  collectSourceFile(row, sourceFiles);
  check(row.migrationStatus === "pending", `${row.id} must keep migrationStatus pending`);
  check(Array.isArray(row.proofIds) && row.proofIds.length === 0, `${row.id} must not claim completed proof IDs`);
}
for (const value of ledger.storageModel?.indexPathSplit?.evidence ?? []) sourceFiles.add(value.split(":")[0]);
for (const table of Object.values(ledger.storageModel?.indexPathSplit?.tableClassifications ?? {}).flat()) {
  for (const value of table?.evidence ?? []) sourceFiles.add(value.split(":")[0]);
}

if (sourceRoot) {
  const sourceHead = execFileSync("git", ["-C", sourceRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  check(sourceHead === ledger.sourceCommit, `source root HEAD ${sourceHead} must match pinned source commit ${ledger.sourceCommit}`);
  for (const file of sourceFiles) await exists(sourceRoot, file, "Source evidence");
}

const proofIds = new Set();
let sliceCount = 0;
for (const row of rows) {
  for (const slice of row.targetImplementationSlices ?? []) {
    sliceCount += 1;
    check(typeof slice.owner === "string" && /^P\d{2}$/u.test(slice.owner), `${row.id} target slice needs a campaign owner`);
    check(slice.status === "implementation-present; integration-acceptance-pending", `${row.id}/${slice.owner} must remain integration-acceptance-pending`);
    for (const target of [...(slice.targetPaths ?? []), ...(slice.uiSurfaces ?? [])]) await exists(root, target, `${row.id}/${slice.owner} target`);
    for (const proof of slice.proofRefs ?? []) {
      check(typeof proof.id === "string" && proof.id.length > 0, `${row.id}/${slice.owner} proof reference needs an ID`);
      if (proofIds.has(proof.id)) failures.push(`Duplicate proof reference ID: ${proof.id}`);
      proofIds.add(proof.id);
      check(typeof proof.testName === "string" && proof.testName.length > 0, `${proof.id} needs an exact test name`);
      check(typeof proof.scope === "string" && proof.scope.length > 0, `${proof.id} needs an acceptance scope`);
      await exists(root, proof.path, proof.id);
      if (proof.jsonPointer) {
        try {
          const evidence = JSON.parse(await readFile(path.resolve(root, proof.path), "utf8"));
          check(jsonPointerValue(evidence, proof.jsonPointer) !== undefined, `${proof.id} JSON pointer does not resolve: ${proof.jsonPointer}`);
        } catch (error) {
          failures.push(`${proof.id} JSON pointer failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
    for (const proof of slice.runtimeEvidenceRefs ?? []) {
      check(typeof proof.id === "string" && proof.id.length > 0, `${row.id}/${slice.owner} runtime evidence needs an ID`);
      if (proofIds.has(proof.id)) failures.push(`Duplicate proof reference ID: ${proof.id}`);
      proofIds.add(proof.id);
      check(typeof proof.scope === "string" && proof.scope.length > 0, `${proof.id} needs a runtime-evidence scope`);
      check(typeof proof.locator === "string" && proof.locator.length > 0, `${proof.id} needs a locator`);
      await exists(root, proof.path, proof.id);
    }
    for (const finding of slice.acceptanceFindings ?? []) {
      check(typeof finding.id === "string" && finding.id.length > 0, `${row.id}/${slice.owner} acceptance finding needs an ID`);
      if (proofIds.has(finding.id)) failures.push(`Duplicate evidence reference ID: ${finding.id}`);
      proofIds.add(finding.id);
      check(typeof finding.testName === "string" && finding.testName.length > 0, `${finding.id} needs an exact test name`);
      check(finding.result === "failed-at-current-ledger-head", `${finding.id} must preserve its observed failing result`);
      check(typeof finding.failure === "string" && finding.failure.length > 0, `${finding.id} needs the observed failure`);
      check(typeof finding.observedScope === "string" && finding.observedScope.length > 0, `${finding.id} needs the observed test scope`);
      await exists(root, finding.path, finding.id);
    }
  }
}

if (failures.length) {
  for (const failure of failures) console.error(`FAIL ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`Verified ${ledger.routeRegistrationCount} registrations, ${endpointCount} handlers, ${ledger.nonRouterGroupCount} non-router groups, ${sourceFiles.size} pinned source files, ${sliceCount} implementation slices and ${proofIds.size} unique evidence references.`);
}
