import YAML from "yaml";
import { assertProjectPath, type SnapshotReader } from "@scriptorium/contracts";
import type { StoryEntity, StoryGraphInput, StoryLink } from "./domain/index.js";

const ENTITY_DIRS: ReadonlyArray<[string, StoryEntity["type"]]> = [
  ["bible/characters", "character"],
  ["bible/locations", "location"],
  ["bible/items", "item"],
  ["bible/factions", "faction"],
  ["bible/timeline/events", "event"],
  ["bible/lore", "lore"],
  ["plot/threads", "thread"],
  ["plot/arcs", "arc"],
  ["bible/dialogue_sketches", "dialogue_sketch"],
];

const ENTITY_TYPES = new Set<StoryEntity["type"]>([
  "character", "location", "item", "faction", "event", "thread", "scene", "chapter",
  "volume", "arc", "lore", "manuscript", "dialogue_sketch",
]);

const LINK_FIELDS: Readonly<Record<string, string>> = {
  appears: "appears",
  mentions: "mentions",
  plants: "plants",
  advances: "advances",
  related: "related",
  pov: "pov",
  affiliated: "affiliated",
  target: "target",
  first_appears: "first_appears",
  planted: "planted",
  payoff: "payoff",
};

export interface StoryFile {
  path: string;
  content: string;
  revision: string;
}

export interface LoadedStorySnapshot extends StoryGraphInput {
  files: ReadonlyMap<string, StoryFile>;
  revisions: ReadonlyMap<string, string>;
  duplicateIds: ReadonlyMap<string, readonly string[]>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function inferType(filePath: string, raw: Record<string, unknown>): StoryEntity["type"] | null {
  if (typeof raw.type === "string" && ENTITY_TYPES.has(raw.type as StoryEntity["type"])) {
    return raw.type as StoryEntity["type"];
  }
  for (const [prefix, type] of ENTITY_DIRS) {
    if (filePath.startsWith(`${prefix}/`)) return type;
  }
  if (/^plot\/volumes\/[^/]+\/volume\.ya?ml$/i.test(filePath)) return "volume";
  if (/^plot\/volumes\/[^/]+\/chapters\/[^/]+\/chapter\.ya?ml$/i.test(filePath)) return "chapter";
  if (/^plot\/volumes\/[^/]+\/chapters\/[^/]+\/scenes\/[^/]+\.ya?ml$/i.test(filePath)) return "scene";
  return null;
}

function appendLink(links: StoryLink[], from: string, to: unknown, kind: string, note?: unknown): void {
  if (typeof to !== "string" || !to) return;
  links.push({ from, to, kind, ...(typeof note === "string" ? { note } : {}) });
}

function extractLinks(entityId: string, raw: Record<string, unknown>, links: StoryLink[]): void {
  for (const [field, kind] of Object.entries(LINK_FIELDS)) {
    const value = raw[field];
    if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === "string") appendLink(links, entityId, item, kind);
        else {
          const ref = asRecord(item);
          if (ref) appendLink(links, entityId, ref.target ?? ref.scene ?? ref.id, kind, ref.note);
        }
      }
    } else if (typeof value === "string") {
      appendLink(links, entityId, value, kind);
    }
  }

  if (Array.isArray(raw.relations)) {
    for (const value of raw.relations) {
      const relation = asRecord(value);
      if (relation && typeof relation.target === "string") {
        appendLink(links, entityId, relation.target,
          typeof relation.kind === "string" ? relation.kind : "related", relation.note);
      }
    }
  }

  const nestedEntities = asRecord(raw.entities);
  if (nestedEntities) {
    for (const [field, kind] of Object.entries(LINK_FIELDS)) {
      const targets = nestedEntities[field];
      if (Array.isArray(targets)) {
        for (const target of targets) appendLink(links, entityId, target, kind);
      }
    }
  }

  const threads = asRecord(raw.threads);
  if (threads) {
    for (const field of ["plants", "advances"] as const) {
      const targets = threads[field];
      if (Array.isArray(targets)) {
        for (const target of targets) appendLink(links, entityId, target, field);
      }
    }
  }
}

function parseMarkdown(content: string): { raw: Record<string, unknown>; body: string } | null {
  const opening = /^---[ \t]*\r?\n/.exec(content);
  if (!opening) return { raw: {}, body: content.trim() };
  const delimiter = /^---[ \t]*\r?$/gm;
  delimiter.lastIndex = opening[0].length;
  const closing = delimiter.exec(content);
  if (!closing) return null;
  const raw = asRecord(YAML.parse(content.slice(opening[0].length, closing.index)));
  if (!raw) return null;
  let bodyStart = closing.index + closing[0].length;
  if (content.startsWith("\r\n", bodyStart)) bodyStart += 2;
  else if (content.startsWith("\n", bodyStart)) bodyStart += 1;
  return { raw, body: content.slice(bodyStart).trim() };
}

function parseStoryEntity(file: StoryFile): StoryEntity | null {
  if (file.path.startsWith("manuscript/") && file.path.endsWith(".md")) {
    const parsed = parseMarkdown(file.content);
    if (!parsed) return null;
    const id = file.path.replace(/^manuscript\//, "ms-").replace(/\//g, "-").replace(/\.md$/, "");
    return {
      id,
      type: "manuscript",
      name: typeof parsed.raw.title === "string" ? parsed.raw.title : undefined,
      status: typeof parsed.raw.status === "string" ? parsed.raw.status : undefined,
      tags: Array.isArray(parsed.raw.tags) ? parsed.raw.tags.filter((tag): tag is string => typeof tag === "string") : undefined,
      filePath: file.path,
      raw: parsed.raw,
      body: parsed.body,
    };
  }
  if (!file.path.endsWith(".yaml") && !file.path.endsWith(".yml")) return null;
  const raw = asRecord(YAML.parse(file.content));
  if (!raw || typeof raw.id !== "string") return null;
  const type = inferType(file.path, raw);
  if (!type) return null;
  return {
    id: raw.id,
    type,
    name: typeof raw.name === "string" ? raw.name : undefined,
    aliases: Array.isArray(raw.aliases) ? raw.aliases.filter((alias): alias is string => typeof alias === "string") : undefined,
    status: typeof raw.status === "string" ? raw.status : undefined,
    tags: Array.isArray(raw.tags) ? raw.tags.filter((tag): tag is string => typeof tag === "string") : undefined,
    keywords: Array.isArray(raw.keywords) ? raw.keywords.filter((keyword): keyword is string => typeof keyword === "string") : undefined,
    resolution: typeof raw.resolution === "string" ? raw.resolution : undefined,
    filePath: file.path,
    raw,
  };
}

async function readFiles(reader: SnapshotReader, includeManuscripts: boolean): Promise<Map<string, StoryFile>> {
  const prefixes = includeManuscripts ? ["bible", "plot", "meta", "manuscript"] : ["bible", "plot", "meta"];
  const listed = await Promise.all(prefixes.map((prefix) => reader.list(prefix)));
  const paths = [...new Set(listed.flat().filter((filePath) =>
    filePath.endsWith(".yaml") || filePath.endsWith(".yml") ||
    (filePath.startsWith("manuscript/") && filePath.endsWith(".md"))))].sort();
  for (const filePath of paths) assertProjectPath(filePath);

  const files = new Map<string, StoryFile>();
  const batchSize = 12;
  for (let offset = 0; offset < paths.length; offset += batchSize) {
    const batch = paths.slice(offset, offset + batchSize);
    const values = await Promise.all(batch.map(async (filePath) => [filePath, await reader.read(filePath)] as const));
    for (const [filePath, value] of values) {
      if (value) files.set(filePath, { path: filePath, content: value.content, revision: value.revision });
    }
  }
  return files;
}

/** Read the canonical project YAML and Markdown formats from one pinned Core snapshot. */
export async function readStorySnapshot(
  reader: SnapshotReader,
  options: { includeManuscripts?: boolean } = {},
): Promise<LoadedStorySnapshot> {
  const files = await readFiles(reader, options.includeManuscripts !== false);
  const entities = new Map<string, StoryEntity>();
  const filePathsById = new Map<string, string[]>();
  const links: StoryLink[] = [];

  for (const file of files.values()) {
    const entity = parseStoryEntity(file);
    if (!entity) continue;
    entities.set(entity.id, entity);
    const paths = filePathsById.get(entity.id) ?? [];
    paths.push(entity.filePath);
    filePathsById.set(entity.id, paths);
    extractLinks(entity.id, entity.raw, links);
  }

  for (const entity of entities.values()) {
    if (entity.type === "character" && entity.filePath.endsWith("/profile.yaml")) {
      const voicePath = entity.filePath.replace(/profile\.yaml$/, "voice.yaml");
      const voiceFile = files.get(voicePath);
      if (voiceFile) {
        try {
          const voice = asRecord(YAML.parse(voiceFile.content));
          if (voice) entity.raw = { ...entity.raw, voice };
        } catch {
          // The source loader keeps the profile usable when an optional voice.yaml is malformed.
        }
      }
    }
    if (entity.type !== "scene" || typeof entity.raw.manuscript !== "string") continue;
    const manuscript = [...entities.values()].find((candidate) => candidate.filePath === entity.raw.manuscript);
    if (manuscript) appendLink(links, entity.id, manuscript.id, "manuscript");
  }

  return {
    snapshot: reader.snapshot,
    entities,
    links,
    files,
    revisions: new Map([...files].map(([filePath, file]) => [filePath, file.revision])),
    duplicateIds: new Map([...filePathsById].filter(([, paths]) => paths.length > 1)),
  };
}
