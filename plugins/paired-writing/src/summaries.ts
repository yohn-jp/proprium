import { parseDocument } from "yaml";
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
  manuscript_revision: string; text: string; summary_path: string; summary_revision: string | null; existing: Record<string, unknown> | null };
export type SummaryPreparation = { scope: SummaryScope; targetId: string; expectedSnapshot: string; sources: SummarySource[];
  parent_path: string | null; parent_revision: string | null; parent_existing: Record<string, unknown> | null; promptVersion: string };
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
  if (!/^[A-Za-z0-9_-]{1,256}$/u.test(id) || !/\/scenes\/[^/]+\.ya?ml$/iu.test(metadataPath)) throw new PairedError("invalid_path", "Scene summary path cannot be derived safely");
  return metadataPath.replace(/\/scenes\/[^/]+\.ya?ml$/iu, `/scene-summaries/${id}.yaml`);
}
function* optionalYaml(host: GuestHost, request: ActionRequest, path: string): Generator<HostCall, { revision: string | null; raw: Record<string, unknown> | null }, unknown> {
  try {
    const file = yield* readText(host, request, path); const doc = parseDocument(file.text, { uniqueKeys: true });
    const value = doc.toJS();
    if (doc.errors.length || !isObj(value)) throw new PairedError("unsupported_format", `Summary metadata is malformed: ${path}`);
    return { revision: file.revision, raw: value };
  } catch (error) { if ((error as { code?: string }).code === "file_not_found") return { revision: null, raw: null }; throw error; }
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
  return { id, metadata_path: scene.metadata_path, metadata_revision: scene.metadata_revision,
    manuscript_path: manuscript.path, manuscript_revision: manuscript.revision, text: manuscript.text,
    summary_path: path, summary_revision: existing.revision, existing: existing.raw };
}
/** Read only the selected scene or up to 30 children in Narrative order, never a manuscript sweep. */
export function* prepareSummary(input: unknown, host: GuestHost, request: ActionRequest): Generator<HostCall, SummaryPreparation, unknown> {
  const args = record(input, "input"); exactKeys(args, ["scope", "targetId", "expectedSnapshot"], "input");
  const targetId = identity(args.targetId, "targetId");
  if (args.expectedSnapshot !== request.snapshot.id) throw new PairedError("snapshot_stale", "Summary request snapshot changed");
  if (args.scope !== "scene" && args.scope !== "chapter") throw new PairedError("invalid_input", "Summary scope is invalid");
  if (args.scope === "scene") return { scope: "scene", targetId, expectedSnapshot: request.snapshot.id,
    sources: [yield* sourceForScene(host, request, targetId)], parent_path: null, parent_revision: null, parent_existing: null, promptVersion: "scene-summary@3" };
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
    parent_revision: parent.revision, parent_existing: parent.raw, promptVersion: "chapter-summary@2" };
}
function sceneBody(text: string): string { return text.replace(/^---\s*\r?\n[\s\S]*?\r?\n---\s*\r?\n/u, "").trim(); }
const common = "あなたは小説執筆支援アシスタントです。\n主張には根拠の引用を付けてください。引用できない内容は断言しないでください。\n出力は日本語で行ってください。";
export function sceneSummaryPrompt(source: SummarySource): string {
  return `${common}\n\n次の小説シーンを日本語で要約してください。\n要約は必ず3行、加えて登場人物とシーン内の状態変化を抽出してください。\nscene_id: ${source.id}\n既知の登場人物: なし\n本文:\n${sceneBody(source.text)}\n\nJSONのみを返してください。スキーマ: {"summaryLines":["...","...","..."],"characters":["..."],"stateChanges":["..."]}`;
}
export function chapterSummaryPrompt(id: string, children: Array<{ id: string; summaryLines: string[] }>): string {
  return `${common}\n\n次のシーン要約群から章のあらすじを日本語で3行にまとめてください。\nchapter_id: ${id}\nシーン要約:\n${children.map(child => `## ${child.id}\n${child.summaryLines.join("\n")}`).join("\n\n")}\n\nJSONのみを返してください。スキーマ: {"summaryLines":["...","...","..."]}`;
}
export function* suggestSummary(input: unknown, host: GuestHost, request: ActionRequest, generate: GenerateProvider): Generator<HostCall, unknown, unknown> {
  const prepared = yield* prepareSummary(input, host, request); const children: Array<{ id: string; sourceHash: string; summary: Summary; cached: boolean; provenance: unknown }> = [];
  for (const source of prepared.sources) {
    if (isFreshSummary(source.existing, source.manuscript_revision, "scene-summary@3") && source.existing?.sceneId === source.id) {
      const summary = parseSummaryOutput(JSON.stringify(source.existing), "scene");
      children.push({ id: source.id, sourceHash: source.manuscript_revision, summary, cached: true, provenance: source.existing });
    } else {
      const result = yield* generate(host, request, { feature: "scene-summary", prompt: sceneSummaryPrompt(source), promptVersion: "scene-summary@3", maxOutputTokens: 768,
        sourceManifest: [{ path: source.metadata_path, revision: source.metadata_revision }, { path: source.manuscript_path, revision: source.manuscript_revision }] });
      children.push({ id: source.id, sourceHash: source.manuscript_revision, summary: parseSummaryOutput(result.text, "scene"), cached: false, provenance: result.provenance });
    }
  }
  const citations = prepared.sources.map(source => ({ path: source.manuscript_path, revision: source.manuscript_revision, sceneId: source.id }));
  if (prepared.scope === "scene") return { scope: "scene", targetId: prepared.targetId, summary: children[0]!.summary,
    sourceHash: children[0]!.sourceHash, cached: children[0]!.cached, citations, provenance: children[0]!.provenance };
  const sourceHash = chapterSummaryFingerprint(children);
  if (isFreshSummary(prepared.parent_existing, sourceHash, prepared.promptVersion) && prepared.parent_existing?.id === prepared.targetId && children.every(child => child.cached)) {
    return { scope: "chapter", targetId: prepared.targetId, summary: parseSummaryOutput(JSON.stringify(prepared.parent_existing), "chapter"), sourceHash, children, cached: true, citations, provenance: prepared.parent_existing };
  }
  const generated = yield* generate(host, request, { feature: "chapter-summary", prompt: chapterSummaryPrompt(prepared.targetId, children.map(child => ({ id: child.id, summaryLines: child.summary.summaryLines }))),
    promptVersion: prepared.promptVersion, maxOutputTokens: 512, sourceManifest: citations });
  return { scope: "chapter", targetId: prepared.targetId, summary: parseSummaryOutput(generated.text, "chapter"), sourceHash, children, cached: false, citations, provenance: generated.provenance };
}
