import type { ActionRequest } from "../../../app/src/browser/proprium/authoring/types.js";
import type { GuestHost, HostCall } from "../../shared/guest.js";
import { PairedError } from "./types.js";
import { exactKeys, finiteInteger, identity, record } from "./validation.js";

type ReceiptHostOperation = "workspace.change.list" | "workspace.change.status" |
  "workspace.change.observations" | "workspace.change.inspect" | "workspace.change.content.read";

function pageInput(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  const row = record(value, label);
  exactKeys(row, keys, label);
  const result: Record<string, unknown> = {};
  for (const key of keys) if (row[key] !== undefined) result[key] = row[key];
  if (row.cursor !== undefined) identity(row.cursor, `${label}.cursor`, 4096);
  if (row.limit !== undefined) finiteInteger(row.limit, `${label}.limit`, 1, label === "inspect" ? 50 : 100);
  return result;
}

function* readReceipt<T>(host: GuestHost, operation: ReceiptHostOperation, input: Record<string, unknown>): Generator<HostCall, T, unknown> {
  return yield* host.request<T>(operation, input);
}

/** Read the Host's proposal ledger; Paired never changes proposal state. */
export function* listChangeSets(input: unknown, host: GuestHost): Generator<HostCall, unknown, unknown> {
  const row = pageInput(input, ["status", "cursor", "limit"], "list");
  if (row.status !== undefined && !["proposed", "approved", "rejected", "stale", "applying", "applied", "partially_applied", "failed", "storage_unknown"].includes(String(row.status))) {
    throw new PairedError("invalid_input", "status is not a Host ProposalStatus value");
  }
  return yield* readReceipt(host, "workspace.change.list", row);
}

export function* changeSetStatus(input: unknown, host: GuestHost): Generator<HostCall, unknown, unknown> {
  const row = record(input, "input");
  exactKeys(row, ["proposal_id"], "input");
  return yield* readReceipt(host, "workspace.change.status", { proposal_id: identity(row.proposal_id, "proposal_id") });
}

export function* changeSetObservations(input: unknown, host: GuestHost): Generator<HostCall, unknown, unknown> {
  const row = pageInput(input, ["proposal_id", "cursor", "limit"], "observations");
  if (row.proposal_id === undefined) throw new PairedError("invalid_input", "proposal_id is required");
  row.proposal_id = identity(row.proposal_id, "proposal_id");
  return yield* readReceipt(host, "workspace.change.observations", row);
}

export function* inspectChangeSet(input: unknown, host: GuestHost): Generator<HostCall, unknown, unknown> {
  const row = pageInput(input, ["proposal_id", "cursor", "limit", "include_source"], "inspect");
  if (row.proposal_id === undefined) throw new PairedError("invalid_input", "proposal_id is required");
  row.proposal_id = identity(row.proposal_id, "proposal_id");
  if (row.include_source !== undefined && typeof row.include_source !== "boolean") {
    throw new PairedError("invalid_input", "include_source must be boolean");
  }
  return yield* readReceipt(host, "workspace.change.inspect", row);
}

export function* readProposalContent(input: unknown, host: GuestHost): Generator<HostCall, unknown, unknown> {
  const row = record(input, "input");
  exactKeys(row, ["proposal_id", "ref", "offset", "length"], "input");
  const proposalId = identity(row.proposal_id, "proposal_id");
  const ref = identity(row.ref, "ref", 4096);
  const offset = row.offset === undefined ? 0 : finiteInteger(row.offset, "offset");
  const length = row.length === undefined ? 65_536 : finiteInteger(row.length, "length", 1, 262_144);
  return yield* readReceipt(host, "workspace.change.content.read", { proposal_id: proposalId, ref, offset, length });
}

export function proposalRequestHasKey(request: ActionRequest): void {
  if (!request.idempotency_key) throw new PairedError("invalid_input", "The Host must provide an idempotency key for a proposal");
}
