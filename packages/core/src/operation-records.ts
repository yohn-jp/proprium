import { createHash } from "node:crypto";
import {
  MAX_PROPOSAL_EVIDENCE_BYTES,
  assertChangeOperation,
  assertProjectPath,
  snapshotKey,
  type ChangeOperation,
  type ChangeProposal,
  type SnapshotId,
} from "@scriptorium/contracts";

export const MAX_PROPOSAL_BYTES = 8 * 1024 * 1024;

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function isSnapshotId(value: unknown): value is SnapshotId {
  const snapshot = asRecord(value);
  const repository = snapshot ? asRecord(snapshot.repository) : null;
  return !!snapshot && !!repository &&
    (repository.provider === "github" || repository.provider === "local") &&
    [repository.repositoryId, repository.defaultBranch, repository.ownerScope, repository.url].every((item) => typeof item === "string" && item.length > 0) &&
    typeof snapshot.remoteCommit === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64}|)$/.test(snapshot.remoteCommit) &&
    (snapshot.overlayCommit === undefined || (typeof snapshot.overlayCommit === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(snapshot.overlayCommit)));
}

export function canonicalJson(value: unknown): string {
  const normalize = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(normalize);
    const record = asRecord(item);
    if (record) {
      return Object.fromEntries(Object.keys(record).sort().map((key) => [key, normalize(record[key])]));
    }
    return item;
  };
  return JSON.stringify(normalize(value));
}

export function isJsonValue(value: unknown, active = new WeakSet<object>(), depth = 0): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || depth > 32) return false;
  if (active.has(value)) return false;
  if (!Array.isArray(value)) {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
  }
  active.add(value);
  const valid = Array.isArray(value)
    ? value.every((item) => isJsonValue(item, active, depth + 1))
    : Object.values(value as Record<string, unknown>).every((item) => isJsonValue(item, active, depth + 1));
  active.delete(value);
  return valid;
}

export function assertUserOperationPaths(operation: ChangeOperation): void {
  const reserved = ["meta/scriptorium/operations", "meta/scriptorium/publications", "meta/scriptorium/proposals"];
  for (const write of operation.writes) {
    const filePath = write.path.toLowerCase();
    if (reserved.some((root) => filePath === root || filePath.startsWith(`${root}/`))) {
      throw new Error("Change operations cannot modify Core authority metadata");
    }
    if (write.encoding === "base64" && Buffer.from(write.content ?? "", "base64").toString("base64") !== write.content) {
      throw new Error("Binary change content must use canonical base64 encoding");
    }
  }
}

export function normalizedOperation(operation: ChangeOperation): ChangeOperation {
  return {
    id: operation.id,
    generation: operation.generation,
    repository: {
      provider: operation.repository.provider,
      repositoryId: operation.repository.repositoryId,
      defaultBranch: operation.repository.defaultBranch,
      ownerScope: operation.repository.ownerScope,
      url: operation.repository.url,
    },
    baseRemoteCommit: operation.baseRemoteCommit,
    effect: operation.effect,
    reads: operation.reads.map(({ path, revision }) => ({ path, revision })),
    ...(operation.readScopes === undefined ? {} : {
      readScopes: operation.readScopes.map(({ prefix, revision }) => ({ prefix, revision })),
    }),
    writes: operation.writes.map((change) => ({
      path: change.path,
      revision: change.revision,
      content: change.content,
      ...(change.encoding === undefined ? {} : { encoding: change.encoding }),
    })),
    message: operation.message,
    ...(operation.evidenceIds === undefined ? {} : { evidenceIds: [...operation.evidenceIds] }),
  };
}

export function operationDigest(operation: ChangeOperation): string {
  return createHash("sha256").update(JSON.stringify(normalizedOperation(operation))).digest("hex");
}

export function normalizedProposal(proposal: ChangeProposal): ChangeProposal {
  return {
    id: proposal.id,
    snapshot: structuredClone(proposal.snapshot),
    operations: proposal.operations.map(normalizedOperation),
    source: proposal.source,
    ...(proposal.evidence?.length ? { evidence: structuredClone(proposal.evidence) } : {}),
  };
}

export function proposalDigest(proposal: ChangeProposal): string {
  return createHash("sha256").update(canonicalJson(normalizedProposal(proposal))).digest("hex");
}

export function assertPersistedProposal(value: unknown): asserts value is ChangeProposal {
  const proposal = asRecord(value);
  if (!proposal || typeof proposal.id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(proposal.id) ||
      !isSnapshotId(proposal.snapshot) || !Array.isArray(proposal.operations) || !proposal.operations.length ||
      proposal.operations.length > 256 || !["author", "module", "mcp"].includes(proposal.source as string)) {
    throw new Error("Invalid proposal envelope");
  }
  const operationIds = new Set<string>();
  for (const candidate of proposal.operations) {
    assertChangeOperation(candidate);
    assertUserOperationPaths(candidate);
    const operation = candidate as ChangeOperation;
    if (operationIds.has(operation.id) || operation.baseRemoteCommit !== (proposal.snapshot as SnapshotId).remoteCommit ||
        snapshotKey({ repository: operation.repository, remoteCommit: operation.baseRemoteCommit }) !==
          snapshotKey({ repository: (proposal.snapshot as SnapshotId).repository, remoteCommit: (proposal.snapshot as SnapshotId).remoteCommit })) {
      throw new Error("Proposal operation binding mismatch");
    }
    operationIds.add(operation.id);
  }
  const evidence = proposal.evidence ?? [];
  if (!Array.isArray(evidence) || !isJsonValue(evidence) ||
      Buffer.byteLength(JSON.stringify(evidence), "utf8") > MAX_PROPOSAL_EVIDENCE_BYTES) {
    throw new Error("Invalid proposal evidence");
  }
  const evidenceIds = new Set<string>();
  for (const itemValue of evidence) {
    const item = asRecord(itemValue);
    if (!item || typeof item.id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(item.id) || evidenceIds.has(item.id) ||
        !isSnapshotId(item.snapshot) || snapshotKey(item.snapshot) !== snapshotKey(proposal.snapshot as SnapshotId) ||
        !["story", "diagnostics", "nlp", "semantic", "speaker", "assistant", "publishing", "mcp"].includes(item.module as string) ||
        typeof item.kind !== "string" || !item.kind.trim() || item.kind.length > 128 || !Array.isArray(item.paths) || item.paths.length > 512 ||
        !Object.prototype.hasOwnProperty.call(item, "details")) {
      throw new Error("Invalid proposal evidence record");
    }
    for (const fileValue of item.paths) {
      const file = asRecord(fileValue);
      if (!file || typeof file.path !== "string" || (file.revision !== null &&
          (typeof file.revision !== "string" || !/^[a-f0-9]{64}$/.test(file.revision)))) {
        throw new Error("Invalid proposal evidence path");
      }
      assertProjectPath(file.path);
    }
    evidenceIds.add(item.id);
  }
  for (const candidate of proposal.operations) {
    const operation = candidate as ChangeOperation;
    if (operation.evidenceIds?.some((id) => !evidenceIds.has(id))) throw new Error("Missing proposal evidence reference");
  }
  if (Buffer.byteLength(JSON.stringify(normalizedProposal(proposal as unknown as ChangeProposal)), "utf8") > MAX_PROPOSAL_BYTES) {
    throw new Error("Persisted proposal exceeds its size limit");
  }
}
