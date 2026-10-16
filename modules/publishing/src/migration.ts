import type { MigrationContribution, MigrationContext, MigrationProducer } from "@scriptorium/migration";
import YAML from "yaml";
import { EPISODES_PATH } from "./episodes.js";
import { normalizeShareScope } from "./grants.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validateEpisodeMap(data: unknown): number {
  if (!isRecord(data) || (data.episodes !== undefined && !Array.isArray(data.episodes))) {
    throw new Error("Publication map must be a mapping with an episodes array");
  }
  const episodes = data.episodes as unknown[] | undefined ?? [];
  for (const [index, value] of episodes.entries()) {
    if (!isRecord(value) || typeof value.id !== "string" || !value.id.trim() ||
        typeof value.number !== "number" || !Number.isSafeInteger(value.number) || value.number < 1 ||
        typeof value.title !== "string" || (value.scope !== "volume" && value.scope !== "chapter") ||
        typeof value.scopeId !== "string" || !value.scopeId.trim() ||
        (value.publishedAt !== undefined && typeof value.publishedAt !== "string") ||
        (value.sceneIds !== undefined && (!Array.isArray(value.sceneIds) || value.sceneIds.some((id) => typeof id !== "string")))) {
      throw new Error("Invalid publication episode at index " + index);
    }
  }
  return episodes.length;
}

async function inspectEpisodeMap(context: MigrationContext): Promise<MigrationContribution> {
  const source = await context.source.readProjectFile("meta/publish-episodes.yaml");
  if (!source) return { entries: [], operations: [], recovery: [] };
  let count: number;
  try {
    count = validateEpisodeMap(YAML.parse(source.toString("utf8")));
  } catch (error) {
    return {
      entries: [{
        producerId: "publishing",
        source: "meta/publish-episodes.yaml",
        target: context.enabledModules.has("publishing") ? EPISODES_PATH : "meta/scriptorium/modules/publishing/legacy/files/meta/publish-episodes.yaml",
        category: "authoritative",
        disposition: "blocked",
        detail: error instanceof Error ? error.message : "Publication map cannot be read semantically; exact source bytes remain available for review.",
      }],
      operations: [],
      recovery: [],
    };
  }

  const target = context.enabledModules.has("publishing")
    ? EPISODES_PATH
    : "meta/scriptorium/modules/publishing/legacy/files/meta/publish-episodes.yaml";
  const existing = await context.target.read(target);
  const exact = existing?.content === source.toString("utf8");
  return {
    entries: [{
      producerId: "publishing",
      source: "meta/publish-episodes.yaml",
      target,
      category: "authoritative",
      disposition: exact ? "unchanged" : context.enabledModules.has("publishing") ? "planned" : "preserved-unreadable",
      recordCount: count,
      detail: exact
        ? "The episode map round-trips through the module reader with all dates and unknown YAML fields intact."
        : "Semantic validation passed; the generic filesystem producer owns the exact-byte guarded import so comments, dates, and unknown YAML fields remain unchanged.",
    }],
    operations: [],
    recovery: [],
  };
}

interface LegacyShareRecord extends Record<string, unknown> {
  id: string;
  projectId: string;
  scope: string;
  label: string;
  tokenHash: string;
  createdAt: string;
  expiresAt: string;
}

function isLegacyShare(value: unknown): value is LegacyShareRecord {
  return isRecord(value) && typeof value.id === "string" && Boolean(value.id) &&
    typeof value.projectId === "string" && typeof value.scope === "string" &&
    Boolean(normalizeShareScope(value.scope)) && typeof value.label === "string" &&
    typeof value.tokenHash === "string" && /^[a-f0-9]{64}$/i.test(value.tokenHash) &&
    typeof value.createdAt === "string" && Number.isFinite(Date.parse(value.createdAt)) &&
    typeof value.expiresAt === "string" && Number.isFinite(Date.parse(value.expiresAt));
}

async function inspectShareStore(context: MigrationContext): Promise<MigrationContribution> {
  if (!context.source.workspaceDataRoot) return { entries: [], operations: [], recovery: [] };
  const sourcePath = (await context.source.readWorkspaceFile("app-state/share-tokens.json"))
    ? "app-state/share-tokens.json"
    : "share-tokens.json";
  const bytes = await context.source.readWorkspaceFile(sourcePath);
  if (!bytes) return { entries: [], operations: [], recovery: [] };
  if (!context.workspaceProjectId) {
    return {
      entries: [{ producerId: "publishing", source: sourcePath, category: "authoritative", disposition: "blocked", detail: "An explicit legacy project ID is required to select publishing grants; source records were left untouched." }],
      operations: [],
      recovery: [],
    };
  }
  let parsed: unknown;
  try { parsed = JSON.parse(bytes.toString("utf8")); } catch {
    return { entries: [{ producerId: "publishing", source: sourcePath, category: "authoritative", disposition: "blocked", detail: "Share-token store is malformed; source was left untouched." }], operations: [], recovery: [] };
  }
  if (!Array.isArray(parsed)) {
    return { entries: [{ producerId: "publishing", source: sourcePath, category: "authoritative", disposition: "blocked", detail: "Share-token store does not contain a record array; source was left untouched." }], operations: [], recovery: [] };
  }
  const selected = parsed.filter((record) => isRecord(record) && record.projectId === context.workspaceProjectId);
  const invalid = selected.filter((record) => !isLegacyShare(record));
  const target = context.enabledModules.has("publishing")
    ? "meta/scriptorium/modules/publishing/share-grants.jsonl"
    : "meta/scriptorium/modules/publishing/legacy/share-grants.jsonl";
  if (invalid.length) {
    return {
      entries: [{ producerId: "publishing", source: sourcePath, target, category: "authoritative", disposition: "blocked", recordCount: invalid.length, detail: "One or more selected grants lack the source contract's bounded scope, token hash, or valid dates; no publishing grants were activated." }],
      operations: [],
      recovery: [],
    };
  }
  return {
    entries: [{
      producerId: "publishing",
      source: sourcePath,
      target,
      category: "authoritative",
      disposition: selected.length ? "planned" : "unchanged",
      recordCount: selected.length,
      detail: selected.length
        ? "Semantic validation passed for selected hashed grants. The generic workspace producer owns target writes and retains scope, label, SHA-256 hash, creation/expiry/use/revocation dates; owner identity and bearer prefix remain host-only."
        : "No grants match the explicit legacy project ID.",
    }],
    operations: [],
    recovery: [],
  };
}

export function createPublishingMigrationProducer(): MigrationProducer {
  return {
    id: "publishing",
    moduleId: "publishing",
    async inspect(context) {
      const [episodes, shares] = await Promise.all([inspectEpisodeMap(context), inspectShareStore(context)]);
      return {
        entries: [...episodes.entries, ...shares.entries],
        operations: [],
        recovery: [],
      };
    },
  };
}
