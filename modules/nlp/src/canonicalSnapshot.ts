import type { SnapshotReader } from "@scriptorium/contracts";
import YAML from "yaml";

export interface CanonicalSnapshotEntity {
  id: string;
  type: string;
  filePath: string;
  name?: string;
  aliases?: string[];
  raw: Record<string, unknown>;
  body?: string;
}

const ENTITY_PREFIXES = ["bible", "plot", "meta", "manuscript"] as const;
const MAX_ENTITY_FILES = 20_000;
const FRONT_MATTER_RE = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

function inferredType(path: string, data: Record<string, unknown>): string {
  if (typeof data.type === "string") return data.type;
  const normalized = `/${path.replaceAll("\\", "/")}`;
  const directoryTypes: Array<[string, string]> = [
    ["/bible/characters/", "character"], ["/bible/locations/", "location"],
    ["/bible/items/", "item"], ["/bible/factions/", "faction"],
    ["/bible/timeline/events/", "event"], ["/bible/lore/", "lore"],
    ["/plot/threads/", "thread"], ["/plot/arcs/", "arc"],
    ["/bible/dialogue_sketches/", "dialogue_sketch"],
  ];
  for (const [prefix, type] of directoryTypes) if (normalized.includes(prefix)) return type;
  if (normalized.includes("/plot/volumes/") && normalized.endsWith("volume.yaml")) return "volume";
  if (normalized.includes("/plot/volumes/") && normalized.endsWith("chapter.yaml")) return "chapter";
  if (normalized.includes("/scenes/") && /\.ya?ml$/i.test(path)) return "scene";
  if (normalized.includes("/manuscript/") && /\.md$/i.test(path)) return "manuscript";
  return "character";
}

function frontMatter(content: string): { raw: Record<string, unknown>; body: string } | null {
  const match = FRONT_MATTER_RE.exec(content);
  if (!match) return { raw: {}, body: content.trim() };
  let parsed: unknown;
  try { parsed = YAML.parse(match[1]); } catch { return null; }
  if (parsed === null || parsed === undefined) return { raw: {}, body: content.slice(match[0].length).trim() };
  if (typeof parsed !== "object" || Array.isArray(parsed)) return null;
  return { raw: parsed as Record<string, unknown>, body: content.slice(match[0].length).trim() };
}

/**
 * Reconstruct the source Core entity inputs from one immutable snapshot. This
 * mirrors loader.ts without activating the optional Story module, and is shared
 * by NLP candidate discovery and diagnostics scene metadata lookup.
 */
export async function readCanonicalSnapshotEntities(
  reader: SnapshotReader,
  signal: AbortSignal,
): Promise<CanonicalSnapshotEntity[]> {
  const paths = [...new Set((await Promise.all(ENTITY_PREFIXES.map((prefix) => reader.list(prefix)))).flat())]
    .filter((path) => /\.(?:ya?ml|md)$/i.test(path))
    .sort();
  if (paths.length > MAX_ENTITY_FILES) throw new TypeError(`Project analysis exceeds ${MAX_ENTITY_FILES} canonical entity files`);

  const entities: CanonicalSnapshotEntity[] = [];
  for (const path of paths) {
    if (signal.aborted) throw Object.assign(new Error("Snapshot entity read was cancelled"), { code: "job_cancelled" });
    const file = await reader.read(path);
    if (!file) continue;
    const isMarkdown = /\.md$/i.test(path);
    let raw: Record<string, unknown>;
    let body: string | undefined;
    if (isMarkdown) {
      const parsed = frontMatter(file.content);
      if (!parsed) continue;
      raw = parsed.raw;
      body = parsed.body;
    } else {
      let parsed: unknown;
      try { parsed = YAML.parse(file.content); } catch { continue; }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      raw = parsed as Record<string, unknown>;
      if (typeof raw.id !== "string") continue;
    }
    const id = isMarkdown
      ? `ms-${path.slice("manuscript/".length).replaceAll("/", "-").replace(/\.md$/i, "")}`
      : raw.id as string;
    const aliases = Array.isArray(raw.aliases) ? raw.aliases.filter((alias): alias is string => typeof alias === "string") : undefined;
    entities.push({
      id,
      type: inferredType(path, raw),
      filePath: path,
      ...(typeof raw.name === "string" ? { name: raw.name } : typeof raw.title === "string" && isMarkdown ? { name: raw.title } : {}),
      ...(aliases ? { aliases } : {}),
      raw,
      ...(body !== undefined ? { body } : {}),
    });
  }
  return entities;
}
