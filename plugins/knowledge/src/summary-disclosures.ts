import YAML from "yaml";
import type { LoadedKnowledgeSnapshot } from "./snapshot.js";
import type { StoryEntity } from "./domain/types.js";

/** Consume only an approved summary pinned to the current scene and context. */
export function summaryDisclosure(story: LoadedKnowledgeSnapshot, scene: StoryEntity): { changes: string[]; path?: string; diagnostic?: string } {
  if (!/^[^/\\\0]{1,256}$/u.test(scene.id) || scene.id === "." || scene.id === "..") return { changes: [] };
  const path = scene.filePath.replace(/\/scenes\/[^/]+\.ya?ml$/u, `/scene-summaries/${scene.id}.yaml`);
  if (path === scene.filePath) return { changes: [] };
  const file = story.files.get(path);
  if (!file) return { changes: [] };
  const invalid = (diagnostic: string) => ({ changes: [], path, diagnostic });
  let value: unknown;
  try { value = YAML.parse(file.content, { uniqueKeys: true }); } catch { return invalid("invalid_summary"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid("invalid_summary");
  const row = value as Record<string, unknown>;
  const manuscript = scene.raw.manuscript;
  const metadataRevision = story.revisions.get(scene.filePath);
  const manuscriptRevision = typeof manuscript === "string" ? story.revisions.get(manuscript) : undefined;
  if (!metadataRevision || !manuscriptRevision || row.sceneId !== scene.id || row.sourceHash !== manuscriptRevision || row.promptVersion !== "scene-summary@3" || typeof row.model !== "string" || !row.model) return invalid("stale_summary");
  const lines = row.summaryLines;
  const validList = (v: unknown, max: number): v is string[] => Array.isArray(v) && v.length <= max && v.every((s) => typeof s === "string" && s.length <= 8192);
  if (!validList(lines, 3) || lines.length !== 3 || lines.some((line) => !line.trim()) || !validList(row.characters, 100) || !validList(row.stateChanges, 100) || typeof row.knowledge_available !== "boolean") return invalid("invalid_summary");
  const expected = [{ path: scene.filePath, revision: metadataRevision }, { path: manuscript, revision: manuscriptRevision }];
  if (JSON.stringify(row.source_files) !== JSON.stringify(expected) || !Array.isArray(row.context_files)) return invalid("stale_summary");
  const seen = new Set<string>();
  for (const item of row.context_files) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return invalid("invalid_summary");
    const context = item as Record<string, unknown>;
    if (typeof context.path !== "string" || typeof context.revision !== "string" || seen.has(context.path) || story.revisions.get(context.path) !== context.revision) return invalid("stale_summary");
    seen.add(context.path);
  }
  return { changes: row.stateChanges, path };
}
