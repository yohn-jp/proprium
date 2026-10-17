#!/usr/bin/env node
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ledgerPath = path.join(root, "docs/migration/ledger.json");
const args = process.argv.slice(2);
let sourceRoot;
let requireClosed = false;
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === "--source-root" && args[index + 1]) {
    sourceRoot = path.resolve(args[index + 1]);
    index += 1;
  } else if (args[index] === "--require-closed") {
    requireClosed = true;
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
const migrationStatuses = new Set(["pending", "verified", "excluded", "relocated"]);
for (const row of rows) {
  collectSourceFile(row, sourceFiles);
  check(migrationStatuses.has(row.migrationStatus), `${row.id} has an unsupported migrationStatus: ${String(row.migrationStatus)}`);
  check(Array.isArray(row.proofIds), `${row.id} proofIds must be an array`);
  if (row.migrationStatus === "pending") {
    check(row.proofIds?.length === 0, `${row.id} must keep proofIds empty while migrationStatus is pending`);
    if (requireClosed) check(false, `${row.id} remains pending`);
  } else {
    check(row.proofIds?.length > 0, `${row.id} terminal migration status requires proofIds`);
    if (row.migrationStatus === "excluded" || row.migrationStatus === "relocated") {
      check(typeof row.closureRationale === "string" && row.closureRationale.trim().length > 0,
        `${row.id} ${row.migrationStatus} disposition requires closureRationale`);
      check((row.dispositionEvidenceRefs ?? []).some((ref) => ref.path === "docs/migration/FULL-MIGRATION-PLAN.md"
        && typeof ref.locator === "string" && ref.locator.includes(row.id)),
      `${row.id} ${row.migrationStatus} disposition requires a reference to its canonical plan row`);
    }
  }
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

const evidenceRefIds = new Set();
const closureEvidenceByRow = new Map(rows.map((row) => [row.id, new Map()]));
let sliceCount = 0;
function registerEvidenceId(row, ref, label) {
  check(typeof ref.id === "string" && ref.id.length > 0, `${label} needs an ID`);
  if (evidenceRefIds.has(ref.id)) failures.push(`Duplicate evidence reference ID: ${ref.id}`);
  evidenceRefIds.add(ref.id);
  if (typeof ref.id === "string") closureEvidenceByRow.get(row.id)?.set(ref.id, ref);
}
for (const row of rows) {
  for (const slice of row.targetImplementationSlices ?? []) {
    sliceCount += 1;
    check(typeof slice.owner === "string" && /^P\d{2}$/u.test(slice.owner), `${row.id} target slice needs a campaign owner`);
    check(slice.status === "implementation-present; integration-acceptance-pending", `${row.id}/${slice.owner} must remain integration-acceptance-pending`);
    for (const target of [...(slice.targetPaths ?? []), ...(slice.uiSurfaces ?? [])]) await exists(root, target, `${row.id}/${slice.owner} target`);
    for (const proof of slice.proofRefs ?? []) {
      registerEvidenceId(row, proof, `${row.id}/${slice.owner} proof reference`);
      check(typeof proof.testName === "string" && proof.testName.length > 0, `${proof.id} needs an exact test name`);
      check(typeof proof.scope === "string" && proof.scope.length > 0, `${proof.id} needs an acceptance scope`);
      if (proof.result !== undefined) check(proof.result === "passed", `${proof.id} result must be passed when specified`);
      if (proof.evidenceKind !== undefined) check(["focused", "composition"].includes(proof.evidenceKind), `${proof.id} has an unsupported evidenceKind`);
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
      registerEvidenceId(row, proof, `${row.id}/${slice.owner} runtime evidence`);
      check(typeof proof.scope === "string" && proof.scope.length > 0, `${proof.id} needs a runtime-evidence scope`);
      check(typeof proof.locator === "string" && proof.locator.length > 0, `${proof.id} needs a locator`);
      if (proof.result !== undefined) check(proof.result === "passed", `${proof.id} result must be passed when specified`);
      if (proof.evidenceKind !== undefined) check(["focused", "composition"].includes(proof.evidenceKind), `${proof.id} has an unsupported evidenceKind`);
      await exists(root, proof.path, proof.id);
    }
    for (const finding of slice.acceptanceFindings ?? []) {
      registerEvidenceId(row, finding, `${row.id}/${slice.owner} acceptance finding`);
      check(typeof finding.testName === "string" && finding.testName.length > 0, `${finding.id} needs an exact test name`);
      check(["failed-at-current-ledger-head", "resolved"].includes(finding.result), `${finding.id} must preserve its failure or record a resolved state`);
      check(typeof finding.failure === "string" && finding.failure.length > 0, `${finding.id} needs the observed failure`);
      check(typeof finding.observedScope === "string" && finding.observedScope.length > 0, `${finding.id} needs the observed test scope`);
      if (finding.result === "resolved") {
        check(typeof finding.resolutionRationale === "string" && finding.resolutionRationale.trim().length > 0,
          `${finding.id} resolved finding needs resolutionRationale`);
        check(Array.isArray(finding.resolutionProofIds) && finding.resolutionProofIds.length > 0,
          `${finding.id} resolved finding needs resolutionProofIds`);
      } else if (requireClosed) {
        check(false, `${finding.id} remains unresolved`);
      }
      await exists(root, finding.path, finding.id);
    }
  }
  for (const proof of row.dispositionEvidenceRefs ?? []) {
    registerEvidenceId(row, proof, `${row.id} disposition evidence`);
    check(typeof proof.scope === "string" && proof.scope.trim().length > 0, `${proof.id} needs a disposition-evidence scope`);
    check(typeof proof.locator === "string" && proof.locator.trim().length > 0, `${proof.id} needs a disposition-evidence locator`);
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
  const closureIds = row.proofIds ?? [];
  check(new Set(closureIds).size === closureIds.length, `${row.id} proofIds must not contain duplicates`);
  const rowEvidence = closureEvidenceByRow.get(row.id);
  let hasCompositionProof = false;
  for (const id of closureIds) {
    const proof = rowEvidence?.get(id);
    check(proof !== undefined, `${row.id} proofId does not resolve to row-local evidence: ${String(id)}`);
    if (!proof) continue;
    const isDispositionProof = (row.dispositionEvidenceRefs ?? []).some((ref) => ref.id === id);
    if (row.migrationStatus === "excluded") {
      check(isDispositionProof,
        `${row.id}/${id} excluded proofId must resolve to explicit disposition evidence`);
    } else if (row.migrationStatus === "relocated" && isDispositionProof) {
      // Canonical-plan references explain the relocation; product proof remains separately required below.
    } else {
      check(proof.result === "passed", `${row.id}/${id} must identify evidence explicitly marked result passed`);
      if (proof.evidenceKind === "composition") hasCompositionProof = true;
    }
  }
  if (row.migrationStatus === "verified" || row.migrationStatus === "relocated") {
    check(hasCompositionProof, `${row.id} requires at least one passed row-local composition proof`);
  }
  if (row.migrationStatus === "relocated") {
    check(closureIds.some((id) => (row.dispositionEvidenceRefs ?? []).some((ref) => ref.id === id
      && ref.path === "docs/migration/FULL-MIGRATION-PLAN.md")),
    `${row.id} relocation proofIds must include its canonical plan disposition evidence`);
  }
  for (const slice of row.targetImplementationSlices ?? []) {
    for (const finding of slice.acceptanceFindings ?? []) {
      if (finding.result !== "resolved") continue;
      const resolutionIds = finding.resolutionProofIds ?? [];
      check(new Set(resolutionIds).size === resolutionIds.length, `${finding.id} resolutionProofIds must not contain duplicates`);
      for (const id of resolutionIds) {
        const proof = rowEvidence?.get(id);
        check(proof !== undefined, `${finding.id} resolution proof does not resolve to row-local evidence: ${String(id)}`);
        if (proof) {
          check(proof.result === "passed", `${finding.id}/${id} resolution proof must be marked passed`);
        }
      }
    }
  }
}

if (failures.length) {
  for (const failure of failures) console.error(`FAIL ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`Verified ${ledger.routeRegistrationCount} registrations, ${endpointCount} handlers, ${ledger.nonRouterGroupCount} non-router groups, ${sourceFiles.size} pinned source files, ${sliceCount} implementation slices and ${evidenceRefIds.size} unique evidence references.`);
}
