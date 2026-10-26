import YAML from "yaml";
import { sha256 } from "./core.js";

export interface ProjectFile { path: string; revision: string; text: string; invalidEncoding?: boolean }
export interface ValidationIssue {
  code: string;
  severity: "error" | "warning";
  message: string;
  entityId?: string;
  filePath?: string;
  sourceRevision?: string;
  evidence?: Array<{ path: string; revision: string }>;
}
interface Entity { id: string; type: string; filePath: string; revision: string; raw: Record<string, unknown> }
interface Link { from: string; to: string; kind: string }
export interface ProjectEntity { id: string; type: string; filePath: string; revision: string; raw: Record<string, unknown> }
export interface ProjectLink { from: string; to: string; kind: string }
export interface ProjectScope { workId?: string; volumeId?: string; chapterId?: string; sceneId?: string }

const ENTITY_PATHS: Array<[RegExp, string]> = [
  [/^bible\/characters\/.+\.ya?ml$/iu, "character"],
  [/^bible\/locations\/.+\.ya?ml$/iu, "location"],
  [/^bible\/items\/.+\.ya?ml$/iu, "item"],
  [/^bible\/factions\/.+\.ya?ml$/iu, "faction"],
  [/^bible\/lore\/.+\.ya?ml$/iu, "lore"],
  [/^bible\/timeline\/events\/.+\.ya?ml$/iu, "event"],
  [/^bible\/dialogue_sketches\/.+\.ya?ml$/iu, "dialogue_sketch"],
  [/^plot\/threads\/.+\.ya?ml$/iu, "thread"],
  [/^plot\/arcs\/.+\.ya?ml$/iu, "arc"],
  [/^plot\/volumes\/[^/]+\/volume\.ya?ml$/iu, "volume"],
  [/^plot\/volumes\/[^/]+\/chapters\/[^/]+\/chapter\.ya?ml$/iu, "chapter"],
  [/^plot\/volumes\/[^/]+\/chapters\/[^/]+\/scenes\/[^/]+\.ya?ml$/iu, "scene"],
];
const LINK_FIELDS: Record<string, string> = {
  appears: "appears", mentions: "mentions", plants: "plants", advances: "advances", related: "related",
  pov: "pov", affiliated: "affiliated", target: "target", first_appears: "first_appears", planted: "planted", payoff: "payoff",
};
const safePath = (path: string): boolean => path.length > 0 && !path.startsWith("/") && !path.includes("\\") && !path.includes("\0") && path.split("/").every((part) => part && part !== "." && part !== "..");

export function isNarrativeEntityPath(path: string): boolean { return ENTITY_PATHS.some(([pattern]) => pattern.test(path)); }

/** Parse only canonical story metadata; prose bodies remain Host-read inputs. */
export function readProjectGraph(files: readonly ProjectFile[]): { recognized: boolean; entities: ProjectEntity[]; links: ProjectLink[]; issues: ValidationIssue[] } {
  const entities: ProjectEntity[] = [];
  const links: ProjectLink[] = [];
  const issues: ValidationIssue[] = [];
  for (const file of files) {
    const parsed = parseEntity(file);
    if (!parsed) continue;
    if ("code" in parsed) { issues.push(parsed); continue; }
    entities.push(parsed);
    const extracted = linksFrom(parsed);
    links.push(...extracted.links);
    if (extracted.malformed) issues.push({ code: "MALFORMED_LINK", severity: "error", message: "One or more relation fields must identify a target ID", entityId: parsed.id || undefined, filePath: parsed.filePath, sourceRevision: parsed.revision });
  }
  return { recognized: files.some((file) => isNarrativeEntityPath(file.path)), entities, links, issues };
}

function entityType(path: string): string | undefined { return ENTITY_PATHS.find(([pattern]) => pattern.test(path))?.[1]; }
function parseEntity(file: ProjectFile): Entity | ValidationIssue | undefined {
  const type = entityType(file.path);
  if (!type) return undefined;
  if (file.invalidEncoding) return { code: "INVALID_ENCODING", severity: "error", message: "Narrative YAML is not valid UTF-8", filePath: file.path, sourceRevision: file.revision };
  let document: ReturnType<typeof YAML.parseDocument>;
  try { document = YAML.parseDocument(file.text, { uniqueKeys: true, strict: true }); }
  catch (error) {
    return { code: "MALFORMED_YAML", severity: "error", message: error instanceof Error ? error.message : "Could not parse YAML", filePath: file.path, sourceRevision: file.revision };
  }
  if (document.errors.length > 0) return { code: "MALFORMED_YAML", severity: "error", message: document.errors[0].message, filePath: file.path, sourceRevision: file.revision };
  let raw: unknown;
  try { raw = document.toJS({ maxAliasCount: 100 }); }
  catch (error) {
    return { code: "MALFORMED_YAML", severity: "error", message: error instanceof Error ? error.message : "Invalid YAML aliases", filePath: file.path, sourceRevision: file.revision };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { code: "MALFORMED_ENTITY", severity: "error", message: "Narrative YAML root must be a mapping", filePath: file.path, sourceRevision: file.revision };
  const id = typeof (raw as Record<string, unknown>).id === "string" ? (raw as Record<string, unknown>).id as string : "";
  return { id, type, filePath: file.path, revision: file.revision, raw: raw as Record<string, unknown> };
}

function linksFrom(entity: Entity): { links: Link[]; malformed: boolean } {
  const links: Link[] = [];
  let malformed = false;
  const add = (value: unknown, kind: string) => {
    if (typeof value === "string" && value.length) links.push({ from: entity.id, to: value, kind });
    else if (value && typeof value === "object" && !Array.isArray(value)) {
      const object = value as Record<string, unknown>;
      const target = object.target ?? object.scene ?? object.id;
      if (typeof target === "string" && target) links.push({ from: entity.id, to: target, kind });
      else malformed = true;
    } else malformed = true;
  };
  for (const [field, kind] of Object.entries(LINK_FIELDS)) {
    const value = entity.raw[field];
    if (value === undefined || value === null || value === false || value === "") continue;
    if (Array.isArray(value)) for (const target of value) add(target, kind);
    else add(value, kind);
  }
  if (entity.raw.relations !== undefined) {
    if (!Array.isArray(entity.raw.relations)) malformed = true;
    else for (const raw of entity.raw.relations) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw) || typeof (raw as Record<string, unknown>).target !== "string") { malformed = true; continue; }
      const relation = raw as Record<string, unknown>;
      links.push({ from: entity.id, to: relation.target as string, kind: typeof relation.kind === "string" ? relation.kind : "related" });
    }
  }
  for (const [field, kind] of Object.entries(LINK_FIELDS)) {
    const nested = entity.raw.entities;
    if (nested && typeof nested === "object" && !Array.isArray(nested) && (nested as Record<string, unknown>)[field] !== undefined) {
      const value = (nested as Record<string, unknown>)[field];
      if (Array.isArray(value)) for (const target of value) add(target, kind); else malformed = true;
    }
  }
  const threads = entity.raw.threads;
  if (threads && typeof threads === "object" && !Array.isArray(threads)) {
    for (const [field, kind] of [["plants", "plants"], ["advances", "advances"]] as const) {
      const value = (threads as Record<string, unknown>)[field];
      if (value !== undefined) {
        if (Array.isArray(value)) for (const target of value) add(target, kind); else malformed = true;
      }
    }
  }
  return { links, malformed };
}

function scopeEntityIds(entities: Entity[], scope?: ProjectScope): Set<string> | undefined {
  if (!scope || !Object.values(scope).some(Boolean)) return undefined;
  const byId = new Map(entities.filter((entity) => entity.id).map((entity) => [entity.id, entity]));
  if (scope.sceneId) return new Set([scope.sceneId]);
  let chapters = new Set<string>();
  if (scope.chapterId) chapters.add(scope.chapterId);
  if (scope.volumeId) for (const chapter of entities.filter((entity) => entity.type === "chapter" && (entity.raw.volume === scope.volumeId || String(entity.raw.volume) === scope.volumeId))) chapters.add(chapter.id);
  if (chapters.size) return new Set(entities.filter((entity) => entity.type === "scene" && typeof entity.raw.chapter === "string" && chapters.has(entity.raw.chapter)).map((entity) => entity.id));
  if (scope.workId) {
    if (!byId.has(scope.workId)) return new Set();
    return new Set(entities.filter((entity) => entity.id === scope.workId || entity.raw.work === scope.workId).map((entity) => entity.id));
  }
  return new Set();
}

/** Full source-preserving consistency scan over the Host-pinned file set. */
export function checkProjectConsistency(files: readonly ProjectFile[], scope?: ProjectScope): { recognized: boolean; findings: ValidationIssue[]; counts: { error: number; warning: number } } {
  const pathSet = new Set(files.map((file) => file.path));
  const entities: Entity[] = [];
  const findings: ValidationIssue[] = [];
  for (const file of files) {
    const entity = parseEntity(file);
    if (!entity) continue;
    if ("code" in entity) findings.push(entity);
    else entities.push(entity);
  }
  const recognized = files.some((file) => isNarrativeEntityPath(file.path));
  if (!recognized) return { recognized: false, findings: [], counts: { error: 0, warning: 0 } };

  const idsToEntities = new Map<string, Entity[]>();
  const links: Link[] = [];
  for (const entity of entities) {
    if (entity.id) idsToEntities.set(entity.id, [...(idsToEntities.get(entity.id) ?? []), entity]);
    if (!entity.id) findings.push({ code: "MISSING_ID", severity: "error", message: "Entity is missing id", filePath: entity.filePath, sourceRevision: entity.revision });
    if (entity.type === "scene") {
      const manuscript = entity.raw.manuscript;
      if (typeof manuscript !== "string" || !safePath(manuscript)) {
        findings.push({ code: "MISSING_MANUSCRIPT", severity: "warning", message: "Scene has no valid explicit manuscript path", entityId: entity.id || undefined, filePath: entity.filePath, sourceRevision: entity.revision });
      } else if (!pathSet.has(manuscript)) {
        findings.push({ code: "MISSING_MANUSCRIPT", severity: "warning", message: `Manuscript file not found: ${manuscript}`, entityId: entity.id || undefined, filePath: entity.filePath, sourceRevision: entity.revision });
      }
    }
    const extracted = linksFrom(entity);
    links.push(...extracted.links);
    if (extracted.malformed) findings.push({ code: "MALFORMED_LINK", severity: "error", message: "One or more relation fields must identify a target ID", entityId: entity.id || undefined, filePath: entity.filePath, sourceRevision: entity.revision });
  }
  for (const [id, duplicates] of idsToEntities) if (duplicates.length > 1) {
    findings.push({
      code: "DUPLICATE_ID", severity: "error", message: `Duplicate id ${id} is used by ${duplicates.length} files`,
      entityId: id, filePath: duplicates[0].filePath, sourceRevision: duplicates[0].revision,
      evidence: duplicates.map((entity) => ({ path: entity.filePath, revision: entity.revision })),
    });
  }
  const ids = new Set(idsToEntities.keys());
  for (const link of links) {
    if (!ids.has(link.from)) findings.push({ code: "MISSING_LINK_SOURCE", severity: "error", message: `Link source not found: ${link.from}`, entityId: link.from });
    if (!ids.has(link.to)) {
      const entity = idsToEntities.get(link.from)?.[0];
      findings.push({ code: "MISSING_LINK_TARGET", severity: "error", message: `Link target not found: ${link.to} (${link.kind})`, entityId: link.from, filePath: entity?.filePath, sourceRevision: entity?.revision });
    }
  }
  for (const thread of entities.filter((entity) => entity.type === "thread")) {
    const hasPlant = links.some((link) => link.to === thread.id && (link.kind === "plants" || link.kind === "planted"));
    const hasPayoff = links.some((link) => link.to === thread.id && link.kind === "payoff");
    if (thread.raw.status === "open" && !hasPlant) findings.push({ code: "THREAD_NO_PLANT", severity: "warning", message: `Open thread has no plant point: ${thread.id}`, entityId: thread.id, filePath: thread.filePath, sourceRevision: thread.revision });
    if (hasPlant && !hasPayoff && thread.raw.status !== "abandoned") findings.push({ code: "THREAD_NO_PAYOFF", severity: "warning", message: `Thread has plant but no payoff: ${thread.id}`, entityId: thread.id, filePath: thread.filePath, sourceRevision: thread.revision });
  }

  const selected = scopeEntityIds(entities, scope);
  const related = new Set<string>();
  if (selected) {
    for (const link of links) if (selected.has(link.from) || selected.has(link.to)) { related.add(link.from); related.add(link.to); }
  }
  const scopedFindings = selected ? findings.filter((finding) => {
    if (finding.entityId && (selected.has(finding.entityId) || related.has(finding.entityId))) return true;
    if (finding.filePath) return entities.some((entity) => selected.has(entity.id) && entity.filePath === finding.filePath);
    return false;
  }) : findings;
  scopedFindings.sort((a, b) => (a.filePath ?? "").localeCompare(b.filePath ?? "") || a.code.localeCompare(b.code) || (a.entityId ?? "").localeCompare(b.entityId ?? ""));
  return {
    recognized: true,
    findings: scopedFindings,
    counts: {
      error: scopedFindings.filter((finding) => finding.severity === "error").length,
      warning: scopedFindings.filter((finding) => finding.severity === "warning").length,
    },
  };
}

export function findingId(snapshotId: string, finding: ValidationIssue): string {
  return sha256(JSON.stringify([snapshotId, finding.filePath ?? null, finding.sourceRevision ?? null, finding.code, finding.entityId ?? null, finding.message]));
}
