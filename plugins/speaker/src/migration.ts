import { sha256 } from "@noble/hashes/sha2.js";
import type { ChangeSet, FileOperation, ReadPrecondition, Scope, Snapshot } from "../../../app/src/browser/proprium/authoring/types.js";

// SPK-11 is exposed only as an inventory read and an explicit Host-reviewed
// proposal. This helper never mutates workspace files or applies the proposal.
export const SPEAKER_RECOVERY_FILES = [
  {
    id: "corrections",
    source_path: "meta/scriptorium/modules/speaker/corrections.jsonl",
    target_path: "meta/proprium/plugins/proprium.speaker/corrections.jsonl",
  },
  {
    id: "adopted-model",
    source_path: "meta/scriptorium/modules/speaker/adopted-model.json",
    target_path: "meta/proprium/plugins/proprium.speaker/adopted-model.json",
  },
] as const;

const DEFAULT_MAX_PROPOSAL_BYTES = 512 * 1024;

export type SpeakerRecoveryDisposition = "disabled" | "absent" | "unchanged" | "conflict" | "restore" | "blocked";

/** Exact bytes and revision returned by the Host's pinned file read. `revision: null` means absent. */
export interface SpeakerRecoveryFileState {
  path: string;
  revision: string | null;
  bytes: Uint8Array | null;
}

export interface SpeakerRecoveryInventoryEntry {
  id: (typeof SPEAKER_RECOVERY_FILES)[number]["id"];
  source_path: string;
  target_path: string;
  source_revision: string | null;
  target_revision: string | null;
  source_byte_length: number;
  target_byte_length: number | null;
  source_sha256: string | null;
  target_sha256: string | null;
  disposition: SpeakerRecoveryDisposition;
}

export interface SpeakerRecoveryPlan {
  inventory: SpeakerRecoveryInventoryEntry[];
  changeset: ChangeSet | null;
}

export interface PrepareSpeakerRecoveryInput {
  enabled: boolean;
  idempotency_key: string;
  scope: Scope;
  snapshot: Snapshot;
  files: readonly SpeakerRecoveryFileState[];
  max_proposal_bytes?: number;
}

function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}

function digest(bytes: Uint8Array): string {
  return [...sha256(bytes)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function stateMap(files: readonly SpeakerRecoveryFileState[]): Map<string, SpeakerRecoveryFileState> {
  const result = new Map<string, SpeakerRecoveryFileState>();
  for (const file of files) {
    if (result.has(file.path)) fail("ambiguous_identity", `Recovery inventory repeats ${file.path}`);
    if (file.revision === null ? file.bytes !== null : !(file.bytes instanceof Uint8Array)) {
      fail("unsupported_schema", `Recovery bytes and revision disagree for ${file.path}`);
    }
    result.set(file.path, file);
  }
  return result;
}

/** Inventory only the two canonical legacy Speaker state paths. No source bytes are parsed or rewritten. */
export function inspectSpeakerRecovery(
  enabled: boolean,
  files: readonly SpeakerRecoveryFileState[],
  maxProposalBytes = DEFAULT_MAX_PROPOSAL_BYTES,
): { inventory: SpeakerRecoveryInventoryEntry[]; states: Map<string, SpeakerRecoveryFileState> } {
  if (!Number.isSafeInteger(maxProposalBytes) || maxProposalBytes < 0 || maxProposalBytes > DEFAULT_MAX_PROPOSAL_BYTES) {
    fail("invalid_input", "Speaker recovery proposal byte limit is invalid");
  }
  const states = stateMap(files);
  const inventory: SpeakerRecoveryInventoryEntry[] = SPEAKER_RECOVERY_FILES.map((file) => {
    const source = states.get(file.source_path);
    const target = states.get(file.target_path);
    const sourceBytes = source?.bytes ?? null;
    const targetBytes = target?.bytes ?? null;
    let disposition: SpeakerRecoveryDisposition;
    if (!enabled) disposition = "disabled";
    else if (!source || source.revision === null) disposition = "absent";
    else if (targetBytes !== null && sourceBytes !== null && digest(sourceBytes) === digest(targetBytes)) disposition = "unchanged";
    else if (target && target.revision !== null) disposition = "conflict";
    else if (sourceBytes === null) fail("unsupported_schema", `Legacy recovery source has no bytes: ${file.source_path}`);
    else disposition = "restore";
    return {
      ...file,
      source_revision: source?.revision ?? null,
      target_revision: target?.revision ?? null,
      source_byte_length: sourceBytes?.length ?? 0,
      target_byte_length: targetBytes?.length ?? null,
      source_sha256: sourceBytes ? digest(sourceBytes) : null,
      target_sha256: targetBytes ? digest(targetBytes) : null,
      disposition,
    };
  });
  const plannedBytes = inventory.filter((entry) => entry.disposition === "restore")
    .reduce((total, entry) => total + entry.source_byte_length, 0);
  if (plannedBytes > maxProposalBytes) {
    for (const entry of inventory) if (entry.disposition === "restore") entry.disposition = "blocked";
  }
  return { inventory, states };
}

/** Compile absent-only legacy byte restoration to a normal Host-reviewed ChangeSet. */
export function prepareSpeakerRecovery(input: PrepareSpeakerRecoveryInput): SpeakerRecoveryPlan {
  if (!input.idempotency_key || input.idempotency_key.length > 128 || !/^[A-Za-z0-9._:-]+$/u.test(input.idempotency_key)) {
    fail("invalid_input", "A valid idempotency key is required for Speaker recovery");
  }
  const maxProposalBytes = input.max_proposal_bytes ?? DEFAULT_MAX_PROPOSAL_BYTES;
  const { inventory, states } = inspectSpeakerRecovery(input.enabled, input.files, maxProposalBytes);
  const restore = inventory.filter((entry) => entry.disposition === "restore");
  if (restore.length === 0) return { inventory, changeset: null };

  const readSet: ReadPrecondition[] = [...new Set(SPEAKER_RECOVERY_FILES.flatMap((file) => [file.source_path, file.target_path]))]
    .sort((left, right) => left.localeCompare(right))
    .map((path) => ({ path, revision: states.get(path)?.revision ?? null }));
  const seed = JSON.stringify({ scope: input.scope, snapshot: input.snapshot, key: input.idempotency_key,
    files: inventory.map(({ id, source_revision, target_revision, source_sha256, target_sha256, disposition }) =>
      ({ id, source_revision, target_revision, source_sha256, target_sha256, disposition })) });
  const id = digest(new TextEncoder().encode(seed));
  const operations: FileOperation[] = restore.map((entry) => {
    const source = states.get(entry.source_path);
    if (!source?.bytes || source.revision !== entry.source_revision) fail("snapshot_stale", `Legacy recovery source changed: ${entry.source_path}`);
    return {
      id: `speaker-recovery-${entry.id}-${id.slice(0, 20)}`,
      kind: "create",
      path: entry.target_path,
      expected_revision: null,
      content: Array.from(source.bytes),
    };
  });
  return {
    inventory,
    changeset: {
      id: `speaker-recovery-${id.slice(0, 40)}`,
      idempotency_key: input.idempotency_key,
      scope: input.scope,
      snapshot: input.snapshot,
      title: "Restore preserved Speaker state",
      reason: "Copy legacy correction and model bytes only into absent Proprium paths; conflicting targets remain untouched.",
      read_set: readSet,
      units: [{ id: `speaker-recovery-unit-${id.slice(0, 32)}`, label: "Restore Speaker metadata", depends_on: [], operations }],
      evidence: [],
    },
  };
}
