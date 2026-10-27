import { isMap, parseDocument, stringify } from "yaml";
import type { ActionRequest } from "../../../app/src/browser/proprium/authoring/types.js";
import type { GuestHost, HostCall } from "../../shared/guest.js";
import { invokeAction, readNarrativeScene, readText } from "./host.js";
import { sha256 } from "./sha256.js";
import { PairedError } from "./types.js";
import { exactKeys, identity, record } from "./validation.js";
import type { GenerateProvider } from "./state-events.js";

export type SummaryScope = "scene" | "chapter";
export type Summary = { summaryLines: string[]; characters?: string[]; stateChanges?: string[] };
export type SummarySource = { id: string; metadata_path: string; metadata_revision: string; manuscript_path: string;
  manuscript_revision: string; text: string; summary_path: string; summary_revision: string | null; existing: Record<string, unknown> | null; existing_text: string | null;
  known_characters: string[]; context_files: Array<{path:string; revision:string}>; knowledge_available: boolean };
export type SummaryPreparation = { scope: SummaryScope; targetId: string; expectedSnapshot: string; sources: SummarySource[];
  parent_path: string | null; parent_revision: string | null; parent_existing: Record<string, unknown> | null; parent_existing_text: string | null; chapter_metadata: { path: string; revision: string } | null; promptVersion: string };
const isObj = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const hashText = (value: string): string => sha256(new TextEncoder().encode(value));
const list = (value: unknown, label: string, max: number): string[] => {
  if (!Array.isArray(value) || value.length > max || value.some(item => typeof item !== "string" || item.length > 8192)) throw new PairedError("invalid_input", `${label} is invalid`);
  return value as string[];
};
export function parseSummaryOutput(raw: string, scope: SummaryScope): Summary {
  let value: unknown; try { value = JSON.parse(raw); } catch { throw new PairedError("invalid_input", "Summary output is not JSON"); }
  if (!isObj(value)) throw new PairedError("invalid_input", "Summary output is not an object");
  const summaryLines = list(value.summaryLines, "summaryLines", 3);
  if (summaryLines.length !== 3 || summaryLines.some(line => !line.trim())) throw new PairedError("invalid_input", "Summary requires three nonempty lines");
  return scope === "scene" ? { summaryLines, characters: list(value.characters, "characters", 100), stateChanges: list(value.stateChanges, "stateChanges", 100) } : { summaryLines };
}
export function chapterSummaryFingerprint(children: readonly { id: string; sourceHash: string }[]): string {
  return hashText(JSON.stringify(children.map(child => [child.id, child.sourceHash])));
}
export function isFreshSummary(value: unknown, sourceHash: string, promptVersion: string): boolean {
  return isObj(value) && value.sourceHash === sourceHash && value.promptVersion === promptVersion && typeof value.model === "string" && !!value.model &&
    Array.isArray(value.summaryLines) && value.summaryLines.length === 3 && value.summaryLines.every(line => typeof line === "string" && !!line.trim());
}
function summaryPath(metadataPath: string, id: string): string {
  if (!id || id.length > 256 || id === "." || id === ".." || /[\/\\\0]/u.test(id) || !/\/scenes\/[^/]+\.ya?ml$/iu.test(metadataPath)) throw new PairedError("invalid_path", "Scene summary path cannot be derived safely");
  return metadataPath.replace(/\/scenes\/[^/]+\.ya?ml$/iu, `/scene-summaries/${id}.yaml`);
}
function* optionalYaml(host: GuestHost, request: ActionRequest, path: string): Generator<HostCall, { revision: string | null; raw: Record<string, unknown> | null; text: string | null }, unknown> {
  try {
    const file = yield* readText(host, request, path); const doc = parseDocument(file.text, { uniqueKeys: true });
    const value = doc.toJS();
    if (doc.errors.length || !isObj(value)) throw new PairedError("unsupported_format", `Summary metadata is malformed: ${path}`);
    return { revision: file.revision, raw: value, text: file.text };
  } catch (error) { if ((error as { code?: string }).code === "file_not_found") return { revision: null, raw: null, text: null }; throw error; }
}
type TreeRow = { id: string; kind: string; metadata_path: string; metadata_revision: string };
function* rows(host: GuestHost, request: ActionRequest, parent_id: string | null): Generator<HostCall, TreeRow[], unknown> {
  let cursor: string | null = null, revision: string | undefined; const all: TreeRow[] = [], seen = new Set<string>();
  do {
    const page: { items: TreeRow[]; next_cursor: string | null; tree_revision: string } = yield* invokeAction<{ items: TreeRow[]; next_cursor: string | null; tree_revision: string }>(host, request,
      "proprium.narrative", "proprium.narrative.hierarchy.tree", { parent_id, limit: 200, ...(cursor ? { cursor } : {}), ...(revision ? { expected_tree_revision: revision } : {}) });
    if (!page || !Array.isArray(page.items) || !(page.next_cursor === null || typeof page.next_cursor === "string") || typeof page.tree_revision !== "string" || (revision && revision !== page.tree_revision)) throw new PairedError("snapshot_stale", "Narrative hierarchy page changed");
    revision = page.tree_revision; all.push(...page.items);
    if (page.next_cursor && seen.has(page.next_cursor)) throw new PairedError("snapshot_stale", "Hierarchy cursor did not advance");
    if (page.next_cursor) seen.add(page.next_cursor); cursor = page.next_cursor;
  } while (cursor);
  return all;
}
function* sourceForScene(host: GuestHost, request: ActionRequest, id: string): Generator<HostCall, SummarySource, unknown> {
  const scene = yield* readNarrativeScene(host, request, id); const manuscript = yield* readText(host, request, scene.manuscript_path);
  if (manuscript.revision !== scene.manuscript_revision) throw new PairedError("snapshot_stale", "Manuscript revision changed");
  const path = summaryPath(scene.metadata_path, id); const existing = yield* optionalYaml(host, request, path);
  const known_characters: string[] = [], context_files: Array<{path:string; revision:string}> = [];
  let knowledge_available = true;
  try {
    const references = yield* invokeAction<{ pov?: unknown; appears?: unknown[] }>(host, request, "proprium.knowledge", "knowledge.scene.references.get", { sceneId: id });
    if (!references || !Array.isArray(references.appears)) throw new PairedError("invalid_input", "Knowledge scene references are malformed");
    for (const item of [references.pov, ...references.appears]) {
      if (!isObj(item) || item.status !== "resolved" || item.type !== "character" || typeof item.name !== "string" || !item.name.trim()) continue;
      if (typeof item.path !== "string" || typeof item.revision !== "string" || !/^[a-f0-9]{64}$/u.test(item.revision)) throw new PairedError("snapshot_stale", "Character reference has no pinned revision");
      if (!known_characters.includes(item.name.trim())) known_characters.push(item.name.trim());
      const existingFile = context_files.find(file => file.path === item.path);
      if (existingFile && existingFile.revision !== item.revision) throw new PairedError("snapshot_stale", "Character references have conflicting revisions");
      if (!existingFile) context_files.push({ path: item.path, revision: item.revision });
    }
  } catch (error) {
    if ((error as { code?: string }).code !== "dependency_unavailable") throw error;
    knowledge_available = false;
  }
  return { id, metadata_path: scene.metadata_path, metadata_revision: scene.metadata_revision,
    manuscript_path: manuscript.path, manuscript_revision: manuscript.revision, text: manuscript.text,
    summary_path: path, summary_revision: existing.revision, existing: existing.raw, existing_text: existing.text,
    known_characters, context_files, knowledge_available };
}
/** Read only the selected scene or up to 30 children in Narrative order, never a manuscript sweep. */
export function* prepareSummary(input: unknown, host: GuestHost, request: ActionRequest): Generator<HostCall, SummaryPreparation, unknown> {
  const args = record(input, "input"); exactKeys(args, ["scope", "targetId", "expectedSnapshot"], "input");
  const targetId = identity(args.targetId, "targetId");
  if (args.expectedSnapshot !== request.snapshot.id) throw new PairedError("snapshot_stale", "Summary request snapshot changed");
  if (args.scope !== "scene" && args.scope !== "chapter") throw new PairedError("invalid_input", "Summary scope is invalid");
  if (args.scope === "scene") return { scope: "scene", targetId, expectedSnapshot: request.snapshot.id,
    sources: [yield* sourceForScene(host, request, targetId)], parent_path: null, parent_revision: null, parent_existing: null, parent_existing_text: null, chapter_metadata: null, promptVersion: "scene-summary@3" };
  let chapter: TreeRow | undefined;
  for (const volume of yield* rows(host, request, null)) {
    const found = (yield* rows(host, request, volume.id)).find(row => row.id === targetId && row.kind === "chapter");
    if (found) { if (chapter) throw new PairedError("ambiguous_identity", "Chapter identity is ambiguous"); chapter = found; }
  }
  if (!chapter) throw new PairedError("scene_not_found", "Chapter was not found");
  if (!/\/chapter\.ya?ml$/iu.test(chapter.metadata_path)) throw new PairedError("invalid_path", "Chapter metadata path is invalid");
  const childRows = yield* rows(host, request, targetId);
  if (!childRows.length) throw new PairedError("scene_not_found", "Chapter has no scenes");
  if (childRows.length > 30) throw new PairedError("capacity", "Chapter summaries are limited to 30 scenes");
  const sources: SummarySource[] = [];
  for (const row of childRows) { if (row.kind !== "scene") throw new PairedError("invalid_input", "Unexpected chapter child"); sources.push(yield* sourceForScene(host, request, row.id)); }
  const parent_path = chapter.metadata_path.replace(/\/chapter\.ya?ml$/iu, "/chapter-summary.yaml");
  const parent = yield* optionalYaml(host, request, parent_path);
  return { scope: "chapter", targetId, expectedSnapshot: request.snapshot.id, sources, parent_path,
    parent_revision: parent.revision, parent_existing: parent.raw, parent_existing_text: parent.text,
    chapter_metadata: { path: chapter.metadata_path, revision: chapter.metadata_revision }, promptVersion: "chapter-summary@2" };
}
function sceneSummaryCurrent(source: SummarySource): boolean {
  const expected = [{ path: source.metadata_path, revision: source.metadata_revision }, { path: source.manuscript_path, revision: source.manuscript_revision }];
  if (!isFreshSummary(source.existing, source.manuscript_revision, "scene-summary@3") || source.existing?.sceneId !== source.id ||
      JSON.stringify(source.existing?.source_files) !== JSON.stringify(expected) ||
      JSON.stringify(source.existing?.context_files) !== JSON.stringify(source.context_files) || source.existing?.knowledge_available !== source.knowledge_available) return false;
  try { parseSummaryOutput(JSON.stringify(source.existing), "scene"); return true; } catch { return false; }
}
function sceneBody(text: string): string { return text.replace(/^---\s*\r?\n[\s\S]*?\r?\n---\s*\r?\n/u, "").trim(); }
const boundedPrompt = (value: string): string => { if (new TextEncoder().encode(value).byteLength > 768 * 1024) throw new PairedError("capacity", "Summary prompt exceeds the bounded output size"); return value; };
const common = "あなたは小説執筆支援アシスタントです。\n主張には根拠の引用を付けてください。引用できない内容は断言しないでください。\n出力は日本語で行ってください。";
export function sceneSummaryPrompt(source: SummarySource): string {
  return boundedPrompt(`${common}\n\n次の小説シーンを日本語で要約してください。\n要約は必ず3行、加えて登場人物とシーン内の状態変化を抽出してください。\nscene_id: ${source.id}\n既知の登場人物: ${source.known_characters.join("、") || "なし"}\n本文:\n${sceneBody(source.text)}\n\nJSONのみを返してください。スキーマ: {"summaryLines":["...","...","..."],"characters":["..."],"stateChanges":["..."]}`);
}
export function chapterSummaryPrompt(id: string, children: Array<{ id: string; summaryLines: string[] }>): string {
  return boundedPrompt(`${common}\n\n次のシーン要約群から章のあらすじを日本語で3行にまとめてください。\nchapter_id: ${id}\nシーン要約:\n${children.map(child => `## ${child.id}\n${child.summaryLines.join("\n")}`).join("\n\n")}\n\nJSONのみを返してください。スキーマ: {"summaryLines":["...","...","..."]}`);
}
export function expectedSummaryRevisions(prepared: SummaryPreparation): Array<{ path: string; revision: string | null }> {
  const values = new Map<string, string | null>();
  const add = (path: string, revision: string | null) => { if (values.has(path) && values.get(path) !== revision) throw new PairedError("snapshot_stale", "Summary source revisions conflict"); values.set(path, revision); };
  for (const source of prepared.sources) { add(source.metadata_path, source.metadata_revision); add(source.manuscript_path, source.manuscript_revision); add(source.summary_path, source.summary_revision); for (const context of source.context_files) add(context.path, context.revision); }
  if (prepared.chapter_metadata) add(prepared.chapter_metadata.path, prepared.chapter_metadata.revision);
  if (prepared.parent_path) add(prepared.parent_path, prepared.parent_revision);
  return [...values].map(([path, revision]) => ({ path, revision })).sort((a, b) => a.path.localeCompare(b.path));
}
/** Snapshot-bound prompt preview never invokes a provider or submits a proposal. */
export function* previewSummary(input: unknown, host: GuestHost, request: ActionRequest): Generator<HostCall, unknown, unknown> {
  const prepared = yield* prepareSummary(input, host, request);
  const children = prepared.sources.map(source => ({ id: source.id, sourceHash: source.manuscript_revision,
    cached: sceneSummaryCurrent(source),
    prompt: sceneSummaryPrompt(source) }));
  const cached = prepared.sources.every((source, i) => children[i]!.cached);
  const diagnostics = prepared.sources.filter(source => !source.knowledge_available).map(source => ({ code: "dependency_unavailable", severity: "warning", sceneId: source.id, message: "Knowledge character references were unavailable" }));
  const result = { scope: prepared.scope, targetId: prepared.targetId, snapshot: request.snapshot, provider_invoked: false,
    children, diagnostics, expectedFileRevisions: expectedSummaryRevisions(prepared),
    chapterPrompt: prepared.scope === "chapter" && cached ? chapterSummaryPrompt(prepared.targetId, prepared.sources.map(source => ({ id: source.id, summaryLines: parseSummaryOutput(JSON.stringify(source.existing), "scene").summaryLines }))) : null };
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > 768 * 1024) throw new PairedError("capacity", "Summary preview exceeds the bounded output size");
  return result;
}

export function* suggestSummary(input: unknown, host: GuestHost, request: ActionRequest, generate: GenerateProvider): Generator<HostCall, unknown, unknown> {
  const prepared = yield* prepareSummary(input, host, request); const children: Array<{ id: string; sourceHash: string; summary: Summary; cached: boolean; provenance: unknown }> = [];
  for (const source of prepared.sources) {
    if (sceneSummaryCurrent(source)) {
      const summary = parseSummaryOutput(JSON.stringify(source.existing), "scene");
      children.push({ id: source.id, sourceHash: source.manuscript_revision, summary, cached: true, provenance: source.existing });
    } else {
      const result = yield* generate(host, request, { feature: "scene-summary", prompt: sceneSummaryPrompt(source), promptVersion: "scene-summary@3", maxOutputTokens: 768,
        sourceManifest: [{ path: source.metadata_path, revision: source.metadata_revision }, { path: source.manuscript_path, revision: source.manuscript_revision }, ...source.context_files] });
      const parsed = parseSummaryOutput(result.text, "scene");
      if (!parsed.characters?.length) parsed.characters = source.known_characters;
      children.push({ id: source.id, sourceHash: source.manuscript_revision, summary: parsed, cached: false, provenance: result.provenance });
    }
  }
  const expectedFileRevisions = expectedSummaryRevisions(prepared);
  const diagnostics = prepared.sources.filter(source => !source.knowledge_available).map(source => ({ code: "dependency_unavailable", severity: "warning", sceneId: source.id, message: "Knowledge character references were unavailable" }));
  const citations = prepared.sources.map(source => ({ path: source.manuscript_path, revision: source.manuscript_revision, sceneId: source.id }));
  if (prepared.scope === "scene") return { scope: "scene", targetId: prepared.targetId, summary: children[0]!.summary,
    sourceHash: children[0]!.sourceHash, cached: children[0]!.cached, citations, diagnostics, expectedFileRevisions, provenance: children[0]!.provenance };
  const sourceHash = chapterSummaryFingerprint(children);
  if (isFreshSummary(prepared.parent_existing, sourceHash, prepared.promptVersion) && prepared.parent_existing?.id === prepared.targetId &&
      JSON.stringify(prepared.parent_existing?.source_files) === JSON.stringify(prepared.sources.flatMap(source => [{ path: source.metadata_path, revision: source.metadata_revision }, { path: source.manuscript_path, revision: source.manuscript_revision }])) &&
      JSON.stringify(prepared.parent_existing?.context_files) === JSON.stringify([...new Map(prepared.sources.flatMap(source => source.context_files).map(file => [file.path, file])).values()]) &&
      prepared.parent_existing?.knowledge_available === prepared.sources.every(source => source.knowledge_available) && children.every(child => child.cached)) {
    return { scope: "chapter", targetId: prepared.targetId, summary: parseSummaryOutput(JSON.stringify(prepared.parent_existing), "chapter"), sourceHash, children, cached: true, citations, diagnostics, expectedFileRevisions, provenance: prepared.parent_existing };
  }
  const generated = yield* generate(host, request, { feature: "chapter-summary", prompt: chapterSummaryPrompt(prepared.targetId, children.map(child => ({ id: child.id, summaryLines: child.summary.summaryLines }))),
    promptVersion: prepared.promptVersion, maxOutputTokens: 512, sourceManifest: citations });
  return { scope: "chapter", targetId: prepared.targetId, summary: parseSummaryOutput(generated.text, "chapter"), sourceHash, children, cached: false, citations, diagnostics, expectedFileRevisions, provenance: generated.provenance };
}

/** Preserve unknown summary keys and comments; reject non-mapping input before proposing. */
export function updateSummaryYaml(source: string | null, updates: Record<string, unknown>): string {
  if (source === null) return stringify(updates);
  let output = source;
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  if (source.includes("\r\n") && /(?<!\r)\n/u.test(source)) throw new PairedError("unsupported_format", "Mixed line endings cannot be safely preserved");
  for (const [key, value] of Object.entries(updates)) {
    const doc = parseDocument(output, { uniqueKeys: true, keepSourceTokens: true });
    if (doc.errors.length || !isMap(doc.contents)) throw new PairedError("unsupported_format", "Summary YAML must be a valid mapping");
    if (JSON.stringify(doc.get(key)) === JSON.stringify(value)) continue;
    const node = doc.contents.get(key, true);
    if (node === undefined) {
      if (/^\.\.\.[ \t]*$/mu.test(output)) throw new PairedError("unsupported_format", "Cannot append after a YAML document end marker");
      const fragment = stringify({ [key]: value }).replace(/\n/gu, eol);
      output += `${output.endsWith("\n") || output.length === 0 ? "" : eol}${fragment}`;
      continue;
    }
    if (!node || !node.range || node.comment || node.commentBefore || (node as { anchor?: string; tag?: string }).anchor || (node as { tag?: string }).tag) throw new PairedError("unsupported_format", `Cannot safely edit ${key}`);
    const [start, end] = node.range;
    const original = output.slice(start, end);
    if (/(^|\s)#/u.test(original)) throw new PairedError("unsupported_format", `Cannot safely preserve comments inside ${key}`);
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new PairedError("invalid_input", `Cannot serialize ${key}`);
    const suffix = original.endsWith("\n") ? eol : "";
    output = output.slice(0, start) + serialized + suffix + output.slice(end);
  }
  const doc = parseDocument(output, { uniqueKeys: true }); const parsed = doc.toJS();
  if (doc.errors.length || !isObj(parsed) || Object.entries(updates).some(([key, value]) => JSON.stringify(parsed[key]) !== JSON.stringify(value))) throw new PairedError("unsupported_format", "Summary YAML update could not be verified");
  return output;
}

/** Create one Host-reviewed unit for the Paired-owned summary files. */
export function* proposeSummary(input: unknown, host: GuestHost, request: ActionRequest): Generator<HostCall, unknown, unknown> {
  const args = record(input, "input");
  exactKeys(args, ["scope", "targetId", "expectedFileRevisions", "summary", "citations", "sourceHash", "provenance", "children"], "input");
  if (!request.idempotency_key) throw new PairedError("invalid_input", "Summary proposal requires a Host idempotency key");
  const prepared = yield* prepareSummary({ scope: args.scope, targetId: args.targetId, expectedSnapshot: request.snapshot.id }, host, request);
  const summary = parseSummaryOutput(JSON.stringify(args.summary), prepared.scope);
  const provenance = record(args.provenance, "provenance");
  if (typeof provenance.provider !== "string" || !provenance.provider || typeof provenance.model !== "string" || !provenance.model || provenance.promptVersion !== prepared.promptVersion) {
    throw new PairedError("invalid_input", "Summary provenance is missing or has a different prompt version");
  }
  const sources = prepared.sources.map(source => ({ id: source.id, sourceHash: source.manuscript_revision }));
  const expectedHash = prepared.scope === "scene" ? sources[0]!.sourceHash : chapterSummaryFingerprint(sources);
  if (args.sourceHash !== expectedHash) throw new PairedError("snapshot_stale", "Summary source hash no longer matches the current sources");
  if (!Array.isArray(args.citations) || args.citations.length !== prepared.sources.length) throw new PairedError("invalid_input", "Summary requires one citation per source scene");
  for (let i = 0; i < prepared.sources.length; i++) {
    const citation = record(args.citations[i], `citations[${i}]`), source = prepared.sources[i]!;
    if (citation.path !== source.manuscript_path || citation.revision !== source.manuscript_revision || citation.sceneId !== source.id) throw new PairedError("snapshot_stale", "Summary citation differs from the source scene");
  }
  const readMap = new Map<string, string | null>();
  const addRead = (path: string, revision: string | null) => { const previous = readMap.get(path); if (previous !== undefined && previous !== revision) throw new PairedError("snapshot_stale", "Conflicting source revisions"); readMap.set(path, revision); };
  for (const source of prepared.sources) { addRead(source.metadata_path, source.metadata_revision); addRead(source.manuscript_path, source.manuscript_revision); addRead(source.summary_path, source.summary_revision); for (const context of source.context_files) addRead(context.path, context.revision); }
  if (prepared.chapter_metadata) addRead(prepared.chapter_metadata.path, prepared.chapter_metadata.revision);
  if (prepared.parent_path) addRead(prepared.parent_path, prepared.parent_revision);
  if (!Array.isArray(args.expectedFileRevisions) || args.expectedFileRevisions.length !== readMap.size) throw new PairedError("snapshot_stale", "Summary expected file revisions are incomplete");
  const expected = new Map<string, unknown>();
  for (const raw of args.expectedFileRevisions) { const entry = record(raw, "expected file revision"); exactKeys(entry, ["path", "revision"], "expected file revision"); if (typeof entry.path !== "string" || expected.has(entry.path)) throw new PairedError("invalid_input", "Summary expected file paths must be unique"); expected.set(entry.path, entry.revision); }
  for (const [path, revision] of readMap) if (!expected.has(path) || expected.get(path) !== revision) throw new PairedError("snapshot_stale", `Summary source revision changed: ${path}`, { path });
  const timestamp = yield* host.request<{ timestamp: string }>("workspace.change.timestamp", {});
  if (!timestamp || typeof timestamp.timestamp !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/u.test(timestamp.timestamp) || !Number.isFinite(Date.parse(timestamp.timestamp))) throw new PairedError("invalid_input", "Host returned invalid summary timestamp");
  const sourceFiles = prepared.sources.flatMap(source => [{ path: source.metadata_path, revision: source.metadata_revision }, { path: source.manuscript_path, revision: source.manuscript_revision }]);
  const orderedChildren = prepared.sources.map(source => ({ id: source.id, metadata_path: source.metadata_path, metadata_revision: source.metadata_revision,
    manuscript_path: source.manuscript_path, manuscript_revision: source.manuscript_revision }));
  const writes: Array<{ path: string; revision: string | null; text: string }> = [];
  if (prepared.scope === "scene") {
    const source = prepared.sources[0]!;
    writes.push({ path: source.summary_path, revision: source.summary_revision, text: updateSummaryYaml(source.existing_text, {
      sceneId: source.id, ...summary, sourceHash: expectedHash, generatedAt: timestamp.timestamp,
      provider: provenance.provider, model: provenance.model, promptVersion: prepared.promptVersion, snapshot: request.snapshot,
      source_files: sourceFiles, context_files: source.context_files, knowledge_available: source.knowledge_available,
    }) });
  } else {
    if (!Array.isArray(args.children) || args.children.length !== prepared.sources.length) throw new PairedError("invalid_input", "Chapter proposal must carry all ordered child summaries");
    for (let i = 0; i < prepared.sources.length; i++) {
      const source = prepared.sources[i]!, child = record(args.children[i], `children[${i}]`);
      if (child.id !== source.id || child.sourceHash !== source.manuscript_revision) throw new PairedError("snapshot_stale", "Chapter child order or source changed");
      const childSummary = parseSummaryOutput(JSON.stringify(child.summary), "scene");
      if (child.cached === true) {
        if (!sceneSummaryCurrent(source) || JSON.stringify(parseSummaryOutput(JSON.stringify(source.existing), "scene")) !== JSON.stringify(childSummary)) throw new PairedError("snapshot_stale", "Cached child summary is no longer current");
        continue;
      }
      const childProvenance = record(child.provenance, `children[${i}].provenance`);
      if (typeof childProvenance.provider !== "string" || !childProvenance.provider || typeof childProvenance.model !== "string" || !childProvenance.model || childProvenance.promptVersion !== "scene-summary@3") throw new PairedError("invalid_input", "Child summary provenance is invalid");
      writes.push({ path: source.summary_path, revision: source.summary_revision, text: updateSummaryYaml(source.existing_text, {
        sceneId: source.id, ...childSummary, sourceHash: source.manuscript_revision, generatedAt: timestamp.timestamp,
        provider: childProvenance.provider, model: childProvenance.model, promptVersion: "scene-summary@3", snapshot: request.snapshot,
        source_files: [{ path: source.metadata_path, revision: source.metadata_revision }, { path: source.manuscript_path, revision: source.manuscript_revision }], context_files: source.context_files, knowledge_available: source.knowledge_available,
      }) });
    }
    writes.push({ path: prepared.parent_path!, revision: prepared.parent_revision, text: updateSummaryYaml(prepared.parent_existing_text, {
      scope: "chapter", id: prepared.targetId, ...summary, sourceHash: expectedHash, generatedAt: timestamp.timestamp,
      provider: provenance.provider, model: provenance.model, promptVersion: prepared.promptVersion, snapshot: request.snapshot,
      source_files: sourceFiles, context_files: [...new Map(prepared.sources.flatMap(source => source.context_files).map(file => [file.path, file])).values()], knowledge_available: prepared.sources.every(source => source.knowledge_available), children: orderedChildren,
    }) });
  }
  const changeId = `paired-summary-${sha256(new TextEncoder().encode(JSON.stringify([request.scope.workspace_id, request.scope.generation, request.idempotency_key])))}`;
  const changeset = { id: changeId, idempotency_key: request.idempotency_key, scope: request.scope, snapshot: request.snapshot,
    title: `Update ${prepared.scope} summary`, reason: "Author-reviewed source-bound summary",
    read_set: [...readMap].map(([path, revision]) => ({ path, revision })).sort((a, b) => a.path.localeCompare(b.path)),
    units: [{ id: `${changeId}-unit`, label: "Summary", depends_on: [], operations: writes.map((write, index) => ({ id: `${changeId}-${index + 1}`,
      kind: write.revision === null ? "create" : "replace", path: write.path, expected_revision: write.revision, content: [...new TextEncoder().encode(write.text)] })) }], evidence: [] };
  const receipt = yield* host.request<{ proposal_id: string }>("workspace.change.propose", { changeset });
  if (!receipt || typeof receipt.proposal_id !== "string" || !receipt.proposal_id) throw new PairedError("storage_unknown", "Host did not return a summary proposal receipt");
  return { proposal_id: receipt.proposal_id, change_set_id: changeId, status: "proposed", paths: writes.map(write => write.path) };
}
