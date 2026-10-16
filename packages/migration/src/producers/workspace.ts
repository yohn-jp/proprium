import type { MigrationContext, MigrationContribution, MigrationProducer } from "../types.js";
import { planGeneratedFileImport, stableMigrationId } from "../operations.js";

const WORKSPACE_FILES: Array<{ path: string; category: "relocated" | "secret"; detail: string }> = [
  { path: "app-state/projects.json", category: "relocated", detail: "Project bindings and clone locations are host configuration, not work metadata." },
  { path: "projects.json", category: "relocated", detail: "Legacy project registry alias; target host re-registers repositories." },
  { path: "app-state/series.json", category: "relocated", detail: "Series registry includes host owner/project bindings; target host configuration owns it." },
  { path: "series.json", category: "relocated", detail: "Legacy series registry alias; target host configuration owns it." },
  { path: "app-state/recent-activity.json", category: "relocated", detail: "Per-user recent-activity cursors are device/workspace state." },
  { path: "recent-activity.json", category: "relocated", detail: "Legacy recent-activity registry alias; it is device/workspace state." },
  { path: "app-state/users.json", category: "secret", detail: "User identities and login authority are host-managed and are not imported." },
  { path: "users.json", category: "secret", detail: "Legacy user identity registry; target authentication is reissued by the host." },
  { path: "app-state/sessions.json", category: "secret", detail: "Session identifiers are host credentials and are not imported." },
  { path: "sessions.json", category: "secret", detail: "Legacy session registry; target sessions are reissued." },
  { path: "app-state/personal-tokens.json", category: "secret", detail: "Personal API token hashes and bearer-token metadata are host credentials." },
  { path: "personal-tokens.json", category: "secret", detail: "Legacy personal-token registry; target tokens are reissued." },
  { path: "secrets/project-secrets.enc", category: "secret", detail: "Encrypted GitHub credentials are excluded and must be reissued by the host." },
  { path: "secrets/user-secrets.enc", category: "secret", detail: "Encrypted user credentials are excluded and must be reissued by the host." },
  { path: "secrets/secrets.key", category: "secret", detail: "Encryption key material is excluded." },
];

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function safeShareGrant(value: unknown, legacyProjectId: string, targetProjectId: string): Record<string, unknown> | null {
  if (!isRecord(value) || value.projectId !== legacyProjectId) return null;
  if (typeof value.id !== "string" || typeof value.tokenHash !== "string" || !/^[a-f0-9]{64}$/i.test(value.tokenHash)) return null;
  if (typeof value.scope !== "string" || typeof value.label !== "string" || typeof value.createdAt !== "string" || typeof value.expiresAt !== "string") return null;
  return {
    id: value.id,
    projectId: targetProjectId,
    scope: value.scope,
    label: value.label,
    tokenHash: value.tokenHash,
    createdAt: value.createdAt,
    expiresAt: value.expiresAt,
    ...(typeof value.lastUsedAt === "string" ? { lastUsedAt: value.lastUsedAt } : {}),
    ...(typeof value.revokedAt === "string" ? { revokedAt: value.revokedAt } : {}),
  };
}

async function inspectShareGrants(context: MigrationContext): Promise<MigrationContribution> {
  const result: MigrationContribution = { entries: [], operations: [], recovery: [] };
  const sourcePath = (await context.source.readWorkspaceFile("app-state/share-tokens.json"))
    ? "app-state/share-tokens.json"
    : "share-tokens.json";
  const bytes = await context.source.readWorkspaceFile(sourcePath);
  if (!bytes) return result;

  // Never parse/copy grant records without an explicit legacy project selector.
  if (!context.workspaceProjectId) {
    result.entries.push({
      producerId: "workspace",
      source: sourcePath,
      category: "authoritative",
      disposition: "blocked",
      detail: "A legacy workspace project ID is required to select share grants; no workspace records were imported.",
    });
    return result;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    result.entries.push({
      producerId: "workspace",
      source: sourcePath,
      category: "authoritative",
      disposition: "blocked",
      detail: "Share-token store is malformed; source was left untouched.",
    });
    return result;
  }
  if (!Array.isArray(parsed)) {
    result.entries.push({
      producerId: "workspace",
      source: sourcePath,
      category: "authoritative",
      disposition: "blocked",
      detail: "Share-token store does not contain a record array; source was left untouched.",
    });
    return result;
  }
  const selected = parsed.map((value) => safeShareGrant(value, context.workspaceProjectId!, context.repository.repositoryId));
  const invalid = parsed.filter((value) => isRecord(value) && value.projectId === context.workspaceProjectId).length - selected.filter(Boolean).length;
  if (invalid > 0) {
    result.entries.push({
      producerId: "workspace",
      source: sourcePath,
      category: "authoritative",
      disposition: "blocked",
      recordCount: invalid,
      detail: "One or more selected share grants lack a stable ID, token hash, or supported metadata shape; none of those grants was copied.",
    });
  }
  const grants = selected.filter((grant): grant is Record<string, unknown> => grant !== null)
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
  if (grants.length === 0) {
    result.entries.push({
      producerId: "workspace",
      source: sourcePath,
      target: "meta/scriptorium/modules/publishing/share-grants.jsonl",
      category: "authoritative",
      disposition: invalid > 0 ? "blocked" : "unchanged",
      recordCount: 0,
      detail: "No share grant matched the explicit legacy workspace project ID.",
    });
    return result;
  }

  if (!context.enabledModules.has("publishing")) {
    const target = "meta/scriptorium/modules/publishing/legacy/share-grants.jsonl";
    const content = grants.map((grant) => JSON.stringify(grant)).join("\n") + "\n";
    const opaque = await planGeneratedFileImport({
      context,
      producerId: "workspace-disabled",
      source: sourcePath,
      target,
      category: "authoritative",
      content,
      detail: "Preserve selected hashed grant descriptors in module-owned versioned legacy data; records remain unreadable until publishing is enabled.",
      message: "Preserve disabled publishing legacy grants",
    });
    if (opaque.entry.disposition === "planned" || opaque.entry.disposition === "unchanged") {
      opaque.entry.disposition = "preserved-unreadable";
    }
    result.entries.push({
      producerId: "workspace",
      source: sourcePath,
      target,
      category: "authoritative",
      disposition: opaque.entry.disposition,
      recordCount: grants.length,
      detail: "Publishing is disabled; selected hashed grant descriptors are preserved and unreadable until re-enabled. Raw bearer values, token prefixes, owner IDs, and unrelated project grants are excluded.",
    });
    if (opaque.operation) result.operations.push(opaque.operation);
    return result;
  }

  const target = "meta/scriptorium/modules/publishing/share-grants.jsonl";
  const existing = await context.target.read(target);
  const records = new Map<string, string>();
  try {
    for (const line of existing?.content.split("\n").filter((item) => item.trim()) ?? []) {
      const record: unknown = JSON.parse(line);
      if (!isRecord(record) || typeof record.id !== "string") throw new Error("invalid share grant JSONL");
      records.set(record.id, canonicalJson(record));
    }
  } catch {
    result.entries.push({
      producerId: "workspace",
      source: sourcePath,
      target,
      category: "authoritative",
      disposition: "conflict",
      recordCount: grants.length,
      detail: "Existing share grant JSONL is malformed or has no stable IDs; no target content was overwritten.",
    });
    return result;
  }

  for (const grant of grants) {
    const prior = records.get(String(grant.id));
    const current = canonicalJson(grant);
    if (prior !== undefined && prior !== current) {
      result.entries.push({
        producerId: "workspace",
        source: sourcePath,
        target,
        category: "authoritative",
        disposition: "conflict",
        recordCount: grants.length,
        detail: `Share grant ${String(grant.id)} already exists with different metadata; no target content was overwritten.`,
      });
      return result;
    }
  }
  const additions = grants.filter((grant) => !records.has(String(grant.id)));
  if (additions.length === 0) {
    result.entries.push({
      producerId: "workspace",
      source: sourcePath,
      target,
      category: "authoritative",
      disposition: "unchanged",
      recordCount: grants.length,
      detail: "All selected share grant IDs already exist with matching hashed descriptors.",
    });
    return result;
  }
  const content = `${existing?.content ?? ""}${existing?.content && !existing.content.endsWith("\n") ? "\n" : ""}${additions.map((grant) => JSON.stringify(grant)).join("\n")}\n`;
  const planned = await planGeneratedFileImport({
    context,
    producerId: "workspace",
    source: sourcePath,
    target,
    category: "authoritative",
    content,
    detail: `Import ${additions.length} selected hashed share grant descriptor(s); activation still requires a confirmed publish.`,
    message: "Import legacy publication share grants",
    existing,
  });
  result.entries.push(planned.entry);
  if (planned.operation) result.operations.push(planned.operation);
  return result;
}

function classifyUnlisted(path: string): { category: "secret" | "relocated" | "provisional"; disposition: "excluded" | "relocated" | "unclassified" | "deferred"; detail: string } {
  if (path.startsWith("secrets/") || /(?:token|credential|secret|session)/i.test(path)) {
    return { category: "secret", disposition: "excluded", detail: "Workspace credential/secret state is excluded; source was not read or modified." };
  }
  if (path.startsWith("mutation-receipts/")) {
    return { category: "provisional", disposition: "deferred", detail: "Legacy idempotency receipts stay in the old workspace until pending mutation outcomes are reconciled." };
  }
  if (path.startsWith("app-state/") || path.startsWith("database/") || path.startsWith("index/") || path.startsWith("recoverable-cache/")) {
    return { category: "relocated", disposition: "relocated", detail: "Workspace/device state is host-owned or reconstructible and is not versioned with the work." };
  }
  return { category: "relocated", disposition: "unclassified", detail: "No generic workspace importer owns this file; leave it in place and register an owner before removing the legacy data root." };
}

export function createWorkspaceProducer(): MigrationProducer {
  return {
    id: "workspace",
    async inspect(context: MigrationContext): Promise<MigrationContribution> {
      const result: MigrationContribution = { entries: [], operations: [], recovery: [] };
      if (!context.source.workspaceDataRoot) return result;
      const files = await context.source.listWorkspaceFiles("");
      const known = new Map(WORKSPACE_FILES.map((item) => [item.path, item]));
      for (const file of files) {
        if (file === "app-state/share-tokens.json" || file === "share-tokens.json") continue;
        const item = known.get(file);
        if (item) {
          result.entries.push({
            producerId: "workspace",
            source: file,
            category: item.category,
            disposition: item.category === "secret" ? "excluded" : "relocated",
            detail: item.detail,
          });
          continue;
        }
        const classification = classifyUnlisted(file);
        result.entries.push({ producerId: "workspace", source: file, ...classification });
      }
      const grants = await inspectShareGrants(context);
      result.entries.push(...grants.entries);
      result.operations.push(...grants.operations);
      result.recovery.push(...grants.recovery);
      return result;
    },
  };
}
