import { assertChangeOperation } from "@scriptorium/contracts";
import { planGeneratedFileImport, stableMigrationId, type MigrationContribution, type MigrationContext, type MigrationProducer } from "@scriptorium/migration";
import YAML from "yaml";
import { EPISODES_PATH } from "./episodes.js";
import { normalizeShareScope, readShareGrants, SHARE_GRANTS_PATH } from "./grants.js";

const LEGACY_EPISODES_PATH = "meta/scriptorium/modules/publishing/legacy/files/meta/publish-episodes.yaml";
const LEGACY_GRANTS_PATH = "meta/scriptorium/modules/publishing/legacy/share-grants.jsonl";
const EPISODE_SOURCE_PATH = "meta/publish-episodes.yaml";
const SHARE_SOURCE_PATHS = ["app-state/share-tokens.json", "share-tokens.json"] as const;
const MAX_MIGRATION_OPERATION_LENGTH = 8 * 1024 * 1024;

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
  const source = await context.source.readProjectFile(EPISODE_SOURCE_PATH);
  if (!source) return { entries: [], operations: [], recovery: [] };
  let count: number;
  try {
    count = validateEpisodeMap(YAML.parse(source.toString("utf8")));
  } catch (error) {
    return {
      entries: [{
        producerId: "publishing",
        source: EPISODE_SOURCE_PATH,
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
      source: EPISODE_SOURCE_PATH,
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

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function safeRetainedGrant(value: unknown, repositoryId: string): Record<string, unknown> | null {
  if (!isRecord(value) || typeof value.id !== "string" || !value.id.trim() ||
      value.projectId !== repositoryId || typeof value.scope !== "string" && !isRecord(value.scope) ||
      typeof value.label !== "string" ||
      typeof value.tokenHash !== "string" || !/^[a-f0-9]{64}$/i.test(value.tokenHash) ||
      typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt)) ||
      typeof value.expiresAt !== "string" || !Number.isFinite(Date.parse(value.expiresAt)) ||
      (value.lastUsedAt !== undefined && typeof value.lastUsedAt !== "string") ||
      (value.revokedAt !== undefined && typeof value.revokedAt !== "string")) return null;
  const normalizedScope = normalizeShareScope(value.scope);
  if (!normalizedScope) return null;

  // The disabled producer stores only this descriptor. Re-apply its allowlist
  // here and rebuild object scopes so nested extension data cannot reactivate
  // a bearer or host authority. Preserve legacy string scopes byte-for-byte.
  return {
    id: value.id,
    projectId: value.projectId,
    scope: typeof value.scope === "string" ? value.scope : normalizedScope,
    label: value.label,
    tokenHash: value.tokenHash,
    createdAt: value.createdAt,
    expiresAt: value.expiresAt,
    ...(typeof value.lastUsedAt === "string" ? { lastUsedAt: value.lastUsedAt } : {}),
    ...(typeof value.revokedAt === "string" ? { revokedAt: value.revokedAt } : {}),
  };
}

function withRetainedSourceGuard(
  operation: import("@scriptorium/contracts").ChangeOperation,
  sourcePath: string,
  sourceRevision: string,
) {
  const guarded = {
    ...operation,
    id: stableMigrationId(`${operation.id}\0${sourcePath}\0${sourceRevision}`),
    reads: [...operation.reads, { path: sourcePath, revision: sourceRevision }],
  };
  assertChangeOperation(guarded);
  return guarded;
}

function reactivationEntry(input: {
  source: string;
  target: string;
  disposition: "planned" | "unchanged" | "conflict" | "blocked";
  detail: string;
  recordCount?: number;
}) {
  return {
    producerId: "publishing",
    source: input.source,
    target: input.target,
    category: "authoritative" as const,
    disposition: input.disposition,
    ...(input.recordCount === undefined ? {} : { recordCount: input.recordCount }),
    detail: input.detail,
  };
}

async function inspectRetainedEpisodes(context: MigrationContext): Promise<MigrationContribution> {
  const result: MigrationContribution = { entries: [], operations: [], recovery: [] };
  const retained = await context.target.read(LEGACY_EPISODES_PATH);
  if (!retained) return result;

  let recordCount: number;
  try {
    recordCount = validateEpisodeMap(YAML.parse(retained.content));
  } catch (error) {
    result.entries.push(reactivationEntry({
      source: LEGACY_EPISODES_PATH,
      target: EPISODES_PATH,
      disposition: "blocked",
      detail: error instanceof Error ? error.message : "Retained publication map cannot be read semantically; no bytes were changed.",
    }));
    return result;
  }

  const existing = await context.target.read(EPISODES_PATH);
  if (existing?.content === retained.content) {
    result.entries.push(reactivationEntry({
      source: LEGACY_EPISODES_PATH,
      target: EPISODES_PATH,
      disposition: "unchanged",
      recordCount,
      detail: "The canonical episode map already matches the retained bytes exactly.",
    }));
    return result;
  }
  if (existing) {
    result.entries.push(reactivationEntry({
      source: LEGACY_EPISODES_PATH,
      target: EPISODES_PATH,
      disposition: "conflict",
      recordCount,
      detail: "A different canonical episode map already exists; retained bytes were not allowed to overwrite it.",
    }));
    return result;
  }
  if (retained.content.length > MAX_MIGRATION_OPERATION_LENGTH) {
    result.entries.push(reactivationEntry({
      source: LEGACY_EPISODES_PATH,
      target: EPISODES_PATH,
      disposition: "blocked",
      recordCount,
      detail: "Retained episode map exceeds the ChangeOperation size limit; no bytes were changed.",
    }));
    return result;
  }

  const planned = await planGeneratedFileImport({
    context,
    producerId: "publishing-reactivation",
    source: LEGACY_EPISODES_PATH,
    target: EPISODES_PATH,
    category: "authoritative",
    content: retained.content,
    detail: "Restore the exact retained Publishing episode-map bytes through a revision-guarded Core proposal.",
    message: "Reactivate retained Publishing episode map",
    existing,
  });
  result.entries.push(reactivationEntry({
    source: LEGACY_EPISODES_PATH,
    target: EPISODES_PATH,
    disposition: planned.entry.disposition === "planned" ? "planned" : "unchanged",
    recordCount,
    detail: planned.entry.detail ?? "Retained episode map is ready for reactivation.",
  }));
  if (planned.operation) {
    result.operations.push(withRetainedSourceGuard(planned.operation, LEGACY_EPISODES_PATH, retained.revision));
  }
  return result;
}

async function inspectRetainedGrants(context: MigrationContext): Promise<MigrationContribution> {
  const result: MigrationContribution = { entries: [], operations: [], recovery: [] };
  const retained = await context.target.read(LEGACY_GRANTS_PATH);
  if (!retained) return result;

  const grantsById = new Map<string, Record<string, unknown>>();
  for (const [index, line] of retained.content.split(/\r?\n/u).entries()) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch {
      result.entries.push(reactivationEntry({
        source: LEGACY_GRANTS_PATH,
        target: SHARE_GRANTS_PATH,
        disposition: "blocked",
        detail: `Retained share-grant JSONL is malformed at line ${index + 1}; no grant was restored.`,
      }));
      return result;
    }
    const grant = safeRetainedGrant(parsed, context.repository.repositoryId);
    if (!grant) {
      result.entries.push(reactivationEntry({
        source: LEGACY_GRANTS_PATH,
        target: SHARE_GRANTS_PATH,
        disposition: "blocked",
        detail: `Retained share-grant descriptor at line ${index + 1} is invalid for this repository; no grant was restored.`,
      }));
      return result;
    }
    const prior = grantsById.get(grant.id as string);
    if (prior && canonicalJson(prior) !== canonicalJson(grant)) {
      result.entries.push(reactivationEntry({
        source: LEGACY_GRANTS_PATH,
        target: SHARE_GRANTS_PATH,
        disposition: "conflict",
        detail: `Retained share grant ${String(grant.id)} has conflicting duplicate descriptors; no grant was restored.`,
      }));
      return result;
    }
    grantsById.set(grant.id as string, grant);
  }

  const sourceGrants = [...grantsById.values()].sort((left, right) => String(left.id).localeCompare(String(right.id)));
  if (sourceGrants.length === 0) {
    result.entries.push(reactivationEntry({
      source: LEGACY_GRANTS_PATH,
      target: SHARE_GRANTS_PATH,
      disposition: "unchanged",
      recordCount: 0,
      detail: "The retained grant list is empty; no public descriptor was restored.",
    }));
    return result;
  }

  const existing = await context.target.read(SHARE_GRANTS_PATH);
  try {
    await readShareGrants(context.target);
  } catch {
    result.entries.push(reactivationEntry({
      source: LEGACY_GRANTS_PATH,
      target: SHARE_GRANTS_PATH,
      disposition: "conflict",
      recordCount: sourceGrants.length,
      detail: "The canonical share-grant JSONL is malformed; retained grants were not merged into it.",
    }));
    return result;
  }

  const existingById = new Map<string, Record<string, unknown>>();
  try {
    for (const line of (existing?.content ?? "").split(/\r?\n/u).filter((item) => item.trim())) {
      const value: unknown = JSON.parse(line);
      if (!isRecord(value) || typeof value.id !== "string" || !value.id.trim()) throw new Error("Missing share grant ID");
      const sensitiveField = Object.keys(value).some((key) => key !== "tokenHash" && /owner|user|token|bearer|secret|credential|auth/iu.test(key));
      if (sensitiveField) throw new Error("Canonical share grant contains a secret or host-owned field");
      existingById.set(value.id, value);
    }
  } catch {
    result.entries.push(reactivationEntry({
      source: LEGACY_GRANTS_PATH,
      target: SHARE_GRANTS_PATH,
      disposition: "conflict",
      recordCount: sourceGrants.length,
      detail: "The canonical share-grant file contains unsafe or ambiguous rows; retained grants were not copied into the proposal.",
    }));
    return result;
  }

  for (const grant of sourceGrants) {
    const prior = existingById.get(grant.id as string);
    if (prior && canonicalJson(prior) !== canonicalJson(grant)) {
      result.entries.push(reactivationEntry({
        source: LEGACY_GRANTS_PATH,
        target: SHARE_GRANTS_PATH,
        disposition: "conflict",
        recordCount: sourceGrants.length,
        detail: `Share grant ${String(grant.id)} already has different canonical metadata; no target content was overwritten.`,
      }));
      return result;
    }
  }

  const additions = sourceGrants.filter((grant) => !existingById.has(grant.id as string));
  if (additions.length === 0) {
    result.entries.push(reactivationEntry({
      source: LEGACY_GRANTS_PATH,
      target: SHARE_GRANTS_PATH,
      disposition: "unchanged",
      recordCount: sourceGrants.length,
      detail: "All retained hashed grants already exist with matching full descriptors.",
    }));
    return result;
  }

  const prefix = existing?.content ?? "";
  const content = `${prefix}${prefix && !prefix.endsWith("\n") ? "\n" : ""}${additions.map((grant) => JSON.stringify(grant)).join("\n")}\n`;
  if (content.length > MAX_MIGRATION_OPERATION_LENGTH) {
    result.entries.push(reactivationEntry({
      source: LEGACY_GRANTS_PATH,
      target: SHARE_GRANTS_PATH,
      disposition: "blocked",
      recordCount: sourceGrants.length,
      detail: "The merged share-grant file exceeds the ChangeOperation size limit; no grant was restored.",
    }));
    return result;
  }

  const planned = await planGeneratedFileImport({
    context,
    producerId: "publishing-reactivation",
    source: LEGACY_GRANTS_PATH,
    target: SHARE_GRANTS_PATH,
    category: "authoritative",
    content,
    detail: `Restore ${additions.length} retained hashed grant descriptor(s) through a revision-guarded Core proposal; raw bearers remain excluded.`,
    message: "Reactivate retained Publishing share grants",
    existing,
  });
  result.entries.push(reactivationEntry({
    source: LEGACY_GRANTS_PATH,
    target: SHARE_GRANTS_PATH,
    disposition: planned.entry.disposition === "planned" ? "planned" : "unchanged",
    recordCount: sourceGrants.length,
    detail: planned.entry.detail ?? "Retained share grants are ready for reactivation.",
  }));
  if (planned.operation) {
    result.operations.push(withRetainedSourceGuard(planned.operation, LEGACY_GRANTS_PATH, retained.revision));
  }
  return result;
}

async function inspectReactivation(context: MigrationContext): Promise<MigrationContribution> {
  const result: MigrationContribution = { entries: [], operations: [], recovery: [] };
  if (!context.enabledModules.has("publishing")) return result;

  // Live sources always belong to the generic importer. Check the workspace
  // index only; do not re-read or include the secret-bearing source contents.
  const [liveEpisodeMap, workspaceFiles] = await Promise.all([
    context.source.readProjectFile(EPISODE_SOURCE_PATH),
    context.source.workspaceDataRoot ? context.source.listWorkspaceFiles("") : Promise.resolve([]),
  ]);
  const liveWorkspaceShares = workspaceFiles.some((path) => (SHARE_SOURCE_PATHS as readonly string[]).includes(path));
  const [episodes, grants] = await Promise.all([
    liveEpisodeMap ? Promise.resolve({ entries: [], operations: [], recovery: [] } as MigrationContribution) : inspectRetainedEpisodes(context),
    liveWorkspaceShares ? Promise.resolve({ entries: [], operations: [], recovery: [] } as MigrationContribution) : inspectRetainedGrants(context),
  ]);
  result.entries.push(...episodes.entries, ...grants.entries);
  result.operations.push(...episodes.operations, ...grants.operations);
  return result;
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
      const [episodes, shares, reactivation] = await Promise.all([
        inspectEpisodeMap(context),
        inspectShareStore(context),
        inspectReactivation(context),
      ]);
      return {
        entries: [...episodes.entries, ...shares.entries, ...reactivation.entries],
        operations: [...episodes.operations, ...shares.operations, ...reactivation.operations],
        recovery: [],
      };
    },
  };
}
