import { randomUUID } from "node:crypto";
import type { ActionResult, ChangeOperation, ModuleAction, ModuleActionContext, ValueSchema } from "@scriptorium/contracts";
import { readEpubBibleEntries } from "./bible.js";
import { buildEpubExport, DEFAULT_EPUB_COVER_PATH, type EpubExportOptions } from "./epub.js";
import { readEpisodeMap, mergeEpisodeMap, EPISODES_PATH } from "./episodes.js";
import {
  createShareGrant,
  readShareGrants,
  safeShareGrant,
  serializeShareGrants,
  SHARE_GRANTS_PATH,
  type ShareGrant,
} from "./grants.js";
import { buildPlaintextExport, type PlaintextOptions } from "./plaintext.js";
import { readPublishingProject, resolveShareScope, type ShareScope } from "./project.js";
import { collectScenesForVerticalPrint, composeVerticalPrintText } from "./verticalPrint.js";

type RecordValue = Record<string, unknown>;
type Parser<T> = (value: unknown) => T;
type Runner<I, O> = (input: I, context: ModuleActionContext) => Promise<O> | O;

function object(value: unknown, label = "input"): RecordValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as RecordValue;
}

function string(value: unknown, label: string, optional = false): string | undefined {
  if (optional && value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  return value;
}

function boolean(value: unknown, label: string, fallback = false): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean`);
  return value;
}

function outputObject(value: unknown): RecordValue {
  return object(value, "Action output");
}

function valueSchema<T>(parse: Parser<T>): ValueSchema<T> {
  return { parse };
}

function defineAction<I, O>(inputSchema: ValueSchema<I>, id: string, effect: ModuleAction["effect"], run: Runner<I, O>): ModuleAction {
  return {
    id,
    effect,
    inputSchema,
    outputSchema: valueSchema(outputObject),
    async invoke(input, context): Promise<ActionResult> {
      const data = await run(input as I, context);
      return { ok: true, snapshot: context.reader.snapshot, data };
    },
  };
}

function parseScopeExport(value: unknown): PlaintextOptions["scope"] {
  if (value === "all" || value === "volume" || value === "chapter") return value;
  throw new Error("scope must be all, volume, or chapter");
}

function parseExportInput(value: unknown): PlaintextOptions {
  const data = object(value);
  const scope = parseScopeExport(data.scope);
  const id = string(data.id, "id", true);
  if (scope !== "all" && !id?.trim()) throw new Error("A volume or chapter ID is required");
  return { scope, ...(id === undefined ? {} : { id }) };
}

function parsePlaintextInput(value: unknown): PlaintextOptions {
  const data = object(value);
  const base = parseExportInput(data);
  const stripMarkup = boolean(data.stripMarkup, "stripMarkup");
  const dialect = data.dialect;
  if (dialect !== undefined && dialect !== "kakuyomu" && dialect !== "narou") throw new Error("dialect must be kakuyomu or narou");
  if (stripMarkup && dialect) throw new Error("stripMarkup and dialect are mutually exclusive");
  return { ...base, stripMarkup, ...(dialect ? { dialect } : {}) };
}

function parseEpubInput(value: unknown): EpubExportOptions {
  const data = object(value);
  const base = parseExportInput(data);
  const coverPath = string(data.coverPath, "coverPath", true);
  const title = string(data.title, "title", true);
  const subtitle = string(data.subtitle, "subtitle", true);
  return {
    ...base,
    ...(coverPath === undefined ? {} : { coverPath }),
    ...(title === undefined ? {} : { title }),
    ...(subtitle === undefined ? {} : { subtitle }),
    includeBibleAppendix: boolean(data.includeBibleAppendix, "includeBibleAppendix"),
  };
}

function parseVerticalInput(value: unknown): { scope: PlaintextOptions["scope"]; id?: string } {
  return parseExportInput(value);
}

function parseEpisodeInput(value: unknown): { episodes: unknown[] } {
  const data = object(value);
  if (!Array.isArray(data.episodes)) throw new Error("episodes must be an array");
  return { episodes: data.episodes };
}

function parseShareCreateInput(value: unknown): { scope: ShareScope; label?: string; expiresInHours?: number } {
  const data = object(value);
  if (data.kind !== "volume" && data.kind !== "chapter" && data.kind !== "scene") throw new Error("kind must be volume, chapter, or scene");
  const id = string(data.id, "id")!;
  if (!id.trim()) throw new Error("A share scope ID is required");
  const label = string(data.label, "label", true);
  const expiresInHours = data.expiresInHours === undefined ? undefined : Number(data.expiresInHours);
  if (expiresInHours !== undefined && !Number.isFinite(expiresInHours)) throw new Error("expiresInHours must be a number");
  return { scope: { kind: data.kind, id }, ...(label === undefined ? {} : { label }), ...(expiresInHours === undefined ? {} : { expiresInHours }) };
}

function parseShareRevokeInput(value: unknown): { id: string } {
  const data = object(value);
  const id = string(data.id, "id")!;
  if (!id.trim()) throw new Error("A share grant ID is required");
  return { id };
}

async function makeMetadataOperation(context: ModuleActionContext, path: string, content: string, message: string): Promise<ChangeOperation> {
  const current = await context.reader.read(path);
  const snapshot = context.reader.snapshot;
  return {
    id: randomUUID().replaceAll("-", ""),
    generation: 0,
    repository: snapshot.repository,
    baseRemoteCommit: snapshot.remoteCommit,
    effect: "metadata",
    reads: [{ path, revision: current?.revision ?? null }],
    writes: [{ path, revision: current?.revision ?? null, content }],
    message,
  };
}

function sortedGrantContent(grants: ShareGrant[]): string {
  return serializeShareGrants([...grants].sort((left, right) => left.id.localeCompare(right.id)));
}

export function createPublishingActions(): ModuleAction[] {
  const actions: ModuleAction[] = [];

  actions.push(defineAction(valueSchema(parsePlaintextInput), "publishing.export.plaintext", "compute", async (input, context) => {
    const project = await readPublishingProject(context.reader);
    const exported = buildPlaintextExport(project, input);
    return { filename: exported.filename, mediaType: "text/plain; charset=utf-8", contentBase64: Buffer.from(exported.text, "utf8").toString("base64") };
  }));

  actions.push(defineAction(valueSchema(parseEpubInput), "publishing.export.epub", "compute", async (input, context) => {
    const project = await readPublishingProject(context.reader);
    const options = { ...input, ...(input.coverPath ? {} : {}) };
    // The legacy import moves .arcadia/cover.jpg to the module-owned path.
    if (input.coverPath === ".arcadia/cover.jpg") options.coverPath = DEFAULT_EPUB_COVER_PATH;
    const bibleEntries = input.includeBibleAppendix ? await readEpubBibleEntries(context.reader) : [];
    const exported = await buildEpubExport(project, options, context.reader, bibleEntries);
    return { filename: exported.filename, mediaType: "application/epub+zip", contentBase64: exported.buffer.toString("base64") };
  }));

  actions.push(defineAction(valueSchema(parseVerticalInput), "publishing.export.vertical-print", "compute", async (input, context) => {
    const project = await readPublishingProject(context.reader);
    const scenes = collectScenesForVerticalPrint(project, input.scope, input.id);
    const text = composeVerticalPrintText(scenes.map((scene) => ({ id: scene.id, title: scene.title, body: scene.body })));
    return { text, sectionCount: scenes.length };
  }));

  actions.push(defineAction(valueSchema((value) => object(value)), "publishing.project.tree", "read", async (_input, context) => {
    const project = await readPublishingProject(context.reader);
    return {
      title: project.title,
      volumes: project.volumes.map((volume) => ({
        id: volume.id,
        title: volume.title,
        chapters: volume.chapters.map((chapter) => ({
          id: chapter.id,
          title: chapter.title,
          scenes: chapter.scenes.map((scene) => ({ id: scene.id, title: scene.title })),
        })),
      })),
    };
  }));

  actions.push(defineAction(valueSchema((value) => object(value)), "publishing.episodes.read", "read", async (_input, context) => {
    const map = await readEpisodeMap(context.reader);
    return { episodes: map.episodes };
  }));

  actions.push(defineAction(valueSchema(parseEpisodeInput), "publishing.episodes.propose", "propose", async (input, context) => {
    const existing = await readEpisodeMap(context.reader);
    const merged = mergeEpisodeMap(existing, input.episodes);
    const operation = await makeMetadataOperation(context, EPISODES_PATH, merged.content, "Update publication episode mapping");
    const proposal = await context.propose([operation]);
    return { episodes: merged.episodes, proposalId: proposal.id, activation: "requires author approval, checkpoint, and confirmed publish" };
  }));

  actions.push(defineAction(valueSchema((value) => object(value)), "publishing.shares.list", "read", async (_input, context) => {
    const { grants } = await readShareGrants(context.reader);
    const now = Date.now();
    return { shares: grants.map((grant) => ({ ...safeShareGrant(grant), active: !grant.revokedAt && Date.parse(grant.expiresAt) > now })) };
  }));

  actions.push(defineAction(valueSchema(parseShareCreateInput), "publishing.shares.create", "propose", async (input, context) => {
    const project = await readPublishingProject(context.reader);
    resolveShareScope(project, input.scope);
    const { grants, content } = await readShareGrants(context.reader);
    const { grant, rawToken } = createShareGrant(input);
    const next = [...grants, grant];
    const operation = await makeMetadataOperation(context, SHARE_GRANTS_PATH, sortedGrantContent(next), content ? "Create read-only publication share" : "Create read-only publication share index");
    const proposal = await context.propose([operation]);
    return {
      share: safeShareGrant(grant),
      token: rawToken,
      proposalId: proposal.id,
      activation: "This link becomes readable only after author approval and a confirmed publish.",
    };
  }));

  actions.push(defineAction(valueSchema(parseShareRevokeInput), "publishing.shares.revoke", "propose", async (input, context) => {
    const existing = await readShareGrants(context.reader);
    const index = existing.grants.findIndex((grant) => grant.id === input.id);
    if (index < 0) throw new Error("Share grant not found");
    const prior = existing.grants[index]!;
    if (!prior.revokedAt) {
      existing.grants[index] = {
        ...prior,
        grantVersion: prior.grantVersion + 1,
        revocationVersion: prior.revocationVersion + 1,
        revokedAt: new Date().toISOString(),
      };
    }
    const operation = await makeMetadataOperation(context, SHARE_GRANTS_PATH, sortedGrantContent(existing.grants), "Revoke read-only publication share");
    const proposal = await context.propose([operation]);
    return { id: input.id, revokedAt: existing.grants[index]!.revokedAt, proposalId: proposal.id, activation: "Revocation reaches public readers after the change is approved and published." };
  }));

  return actions;
}
