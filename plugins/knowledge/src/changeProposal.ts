import type { ActionRequest, ChangeSet, FileOperation, ReadPrecondition, SourceSpan } from "../../../app/src/browser/proprium/authoring/types.js";
import type { GuestHost, HostCall } from "../../shared/guest.js";
import { propose } from "../../shared/operations.js";
import { sha256Hex } from "./sha256.js";

export interface ProposalRead { path: string; revision: string | null; content?: string; evidence?: SourceSpan }
export interface ProposalWrite { path: string; expected_revision: string | null; content: string }
export interface ProposalResult { proposalId: string; status: string; preview: unknown }

function utf8(text: string): number[] { return [...new TextEncoder().encode(text)]; }
function sourceEvidence(reads: readonly ProposalRead[]): SourceSpan[] {
  return reads.flatMap((read) => {
    if (read.revision === null || read.content === undefined || read.content.length === 0) return [];
    // SourceSpan offsets are UTF-16 code units (the Host editor's text indexing), not UTF-8 bytes.
    return [{ path: read.path, revision: read.revision, start: 0, end: read.content.length, quote: read.content }];
  });
}

/** Builds a deterministic one-unit ChangeSet and hands all write authority to the Host. */
export function* submitProposal(input: {
  context: ActionRequest;
  host: GuestHost;
  title: string;
  reason: string;
  reads: readonly ProposalRead[];
  writes: readonly ProposalWrite[];
}): Generator<HostCall, ProposalResult, unknown> {
  const key = input.context.idempotency_key;
  if (!key || !key.trim()) throw Object.assign(new Error("Host idempotency_key is required for a proposal"), { code: "invalid_input" });
  if (input.writes.length === 0) throw Object.assign(new Error("A proposal must contain at least one file operation"), { code: "invalid_input" });
  const readMap = new Map<string, ProposalRead>();
  for (const read of input.reads) {
    const prior = readMap.get(read.path);
    if (prior && prior.revision !== read.revision) throw Object.assign(new Error(`Conflicting source revisions for ${read.path}`), { code: "snapshot_stale", details: { path: read.path } });
    readMap.set(read.path, read);
  }
  const reads = [...readMap.values()].sort((left, right) => left.path.localeCompare(right.path));
  const paths = new Set<string>();
  const operations: FileOperation[] = input.writes.map((write, index) => {
    if (paths.has(write.path)) throw Object.assign(new Error(`A ChangeSet may only write ${write.path} once per unit`), { code: "invalid_input" });
    paths.add(write.path);
    if (!readMap.has(write.path) || readMap.get(write.path)!.revision !== write.expected_revision) throw Object.assign(new Error(`Write precondition missing from read_set: ${write.path}`), { code: "invalid_input" });
    const bytes = utf8(write.content);
    if (bytes.length > 1_048_576) throw Object.assign(new Error(`Proposed file exceeds 1 MiB: ${write.path}`), { code: "capacity", details: { path: write.path, byte_length: bytes.length } });
    return { id: `op-${sha256Hex(`${key}\0${index}\0${write.path}`).slice(0, 32)}`, kind: write.expected_revision === null ? "create" : "replace", path: write.path, expected_revision: write.expected_revision, content: bytes };
  });
  const unitId = `unit-${sha256Hex(`${key}\0unit`).slice(0, 32)}`;
  const changeset: ChangeSet = {
    id: `knowledge-${sha256Hex(`${key}\0${input.context.action_id}`).slice(0, 40)}`,
    idempotency_key: key,
    scope: input.context.scope,
    snapshot: input.context.snapshot,
    title: input.title,
    reason: input.reason,
    read_set: reads.map(({ path, revision }): ReadPrecondition => ({ path, revision })),
    units: [{ id: unitId, label: input.title, depends_on: [], operations }],
    evidence: [...sourceEvidence(reads.filter((read) => input.writes.some((write) => write.path === read.path))), ...reads.flatMap((read) => read.evidence ? [read.evidence] : [])],
  };
  const receipt = yield* propose(input.host, changeset);
  const value = receipt as Record<string, unknown> | null;
  const proposalId = typeof value?.proposal_id === "string" ? value.proposal_id : typeof value?.proposalId === "string" ? value.proposalId : undefined;
  if (!proposalId) throw Object.assign(new Error("Host proposal broker returned no proposal_id"), { code: "guest_trap" });
  if (typeof value?.status !== "string") throw Object.assign(new Error("Host proposal broker returned no status"), { code: "guest_trap" });
  if (!value.preview) throw Object.assign(new Error("Host proposal broker returned no review preview"), { code: "guest_trap" });
  return { proposalId, status: value.status, preview: value.preview };
}

export function stableRecordId(context: ActionRequest, label: string): string {
  const key = context.idempotency_key;
  if (!key || !key.trim()) throw Object.assign(new Error("Host idempotency_key is required for a proposal"), { code: "invalid_input" });
  const safe = label.replace(/[^A-Za-z0-9_-]/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 48) || "record";
  return `${safe}-${sha256Hex(`${key}\0${context.action_id}`).slice(0, 32)}`;
}
