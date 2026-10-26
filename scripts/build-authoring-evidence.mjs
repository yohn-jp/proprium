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
function parseFeatureRows(document) {
  const rows = new Map();
  for (const line of document.split("\n")) {
    if (!line.startsWith("|")) continue;
    const cells = line.split("|");
    const firstCell = cells[1] ?? "";
    if (!/<a id="feature-[^"]+"><\/a>/u.test(firstCell)) continue;
    const match = /^\s*([A-Z]+-\d{2,3})\b/u.exec(firstCell);
    if (!match) throw new Error(`Cannot derive a canonical feature ID from ${line}`);
    const feature = match[1];
    const anchors = acceptanceReferences(cells.at(-2) ?? "");
    rows.set(feature, { author_visible_result: (cells[2] ?? "").trim(), acceptance: anchors,
      source_disposition: (cells[3] ?? "").trim() });
  }
  return rows;
}
function caseCode(id) {
  const match = /^accept-(nar|kno|res|pw|dia|spk|sem|pub)-([a-z]*)(\d+)$/u.exec(id);
  if (!match) throw new Error(`Cannot derive a canonical acceptance ID from ${id}`);
  const prefixes = { nar: "NAR-A", kno: "KNO-A", res: "RES-A", pw: "PW-", dia: "DIA-A", spk: "SPK-A", sem: "SEM-A", pub: "PUB-AC" };
  return `${prefixes[match[1]]}${match[3].padStart(match[1] === "res" ? 3 : match[1] === "pw" || match[1] === "pub" ? 2 : 1, "0")}`;
}
function parseAcceptanceCases(document, acceptanceIds) {
  const section = /^#{2,3}\s+(?:\d+\.\s+)?(?:Feature\s+)?Acceptance\b[^\r\n]*$/imu.exec(document);
  if (!section) throw new Error("Plugin Canon is missing its Acceptance section");
  const sectionOffset = section.index + section[0].length;
  const sectionText = document.slice(sectionOffset);
  const lines = sectionText.split("\n");
  const cases = new Map();
  for (const id of acceptanceIds) {
    const code = caseCode(id);
    const codePattern = new RegExp(`(?<![A-Z0-9])${code}(?![A-Z0-9])`, "u");
    const directAnchorOffset = sectionText.indexOf(`<a id="${id}"></a>`);
    const directAnchorLine = directAnchorOffset < 0 ? -1 : sectionText.slice(0, directAnchorOffset).split("\n").length - 1;
    const lineIndex = directAnchorLine >= 0
      ? lines.findIndex((line, index) => index >= directAnchorLine && codePattern.test(line))
      : lines.findIndex(line => codePattern.test(line));
    if (lineIndex < 0) throw new Error(`${id} has no canonical acceptance case ${code}`);
    const line = lines[lineIndex].trim();
    let title = null;
    let requirement = "";
    if (line.startsWith("|")) {
      const cells = line.split("|").slice(1, -1).map(cell => cell.trim());
      const titleCell = cells[0] ?? "";
      title = /—\s*([^|]+)$/u.exec(titleCell)?.[1].trim() ?? null;
      requirement = cells.slice(1).join(" | ").trim();
    } else {
      const headingTitle = new RegExp(`(?:###\\s*(?:<a id="[^"]+"><\\/a>)?|\\*\\*)${code}\\s+—\\s*([^*\\r\\n]+?)(?:\\*\\*)?(?:\\s*:.*)?$`, "u").exec(line);
      title = headingTitle?.[1].trim() ?? null;
      const nextCase = lines.findIndex((candidate, index) => index > lineIndex &&
        (/^###\s+/u.test(candidate) || /<a id="accept-[a-z0-9-]+"><\/a>/u.test(candidate)));
      const end = nextCase < 0 ? lines.length : nextCase;
      requirement = lines.slice(lineIndex + 1, end).join("\n").trim();
      if (line.includes(`**${code}`)) requirement = line.replace(/^.*?\*\*[^*]+\*\*:?\s*/u, "").trim();
    }
    requirement = requirement.replace(/\s+/gu, " ").trim();
    if (!requirement) throw new Error(`${id} has no canonical acceptance requirement`);

    const lineOffset = lines.slice(0, lineIndex).reduce((length, value) => length + value.length + 1, 0);
    const anchorsInLine = [...lines[lineIndex].matchAll(/<a id="([^"]+)"><\/a>/gu)].map(anchor => anchor[1]);
    const directAnchor = anchorsInLine.find(anchor => anchor.startsWith("accept-"));
    let reference = sectionText.includes(`<a id="${id}"></a>`) ? id : directAnchor;
    if (!reference) {
      const preceding = [...sectionText.slice(0, lineOffset).matchAll(/<a id="([^"]+)"><\/a>/gu)];
      reference = preceding.at(-1)?.[1] ?? id;
    }
    cases.set(id, { canon_title: title, canon_reference: `#${reference}`, canon_requirement: requirement });
  }
  return cases;
}
function parseRMatrix(document) {
  const rows = new Map();
  let matrixStarted = false;
  for (const line of document.split("\n")) {
    if (line.includes("Executable end-to-end job") && line.includes("Required proof")) { matrixStarted = true; continue; }
    if (!matrixStarted) continue;
    const match = /^\|\s*(R\d{2})\s*\|([^|]+)\|([^|]+)\|/u.exec(line);
    if (match) rows.set(match[1], { canon_title: match[2].trim(), required_proof: match[3].trim() });
    else if (rows.size) break;
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
  return [...new Set([...document.matchAll(/\b([a-f0-9]{40})\b/gu)].map(match => match[1]))].sort();
}
function sourceStatusRecord(source, feature_ids, pinSource) {
  const pinned = pinSource(source.source);
  if (!pinned) throw new Error(`Traceability source path is not pinned to a commit: ${source.source}`);
  return { source_id: source.id, source_path: source.source, source_repo: pinned.repo,
    source_revision: pinned.revision, source_revisions: [pinned.revision], feature_ids, ...statusRecord() };
}
function immutableAnchors(actionIds, uiIds, traceability, pinSource) {
  const rows = [];
  for (const [kind, ids, sources] of [
    ["source_action", actionIds, traceability.source_actions],
    ["source_ui_contribution", uiIds, traceability.source_ui_contributions],
  ]) for (const id of ids) {
    const source = sources.find(item => item.id === id);
    if (!source) throw new Error(`Missing traceability ${kind} ${id}`);
    const pinned = pinSource(source.source);
    if (!pinned) throw new Error(`${kind} ${id} points to an unpinned source path ${source.source}`);
    rows.push({ kind, id, source_path: source.source, source_repo: pinned.repo, source_revision: pinned.revision });
  }
  return rows.sort((left, right) => `${left.kind}:${left.id}`.localeCompare(`${right.kind}:${right.id}`));
}
function uniqueRevisions(anchors) { return [...new Set(anchors.map(anchor => anchor.source_revision))].sort(); }
function sameJson(left, right) { return JSON.stringify(left) === JSON.stringify(right); }
function sourceFileRecord(source) {
  return { repo: source.repo, source_path: source.path, source_revision: source.revision,
    source_revisions: [source.revision], ...statusRecord() };
}
async function requirements() {
  const acceptanceDocument = await readFile(resolve(root, "docs/canon/ACCEPTANCE.md"), "utf8");
  const traceability = JSON.parse(await readFile(traceabilityPath, "utf8"));
  const sourceByPath = new Map(traceability.sources.map(source => [source.path, source]));
  if (sourceByPath.size !== traceability.sources.length) throw new Error("Traceability repeats a source path with ambiguous immutable revisions");
  const sourceRepoRevisions = new Map();
  for (const source of traceability.sources) {
    const revisions = sourceRepoRevisions.get(source.repo) ?? new Set();
    revisions.add(source.revision);
    sourceRepoRevisions.set(source.repo, revisions);
  }
  const pinSource = sourcePath => {
    const exact = sourceByPath.get(sourcePath);
    if (exact) return exact;
    if (sourceRepoRevisions.size !== 1) throw new Error(`Traceability must pin ${sourcePath} to an explicit repository and revision`);
    const [[repo, revisions]] = sourceRepoRevisions;
    if (revisions.size !== 1) throw new Error(`Source repository ${repo} has ambiguous revisions for ${sourcePath}`);
    return { repo, revision: [...revisions][0], path: sourcePath };
  };
  const allSourcePaths = new Map();
  for (const source of [
    ...traceability.sources.map(item => ({ source: item.path })), ...traceability.source_actions,
    ...traceability.source_ui_contributions, ...traceability.source_tools,
  ]) {
    const pinned = pinSource(source.source);
    allSourcePaths.set(`${pinned.repo}:${source.source}`, { repo: pinned.repo, path: source.source, revision: pinned.revision });
  }
  const sourceFiles = [...allSourcePaths.values()].sort((left, right) => `${left.repo}:${left.path}`.localeCompare(`${right.repo}:${right.path}`));
  const inventoryDocument = await readFile(resolve(root, "docs/canon/RECOVERY-INVENTORY.md"), "utf8");
  const acceptanceMatrix = parseRMatrix(acceptanceDocument);
  if (rIds.some(id => !acceptanceMatrix.has(id)) || acceptanceMatrix.size !== rIds.length) {
    throw new Error("docs/canon/ACCEPTANCE.md does not contain exactly the R01–R14 matrix");
  }
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
    const canonSourceRevisions = parseSourceRevisions(document);
    const acceptanceCasesById = parseAcceptanceCases(document, parseAcceptanceIds(document));
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
      const anchors = immutableAnchors(sourceActions, sourceUi, traceability, pinSource);
      return { feature_id: id, source_anchor_state: anchors.length ? "TRACEABILITY_MAPPED" : "UNMAPPED",
        author_visible_result: row.author_visible_result, source_disposition: row.source_disposition,
        canon_source_revisions: canonSourceRevisions, acceptance_anchors: row.acceptance,
        source_actions: sourceActions, source_ui_contributions: sourceUi, source_anchors: anchors,
        source_revisions: uniqueRevisions(anchors), ...statusRecord() };
    });
    const acceptanceCases = parseAcceptanceIds(document).map(id => {
      const linkedFeatures = featureRecords.filter(feature => feature.acceptance_anchors.includes(id));
      const anchors = [...new Map(linkedFeatures.flatMap(feature => feature.source_anchors)
        .map(anchor => [`${anchor.kind}:${anchor.id}`, anchor])).values()]
        .sort((left, right) => `${left.kind}:${left.id}`.localeCompare(`${right.kind}:${right.id}`));
      const canonicalCase = acceptanceCasesById.get(id);
      if (!canonicalCase) throw new Error(`${pluginId}: no canonical acceptance case ${id}`);
      return { id, ...canonicalCase, feature_ids: linkedFeatures.map(feature => feature.feature_id).sort(),
        canon_source_revisions: canonSourceRevisions, source_anchors: anchors,
        source_revisions: uniqueRevisions(anchors), ...statusRecord() };
    });
    records.push({ plugin_id: pluginId, canon: path, feature_count: featureRecords.length,
      acceptance_anchors: parseAcceptanceIds(document), canon_source_revisions: canonSourceRevisions,
      acceptance_cases: acceptanceCases,
      features: featureRecords });
  }
  const allFeatureIds = records.flatMap(record => record.features.map(feature => feature.feature_id)).sort();
  if (inventoryFeatureIds.length !== allFeatureIds.length ||
      [...inventoryFeatureIds].sort().some((featureId, index) => featureId !== allFeatureIds[index])) {
    throw new Error("RECOVERY-INVENTORY feature index differs from the eight plugin specifications");
  }
  const featureOwner = new Map(records.flatMap(record => record.features.map(feature => [feature.feature_id, record.plugin_id])));
  const sourceActions = traceability.source_actions.map(source =>
    sourceStatusRecord(source, [...new Set((source.targets ?? []).map(target => target.feature_id).filter(Boolean))], pinSource));
  const sourceUi = traceability.source_ui_contributions.map(source => sourceStatusRecord(source, source.feature_id ? [source.feature_id] : [], pinSource));
  const sourceTools = traceability.source_tools.map(source => ({ source_id: source.id, source_path: source.source,
    source_repo: pinSource(source.source).repo, source_revision: pinSource(source.source).revision,
    source_revisions: [pinSource(source.source).revision],
    owner: source.owner, via: source.via, ...statusRecord() }));
  return { schema: "proprium.authoring.evidence/v1", release_sha: null, registry_digest: null,
    generated_from: { acceptance: "docs/canon/ACCEPTANCE.md", inventory: "docs/canon/RECOVERY-INVENTORY.md",
      traceability: "docs/canon/traceability.json", plugins: records.map(item => item.canon) },
    matrix: rIds.map(id => ({ id, ...acceptanceMatrix.get(id), ...statusRecord() })),
    plugins: records, recovered_source: { action_count: sourceActions.length, ui_count: sourceUi.length, tool_count: sourceTools.length,
      source_file_count: sourceFiles.length, source_files: sourceFiles.map(sourceFileRecord),
      source_actions: sourceActions, ui_contributions: sourceUi, source_tools: sourceTools,
      source_revisions: [...new Set(traceability.sources.map(source => source.revision))].sort() },
  };
}
function nonempty(value) { return typeof value === "string" && value.trim().length > 0; }
function validateOne(item, label, errors, { allowEmptySourceRevisions = false, requireArtifact = false } = {}) {
  if (!evidenceStatuses.includes(item.status)) errors.push(`${label}: invalid status`);
  if (item.status === "PASS") {
    for (const key of ["fixture", "command", "git_sha", "browser_platform", "input", "output", "receipt", "evidence_ref"]) {
      if (!nonempty(item[key])) errors.push(`${label}: PASS requires ${key}`);
    }
    if (!Array.isArray(item.source_revisions) || (!allowEmptySourceRevisions && !item.source_revisions.length) ||
        item.source_revisions.some(revision => !/^[a-f0-9]{40}$/u.test(revision))) {
      errors.push(`${label}: PASS requires the exact immutable source revisions it exercises`);
    }
    if (!/^[a-f0-9]{40}$/u.test(item.git_sha ?? "")) errors.push(`${label}: PASS requires an immutable full git SHA`);
    if (!/^https:\/\//u.test(item.evidence_ref ?? "")) errors.push(`${label}: PASS requires an archived CI/evidence URL`);
    if (item.artifact !== null && (!/^[a-f0-9]{64}$/u.test(item.artifact.registry_digest ?? "") ||
        !/^[a-f0-9]{64}$/u.test(item.artifact.plugin_digest ?? ""))) errors.push(`${label}: artifact digests must be SHA-256`);
    if (requireArtifact && (!item.artifact || !/^[a-f0-9]{64}$/u.test(item.artifact.registry_digest ?? "") ||
        !/^[a-f0-9]{64}$/u.test(item.artifact.plugin_digest ?? ""))) errors.push(`${label}: PASS requires actual signed registry and plugin digests`);
  }
  if (item.status === "BLOCKED" && !nonempty(item.blocker)) errors.push(`${label}: BLOCKED requires a concrete blocker`);
  if (item.status !== "BLOCKED" && item.blocker !== null) errors.push(`${label}: blocker is only valid for BLOCKED`);
}
function sourceGroupsFor(ledger, group) { return ledger.recovered_source?.[group] ?? []; }
function audit(actual, required, errors) {
  if (actual.schema !== required.schema) errors.push("wrong evidence schema");
  const r = new Map((actual.matrix ?? []).map(item => [item.id, item]));
  if (r.size !== required.matrix.length || required.matrix.some(item => !r.has(item.id))) errors.push("R01–R14 matrix differs from canonical acceptance IDs");
  for (const expected of required.matrix) {
    const item = r.get(expected.id);
    if (item && (item.canon_title !== expected.canon_title || item.required_proof !== expected.required_proof)) {
      errors.push(`${expected.id}: executable job or required proof differs from ACCEPTANCE.md`);
    }
  }
  for (const item of actual.matrix ?? []) validateOne(item, item.id, errors, { requireArtifact: ["R02", "R13"].includes(item.id) });
  const actualPlugins = new Map((actual.plugins ?? []).map(item => [item.plugin_id, item]));
  if (actualPlugins.size !== required.plugins.length) errors.push("eight-plugin ledger is incomplete or duplicated");
  for (const plugin of required.plugins) {
    const ledger = actualPlugins.get(plugin.plugin_id);
    if (!ledger) { errors.push(`${plugin.plugin_id}: missing`); continue; }
    if (ledger.canon !== plugin.canon || !sameJson(ledger.canon_source_revisions ?? [], plugin.canon_source_revisions)) {
      errors.push(`${plugin.plugin_id}: canon path or pinned canon source revisions differ`);
    }
    if (!sameJson([...(ledger.acceptance_anchors ?? [])].sort(), [...plugin.acceptance_anchors].sort())) {
      errors.push(`${plugin.plugin_id}: acceptance anchors differ from its Canon`);
    }
    const features = new Map((ledger.features ?? []).map(item => [item.feature_id, item]));
    if (features.size !== plugin.features.length) errors.push(`${plugin.plugin_id}: feature ledger differs from canon`);
    for (const feature of plugin.features) {
      const record = features.get(feature.feature_id);
      if (!record) { errors.push(`${plugin.plugin_id}/${feature.feature_id}: missing`); continue; }
      if (JSON.stringify([...(record.acceptance_anchors ?? [])].sort()) !== JSON.stringify([...feature.acceptance_anchors].sort())) {
        errors.push(`${plugin.plugin_id}/${feature.feature_id}: acceptance links differ from canon`);
      }
      if (record.source_disposition !== feature.source_disposition ||
          record.author_visible_result !== feature.author_visible_result ||
          record.source_anchor_state !== (feature.source_anchors.length ? "TRACEABILITY_MAPPED" : "UNMAPPED") ||
          !sameJson(record.canon_source_revisions ?? [], plugin.canon_source_revisions) ||
          !sameJson(record.source_actions ?? [], feature.source_actions) ||
          !sameJson(record.source_ui_contributions ?? [], feature.source_ui_contributions)) {
        errors.push(`${plugin.plugin_id}/${feature.feature_id}: source disposition or parity IDs differ from canon`);
      }
      if (!sameJson(record.source_anchors ?? [], feature.source_anchors)) errors.push(`${plugin.plugin_id}/${feature.feature_id}: immutable source anchors differ from traceability`);
      if (!sameJson(record.source_revisions ?? [], feature.source_revisions)) errors.push(`${plugin.plugin_id}/${feature.feature_id}: source revisions differ from its immutable anchors`);
      validateOne(record, `${plugin.plugin_id}/${feature.feature_id}`, errors, {
        allowEmptySourceRevisions: feature.source_anchors.length === 0, requireArtifact: true,
      });
      if (record.status === "PASS") for (const anchor of feature.acceptance_anchors) {
        const accepted = (ledger.acceptance_cases ?? []).find(item => item.id === anchor);
        if (!accepted || accepted.status !== "PASS" || accepted.git_sha !== record.git_sha || accepted.evidence_ref !== record.evidence_ref) {
          errors.push(`${plugin.plugin_id}/${feature.feature_id}: linked acceptance ${anchor} has not passed on the same SHA and archived run`);
        }
      }
      if (record.status === "PASS") for (const anchor of feature.source_anchors) {
        const group = anchor.kind === "source_action" ? "source_actions" : "ui_contributions";
        const recovered = sourceGroupsFor(actual, group).find(item => item.source_id === anchor.id);
        if (!recovered || recovered.status !== "PASS" || recovered.git_sha !== record.git_sha || recovered.evidence_ref !== record.evidence_ref) {
          errors.push(`${plugin.plugin_id}/${feature.feature_id}: source parity ${anchor.kind}/${anchor.id} has not passed on the same SHA and archived run`);
        }
      }
    }
    const acceptance = new Set(plugin.acceptance_anchors);
    const acceptedRows = new Map((ledger.acceptance_cases ?? []).map(item => [item.id, item]));
    if (acceptedRows.size !== acceptance.size) errors.push(`${plugin.plugin_id}: acceptance evidence rows differ from its Canon`);
    for (const id of acceptance) {
      if (!(ledger.acceptance_anchors ?? []).includes(id)) errors.push(`${plugin.plugin_id}: acceptance ${id} missing`);
      const row = acceptedRows.get(id);
      if (!row) errors.push(`${plugin.plugin_id}: acceptance ${id} evidence row missing`);
      else {
        const expected = plugin.acceptance_cases.find(item => item.id === id);
        if (!expected || row.canon_title !== expected.canon_title || row.canon_reference !== expected.canon_reference ||
            row.canon_requirement !== expected.canon_requirement ||
            !sameJson(row.feature_ids, expected.feature_ids) ||
            !sameJson(row.source_anchors, expected.source_anchors) ||
            !sameJson(row.source_revisions, expected.source_revisions) || !sameJson(row.canon_source_revisions, expected.canon_source_revisions)) {
          errors.push(`${plugin.plugin_id}/${id}: feature and immutable source mapping differs from Canon`);
        }
        validateOne(row, `${plugin.plugin_id}/${id}`, errors, {
          allowEmptySourceRevisions: Boolean(expected && expected.source_anchors.length === 0), requireArtifact: true,
        });
        if (row.status === "PASS") for (const anchor of expected?.source_anchors ?? []) {
          const group = anchor.kind === "source_action" ? "source_actions" : "ui_contributions";
          const recovered = sourceGroupsFor(actual, group).find(item => item.source_id === anchor.id);
          if (!recovered || recovered.status !== "PASS" || recovered.git_sha !== row.git_sha || recovered.evidence_ref !== row.evidence_ref) {
            errors.push(`${plugin.plugin_id}/${id}: source parity ${anchor.kind}/${anchor.id} has not passed on the same SHA and archived run`);
          }
        }
      }
    }
  }
  const sourceGroups = actual.recovered_source;
  if (!sourceGroups || sourceGroups.action_count !== required.recovered_source.action_count ||
      sourceGroups.ui_count !== required.recovered_source.ui_count || sourceGroups.tool_count !== required.recovered_source.tool_count ||
      sourceGroups.source_file_count !== required.recovered_source.source_file_count) {
    errors.push("Scriptorium action/UI and legacy MCP tool parity ledger is incomplete");
  }
  const sourceFiles = new Map((sourceGroups?.source_files ?? []).map(item => [`${item.repo}:${item.source_path}`, item]));
  if (sourceFiles.size !== required.recovered_source.source_file_count) errors.push("immutable source file ledger differs from traceability.json");
  for (const source of required.recovered_source.source_files) {
    const item = sourceFiles.get(`${source.repo}:${source.source_path}`);
    if (!item || item.source_revision !== source.source_revision) errors.push(`immutable source ${source.repo}:${source.source_path} revision differs from traceability.json`);
    else validateOne(item, `source_files/${source.repo}:${source.source_path}`, errors);
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
  const actualActions = new Map((sourceGroups?.source_actions ?? []).map(item => [item.source_id, item]));
  for (const source of required.recovered_source.source_actions) {
    const recorded = actualActions.get(source.source_id);
    if (JSON.stringify([...(actualActionFeatures.get(source.source_id) ?? [])].sort()) !== JSON.stringify([...source.feature_ids].sort()) ||
        recorded?.source_path !== source.source_path || recorded?.source_repo !== source.source_repo || recorded?.source_revision !== source.source_revision ||
        !sameJson(recorded?.source_revisions ?? [], source.source_revisions)) {
      errors.push(`source action ${source.source_id}: owning feature differs from traceability.json`);
    }
  }
  const actualUiFeatures = new Map((sourceGroups?.ui_contributions ?? []).map(item => [item.source_id, item.feature_ids]));
  const actualUi = new Map((sourceGroups?.ui_contributions ?? []).map(item => [item.source_id, item]));
  for (const source of required.recovered_source.ui_contributions) {
    const recorded = actualUi.get(source.source_id);
    if (JSON.stringify([...(actualUiFeatures.get(source.source_id) ?? [])].sort()) !== JSON.stringify([...source.feature_ids].sort()) ||
        recorded?.source_path !== source.source_path || recorded?.source_repo !== source.source_repo || recorded?.source_revision !== source.source_revision ||
        !sameJson(recorded?.source_revisions ?? [], source.source_revisions)) {
      errors.push(`UI contribution ${source.source_id}: owning feature differs from traceability.json`);
    }
  }
  const actualTools = new Map((sourceGroups?.source_tools ?? []).map(item => [item.source_id, item]));
  for (const source of required.recovered_source.source_tools) {
    const recorded = actualTools.get(source.source_id);
    const pinned = required.recovered_source.source_files.find(item => item.source_path === source.source_path);
    if (!recorded || recorded.owner !== source.owner || recorded.via !== source.via || recorded.source_path !== source.source_path ||
        recorded.source_repo !== pinned?.repo || recorded.source_revision !== pinned?.source_revision ||
        !sameJson(recorded.source_revisions ?? [], [pinned?.source_revision])) {
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
