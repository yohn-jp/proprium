import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const traceabilityPath = resolve(root, "docs/canon/traceability.json");
const outputPath = resolve(root, "evidence/authoring/implementation.json");
const plugins = [
  ["proprium.narrative", "NARRATIVE.md"], ["proprium.knowledge", "KNOWLEDGE.md"],
  ["proprium.research", "RESEARCH.md"], ["proprium.paired-writing", "PAIRED-WRITING.md"],
  ["proprium.diagnostics", "DIAGNOSTICS.md"], ["proprium.speaker", "SPEAKER.md"],
  ["proprium.semantic", "SEMANTIC.md"], ["proprium.publishing", "PUBLISHING.md"],
];
const rIds = Array.from({ length: 14 }, (_, index) => `R${String(index + 1).padStart(2, "0")}`);
const evidenceStatuses = ["PASS", "FAIL", "BLOCKED", "NOT_CHECKED"];

function statusRecord() {
  return { status: "NOT_CHECKED", fixture: null, command: null, git_sha: null, browser_platform: null,
    input: null, output: null, receipt: null, artifact: null, evidence_ref: null, blocker: null };
}
function sourceStatusRecord(source, feature_ids) {
  return { source_id: source.id, source_path: source.source, feature_ids, ...statusRecord() };
}
function parseFeatureRows(document) {
  const rows = new Map();
  for (const line of document.split("\n")) {
    if (!line.startsWith("|")) continue;
    const firstCell = line.split("|")[1] ?? "";
    if (!/<a id="feature-[^"]+"><\/a>/u.test(firstCell)) continue;
    const match = /^\s*([A-Z]+-\d{2,3})\b/u.exec(firstCell);
    if (!match) throw new Error(`Cannot derive a canonical feature ID from ${line}`);
    const feature = match[1];
    const anchors = acceptanceReferences(line.split("|").at(-2) ?? "");
    rows.set(feature, { acceptance: anchors });
  }
  return rows;
}
function acceptanceReferences(text) {
  const anchors = [...text.matchAll(/#(accept-[a-z0-9-]+)/gu)].map(item => item[1]);
  const ids = text.match(/\b(?:NAR-A\d{2}|KNO-A\d{2}|RES-A\d{3}|PW-\d{2}|DIA-A\d{1,2}|SPK-A\d{2}|SEM-A\d{1,2}|PUB-AC\d{2})\b/gu) ?? [];
  for (const id of ids) anchors.push(`accept-${id.toLowerCase()}`);
  return [...new Set(anchors)].sort();
}
function parseAcceptanceIds(document) {
  const ids = [...document.matchAll(/<a id="(accept-[a-z0-9-]+)"><\/a>/gu)].map(match => match[1]);
  return [...new Set(ids)].sort();
}
function parseSourceRevisions(document) {
  return [...new Set([...document.matchAll(/source@([a-f0-9]{40})/gu)].map(match => match[1]))].sort();
}
async function requirements() {
  const traceability = JSON.parse(await readFile(traceabilityPath, "utf8"));
  const inventoryDocument = await readFile(resolve(root, "docs/canon/RECOVERY-INVENTORY.md"), "utf8");
  const inventoryStart = inventoryDocument.indexOf("## Complete feature index");
  const inventoryEnd = inventoryDocument.indexOf("## Exact Scriptorium Action crosswalk", inventoryStart);
  if (inventoryStart < 0 || inventoryEnd < 0) throw new Error("Recovery inventory feature section cannot be found");
  const inventoryFeatureIds = [...inventoryDocument.slice(inventoryStart, inventoryEnd).matchAll(/^\|\s*\[([A-Z]+-\d{2,3})\]/gmu)].map(item => item[1]);
  const inventoryAcceptance = new Map();
  for (const line of inventoryDocument.slice(inventoryStart, inventoryEnd).split("\n")) {
    const match = /^\|\s*\[([A-Z]+-\d{2,3})\][^|]*\|([^|]*)\|/u.exec(line);
    if (match) inventoryAcceptance.set(match[1], acceptanceReferences(match[2]));
  }
  const records = [];
  for (const [pluginId, file] of plugins) {
    const path = `docs/canon/plugins/${file}`;
    const document = await readFile(resolve(root, path), "utf8");
    const features = parseFeatureRows(document);
    for (const [featureId, feature] of features) {
      const expected = inventoryAcceptance.get(featureId) ?? [];
      if (JSON.stringify([...feature.acceptance].sort()) !== JSON.stringify(expected)) {
        throw new Error(`${featureId}: plugin spec acceptance references differ from RECOVERY-INVENTORY`);
      }
    }
    const featureRecords = [...features].map(([id, row]) => {
      const sourceActions = traceability.source_actions.filter(action => action.targets?.some(target =>
        target.plugin_id === pluginId && target.feature_id === id)).map(action => action.id);
      const sourceUi = traceability.source_ui_contributions.filter(contribution =>
        contribution.owner === pluginId && contribution.feature_id === id).map(contribution => contribution.id);
      return { feature_id: id, acceptance_anchors: row.acceptance, source_actions: sourceActions,
        source_ui_contributions: sourceUi, source_revisions: parseSourceRevisions(document), ...statusRecord() };
    });
    records.push({ plugin_id: pluginId, canon: path, feature_count: featureRecords.length,
      acceptance_anchors: parseAcceptanceIds(document), source_revisions: parseSourceRevisions(document),
      features: featureRecords });
  }
  const allFeatureIds = records.flatMap(record => record.features.map(feature => feature.feature_id)).sort();
  if (inventoryFeatureIds.length !== allFeatureIds.length ||
      [...inventoryFeatureIds].sort().some((featureId, index) => featureId !== allFeatureIds[index])) {
    throw new Error("RECOVERY-INVENTORY feature index differs from the eight plugin specifications");
  }
  const featureOwner = new Map(records.flatMap(record => record.features.map(feature => [feature.feature_id, record.plugin_id])));
  const sourceActions = traceability.source_actions.map(source =>
    sourceStatusRecord(source, [...new Set((source.targets ?? []).map(target => target.feature_id).filter(Boolean))]));
  const sourceUi = traceability.source_ui_contributions.map(source => sourceStatusRecord(source, source.feature_id ? [source.feature_id] : []));
  const sourceTools = traceability.source_tools.map(source => ({ source_id: source.id, source_path: source.source,
    owner: source.owner, via: source.via, ...statusRecord() }));
  return { schema: "proprium.authoring.evidence/v1", release_sha: null, registry_digest: null,
    generated_from: { acceptance: "docs/canon/ACCEPTANCE.md", inventory: "docs/canon/RECOVERY-INVENTORY.md",
      traceability: "docs/canon/traceability.json", plugins: records.map(item => item.canon) },
    matrix: rIds.map(id => ({ id, ...statusRecord() })),
    plugins: records, recovered_source: { action_count: sourceActions.length, ui_count: sourceUi.length, tool_count: sourceTools.length,
      source_actions: sourceActions, ui_contributions: sourceUi, source_tools: sourceTools,
      source_revisions: [...new Set(traceability.sources.map(source => source.revision))].sort() },
  };
}
function nonempty(value) { return typeof value === "string" && value.trim().length > 0; }
function validateOne(item, label, errors) {
  if (!evidenceStatuses.includes(item.status)) errors.push(`${label}: invalid status`);
  if (item.status === "PASS") {
    for (const key of ["fixture", "command", "git_sha", "browser_platform", "input", "output", "receipt", "evidence_ref"]) {
      if (!nonempty(item[key])) errors.push(`${label}: PASS requires ${key}`);
    }
    if (!item.source_revisions?.length || item.source_revisions.some(revision => !/^[a-f0-9]{40}$/u.test(revision))) {
      errors.push(`${label}: PASS requires the exact immutable source revisions it exercises`);
    }
    if (!/^[a-f0-9]{40}$/u.test(item.git_sha ?? "")) errors.push(`${label}: PASS requires an immutable full git SHA`);
    if (!/^https:\/\//u.test(item.evidence_ref ?? "")) errors.push(`${label}: PASS requires an archived CI/evidence URL`);
    if (item.artifact !== null && (!/^[a-f0-9]{64}$/u.test(item.artifact.registry_digest ?? "") ||
        !/^[a-f0-9]{64}$/u.test(item.artifact.plugin_digest ?? ""))) errors.push(`${label}: artifact digests must be SHA-256`);
  }
  if (item.status === "BLOCKED" && !nonempty(item.blocker)) errors.push(`${label}: BLOCKED requires a concrete blocker`);
  if (item.status !== "BLOCKED" && item.blocker !== null) errors.push(`${label}: blocker is only valid for BLOCKED`);
}
function audit(actual, required, errors) {
  if (actual.schema !== required.schema) errors.push("wrong evidence schema");
  const r = new Map((actual.matrix ?? []).map(item => [item.id, item]));
  if (r.size !== required.matrix.length || required.matrix.some(item => !r.has(item.id))) errors.push("R01–R14 matrix differs from canonical acceptance IDs");
  for (const item of actual.matrix ?? []) validateOne(item, item.id, errors);
  const actualPlugins = new Map((actual.plugins ?? []).map(item => [item.plugin_id, item]));
  if (actualPlugins.size !== required.plugins.length) errors.push("eight-plugin ledger is incomplete or duplicated");
  for (const plugin of required.plugins) {
    const ledger = actualPlugins.get(plugin.plugin_id);
    if (!ledger) { errors.push(`${plugin.plugin_id}: missing`); continue; }
    if (ledger.canon !== plugin.canon) errors.push(`${plugin.plugin_id}: canon path mismatch`);
    const features = new Map((ledger.features ?? []).map(item => [item.feature_id, item]));
    if (features.size !== plugin.features.length) errors.push(`${plugin.plugin_id}: feature ledger differs from canon`);
    for (const feature of plugin.features) {
      const record = features.get(feature.feature_id);
      if (!record) { errors.push(`${plugin.plugin_id}/${feature.feature_id}: missing`); continue; }
      if (JSON.stringify([...(record.acceptance_anchors ?? [])].sort()) !== JSON.stringify([...feature.acceptance_anchors].sort())) {
        errors.push(`${plugin.plugin_id}/${feature.feature_id}: acceptance links differ from canon`);
      }
      validateOne(record, `${plugin.plugin_id}/${feature.feature_id}`, errors);
      if (record.status === "PASS" && (!record.artifact || !/^[a-f0-9]{64}$/u.test(record.artifact.registry_digest ?? "") ||
          !/^[a-f0-9]{64}$/u.test(record.artifact.plugin_digest ?? ""))) {
        errors.push(`${plugin.plugin_id}/${feature.feature_id}: PASS requires the actual signed artifact and registry digests`);
      }
    }
    const acceptance = new Set(plugin.acceptance_anchors);
    for (const id of acceptance) {
      if (!(ledger.acceptance_anchors ?? []).includes(id)) errors.push(`${plugin.plugin_id}: acceptance ${id} missing`);
    }
  }
  const sourceGroups = actual.recovered_source;
  if (!sourceGroups || sourceGroups.action_count !== required.recovered_source.action_count ||
      sourceGroups.ui_count !== required.recovered_source.ui_count || sourceGroups.tool_count !== required.recovered_source.tool_count) {
    errors.push("Scriptorium action/UI and legacy MCP tool parity ledger is incomplete");
  }
  for (const [group, expectedCount] of [["source_actions", required.recovered_source.action_count],
    ["ui_contributions", required.recovered_source.ui_count], ["source_tools", required.recovered_source.tool_count]]) {
    const actualItems = sourceGroups?.[group] ?? [];
    if (actualItems.length !== expectedCount || new Set(actualItems.map(item => item.source_id)).size !== expectedCount) {
      errors.push(`${group}: source parity rows differ from traceability.json`);
    }
    for (const item of actualItems) validateOne(item, `${group}/${item.source_id}`, errors);
  }
  const actualActionFeatures = new Map((sourceGroups?.source_actions ?? []).map(item => [item.source_id, item.feature_ids]));
  for (const source of required.recovered_source.source_actions) {
    if (JSON.stringify([...(actualActionFeatures.get(source.source_id) ?? [])].sort()) !== JSON.stringify([...source.feature_ids].sort())) {
      errors.push(`source action ${source.source_id}: owning feature differs from traceability.json`);
    }
  }
  const actualUiFeatures = new Map((sourceGroups?.ui_contributions ?? []).map(item => [item.source_id, item.feature_ids]));
  for (const source of required.recovered_source.ui_contributions) {
    if (JSON.stringify([...(actualUiFeatures.get(source.source_id) ?? [])].sort()) !== JSON.stringify([...source.feature_ids].sort())) {
      errors.push(`UI contribution ${source.source_id}: owning feature differs from traceability.json`);
    }
  }
  const actualTools = new Map((sourceGroups?.source_tools ?? []).map(item => [item.source_id, item]));
  for (const source of required.recovered_source.source_tools) {
    const recorded = actualTools.get(source.source_id);
    if (!recorded || recorded.owner !== source.owner || recorded.via !== source.via || recorded.source_path !== source.source_path) {
      errors.push(`MCP tool ${source.source_id}: owner or typed Host route differs from traceability.json`);
    }
  }
  if (sourceGroups && JSON.stringify([...(sourceGroups.source_revisions ?? [])].sort()) !==
      JSON.stringify(required.recovered_source.source_revisions)) errors.push("Pinned source revisions differ from traceability.json");
  if (actual.release_sha !== null && !/^[a-f0-9]{40}$/u.test(actual.release_sha)) errors.push("release_sha must be a full git SHA or null");
  if (actual.release_sha && actual.plugins.some(plugin => plugin.features.some(feature => feature.status === "PASS" && feature.git_sha !== actual.release_sha))) {
    errors.push("feature evidence SHA differs from release SHA");
  }
  return errors;
}

const required = await requirements();
if (process.argv.includes("--check")) {
  const actual = JSON.parse(await readFile(outputPath, "utf8"));
  const errors = audit(actual, required, []);
  if (errors.length) { console.error(errors.join("\n")); process.exitCode = 1; }
  else console.log(`Authoring evidence shape valid: R01–R14, ${required.plugins.reduce((n, p) => n + p.features.length, 0)} features, ${required.plugins.reduce((n, p) => n + p.acceptance_anchors.length, 0)} plugin acceptance gates, ${required.recovered_source.action_count} source actions, ${required.recovered_source.ui_count} legacy UI registrations.`);
} else if (process.argv.includes("--validate")) {
  const actual = JSON.parse(await readFile(process.argv[process.argv.indexOf("--validate") + 1] ?? outputPath, "utf8"));
  const errors = audit(actual, required, []);
  if (errors.length) { console.error(errors.join("\n")); process.exitCode = 1; }
  else console.log("Evidence schema is complete; check individual statuses before reporting completion.");
} else {
  await mkdir(resolve(root, "evidence/authoring"), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(await requirements(), null, 2)}\n`, { flag: "wx" });
  console.log(`Wrote requirement-only ledger to ${outputPath}; all implementation results remain NOT_CHECKED.`);
}
