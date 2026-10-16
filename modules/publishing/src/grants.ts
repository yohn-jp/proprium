import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { SnapshotReader } from "@scriptorium/contracts";
import type { ShareScope, ShareScopeKind } from "./project.js";

export const SHARE_GRANTS_PATH = "meta/scriptorium/modules/publishing/share-grants.jsonl";
export const MAX_SHARE_EXPIRY_HOURS = 3650 * 24;

export interface ShareGrant {
  version: 1;
  grantVersion: number;
  revocationVersion: number;
  id: string;
  tokenHash: string;
  tokenPrefix?: string;
  scope: ShareScope | string;
  label: string;
  createdAt: string;
  expiresAt: string;
  revokedAt?: string;
  lastUsedAt?: string;
  /** Unrecognized non-secret descriptor fields survive module edits and migration. */
  [field: string]: unknown;
}

export interface SafeShareGrant {
  id: string;
  scope: ShareScope | string;
  label: string;
  createdAt: string;
  expiresAt: string;
  revokedAt?: string;
  grantVersion: number;
  revocationVersion: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function normalizeShareScope(value: unknown): ShareScope | null {
  if (isRecord(value) && (value.kind === "project" || value.kind === "volume" || value.kind === "chapter" || value.kind === "scene") &&
      typeof value.id === "string" && value.id.trim()) {
    return { kind: value.kind as ShareScopeKind, id: value.id };
  }
  // Imported Arcadia grants use the entity's stable prefixed ID as a string.
  if (typeof value === "string") {
    if (!value.trim()) return { kind: "project", id: "*" };
    const match = /^(vol|ch|sc)-.+/.exec(value);
    if (match) {
      const kind: ShareScopeKind = match[1] === "vol" ? "volume" : match[1] === "ch" ? "chapter" : "scene";
      return { kind, id: value };
    }
  }
  return null;
}

function normalizeGrant(value: unknown): ShareGrant | null {
  if (!isRecord(value) || typeof value.id !== "string" || !value.id ||
      typeof value.tokenHash !== "string" || !/^[a-f0-9]{64}$/i.test(value.tokenHash) ||
      typeof value.label !== "string" || typeof value.createdAt !== "string" ||
      typeof value.expiresAt !== "string" || !normalizeShareScope(value.scope)) return null;
  const safeExtensions = Object.fromEntries(Object.entries(value).filter(([key]) =>
    !["id", "version", "grantVersion", "revocationVersion", "tokenHash", "scope", "label", "createdAt", "expiresAt", "revokedAt", "lastUsedAt"].includes(key) &&
    !/owner|user|token|bearer|secret|credential|auth/i.test(key)));
  return {
    ...safeExtensions,
    version: 1,
    grantVersion: Number.isSafeInteger(value.grantVersion) && Number(value.grantVersion) > 0 ? Number(value.grantVersion) : 1,
    revocationVersion: Number.isSafeInteger(value.revocationVersion) && Number(value.revocationVersion) >= 0 ? Number(value.revocationVersion) : 0,
    id: value.id,
    tokenHash: value.tokenHash.toLowerCase(),
    scope: normalizeShareScope(value.scope) ?? value.scope as string,
    label: value.label,
    createdAt: value.createdAt,
    expiresAt: value.expiresAt,
    ...(typeof value.revokedAt === "string" ? { revokedAt: value.revokedAt } : {}),
    ...(typeof value.lastUsedAt === "string" ? { lastUsedAt: value.lastUsedAt } : {}),
  };
}

export async function readShareGrants(reader: SnapshotReader): Promise<{ grants: ShareGrant[]; content: string; revision: string | null }> {
  const file = await reader.read(SHARE_GRANTS_PATH);
  const grants: ShareGrant[] = [];
  const seen = new Set<string>();
  for (const [index, line] of (file?.content ?? "").split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { throw new Error(`Invalid share grant JSONL at line ${index + 1}`); }
    const grant = normalizeGrant(parsed);
    if (!grant) throw new Error(`Invalid share grant descriptor at line ${index + 1}`);
    if (seen.has(grant.id)) throw new Error(`Duplicate share grant ID: ${grant.id}`);
    seen.add(grant.id);
    grants.push(grant);
  }
  return { grants, content: file?.content ?? "", revision: file?.revision ?? null };
}

export function hashShareToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function constantTimeHashMatches(expectedHash: string, actualHash: string): boolean {
  const expected = Buffer.from(expectedHash, "hex");
  const actual = Buffer.from(actualHash, "hex");
  return expected.length === 32 && actual.length === 32 && timingSafeEqual(expected, actual);
}

export function createShareGrant(input: {
  scope: ShareScope;
  label?: string;
  expiresInHours?: number;
  now?: Date;
}): { grant: ShareGrant; rawToken: string } {
  const hours = input.expiresInHours ?? 24;
  if (!Number.isFinite(hours) || hours <= 0 || hours > MAX_SHARE_EXPIRY_HOURS) {
    throw new Error(`expiresInHours must be positive and no greater than ${MAX_SHARE_EXPIRY_HOURS}`);
  }
  const now = input.now ?? new Date();
  const rawToken = `share_${randomBytes(32).toString("base64url")}`;
  const grant: ShareGrant = {
    version: 1,
    grantVersion: 1,
    revocationVersion: 0,
    id: randomUUID(),
    tokenHash: hashShareToken(rawToken),
    scope: input.scope,
    label: input.label?.trim().slice(0, 120) || "共有リンク",
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + hours * 60 * 60 * 1000).toISOString(),
  };
  return { grant, rawToken };
}

export function safeShareGrant(grant: ShareGrant): SafeShareGrant {
  return {
    id: grant.id,
    scope: grant.scope,
    label: grant.label,
    createdAt: grant.createdAt,
    expiresAt: grant.expiresAt,
    ...(grant.revokedAt ? { revokedAt: grant.revokedAt } : {}),
    grantVersion: grant.grantVersion,
    revocationVersion: grant.revocationVersion,
  };
}

export function serializeShareGrants(grants: ShareGrant[]): string {
  return grants.map((grant) => JSON.stringify(grant)).join("\n") + (grants.length ? "\n" : "");
}

export function grantIsActive(grant: ShareGrant, now = Date.now()): boolean {
  const expiresAt = Date.parse(grant.expiresAt);
  return !grant.revokedAt && Number.isFinite(expiresAt) && expiresAt > now;
}
