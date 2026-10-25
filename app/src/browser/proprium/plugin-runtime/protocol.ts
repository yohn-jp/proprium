import type { PluginContext } from "./wit/generated/interfaces/proprium-plugin-guest.js";
import type { ChangeProposal, ReadRevision, SnapshotEntry, UiContribution } from "./wit/generated/interfaces/proprium-plugin-host.js";

export const PLUGIN_ABI = "proprium.component/v1";
export const PLUGIN_HOST_IMPORT = "proprium:plugin/host@1.0.0";
export const PLUGIN_GUEST_EXPORT = "proprium:plugin/guest@1.0.0";
export const CAPABILITIES = ["workspace.snapshot.read", "workspace.change.propose", "workspace.ui.contribute"] as const;
export type PluginCapability = typeof CAPABILITIES[number];

export function intersectCapabilities(requested: readonly string[], userGrants: readonly PluginCapability[], hostAllowed: readonly PluginCapability[]): PluginCapability[] {
  const user = new Set(userGrants);
  const host = new Set(hostAllowed);
  return CAPABILITIES.filter(capability => requested.includes(capability) && user.has(capability) && host.has(capability));
}

export const LIMITS = Object.freeze({
  componentBytes: 16 * 1024 * 1024,
  generatedBytes: 32 * 1024 * 1024,
  requestBytes: 256 * 1024,
  snapshotBytes: 2 * 1024 * 1024,
  snapshotFiles: 256,
  proposalBytes: 256 * 1024,
  proposalChanges: 32,
  proposalReadEntries: 256,
  proposalFileBytes: 128 * 1024,
  outputBytes: 256 * 1024,
  activeWorkers: 4,
  requestDeadlineMs: 10_000,
  stopDeadlineMs: 1_000,
  maxDeadlineMs: 60_000,
});

export interface RuntimeSnapshotFile extends SnapshotEntry {
  readonly content: string;
}

export interface RuntimeSnapshot {
  readonly id: string;
  readonly revision: string;
  readonly files: readonly RuntimeSnapshotFile[];
}

export interface RuntimeContext extends PluginContext {}

export interface PluginTranscript {
  readonly requestId: string;
  readonly sessionId: string;
  readonly epoch: number;
  readonly pluginId: string;
  readonly version: string;
  readonly digest: string;
  readonly workspaceId: string;
  readonly deadlineAt: number;
  readonly grants: readonly PluginCapability[];
  readonly snapshotId: string;
  readonly snapshotRevision: string;
  readonly value: string;
  readonly reads: readonly ReadRevision[];
  readonly proposals: readonly ChangeProposal[];
  readonly contributions: readonly UiContribution[];
}

export type RuntimeErrorCode =
  | "incompatible_abi"
  | "capability_denied"
  | "invalid_input"
  | "snapshot_stale"
  | "overloaded"
  | "timeout"
  | "canceled"
  | "guest_trap"
  | "unavailable"
  | "stopped"
  | "malformed_message";

export class PluginRuntimeError extends Error {
  constructor(readonly code: RuntimeErrorCode, message: string) {
    super(message);
    this.name = "PluginRuntimeError";
  }
}

export interface WorkerEnvelope {
  readonly id: string;
  readonly sessionId: string;
  readonly epoch: number;
  readonly pluginId: string;
  readonly version: string;
  readonly digest: string;
  readonly workspaceId: string;
  readonly deadlineAt: number;
  readonly grants: readonly PluginCapability[];
}

export type WorkerRequest =
  | (WorkerEnvelope & { readonly type: "start"; readonly context: RuntimeContext; readonly component: Uint8Array })
  | (WorkerEnvelope & { readonly type: "invoke"; readonly snapshot: RuntimeSnapshot; readonly request: string })
  | (WorkerEnvelope & { readonly type: "stop" });

export interface WorkerResponse extends WorkerEnvelope {
  readonly type: WorkerRequest["type"];
  readonly snapshotId?: string;
  readonly snapshotRevision?: string;
  readonly result?: PluginTranscript;
  readonly error?: { readonly code: RuntimeErrorCode; readonly message: string };
}

export function isSafePluginPath(path: unknown): path is string {
  return typeof path === "string" && path.length > 0 && path.length <= 1024 &&
    !path.startsWith("/") && !path.includes("\\") && !path.includes("\0") &&
    path.split("/").every(segment => segment.length > 0 && segment !== "." && segment !== ".." && segment !== ".git");
}

export function utf8Size(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function assertSnapshot(snapshot: RuntimeSnapshot): void {
  if (!snapshot || typeof snapshot.id !== "string" || snapshot.id.length < 1 || snapshot.id.length > 256 ||
      typeof snapshot.revision !== "string" || snapshot.revision.length < 1 || snapshot.revision.length > 256 ||
      !Array.isArray(snapshot.files) || snapshot.files.length > LIMITS.snapshotFiles) {
    throw new PluginRuntimeError("invalid_input", "Snapshot identity or file list is invalid");
  }
  let total = 0;
  const seen = new Set<string>();
  for (const file of snapshot.files) {
    if (!file || !isSafePluginPath(file.path) || seen.has(file.path) || typeof file.revision !== "string" ||
        file.revision.length < 1 || file.revision.length > 256 || typeof file.content !== "string") {
      throw new PluginRuntimeError("invalid_input", "Snapshot contains an invalid or duplicate file");
    }
    seen.add(file.path);
    total += utf8Size(file.content);
    if (total > LIMITS.snapshotBytes) throw new PluginRuntimeError("invalid_input", "Snapshot exceeds the byte limit");
  }
}

export function deadlineFor(durationMs: number): number {
  const bounded = Number.isFinite(durationMs) ? durationMs : LIMITS.requestDeadlineMs;
  return Date.now() + Math.max(1, Math.min(bounded, LIMITS.maxDeadlineMs));
}

export function matchesResponse(request: WorkerRequest, response: WorkerResponse): boolean {
  return response !== null && typeof response === "object" && Array.isArray(response.grants) && response.type === request.type &&
    response.id === request.id && response.sessionId === request.sessionId && response.epoch === request.epoch &&
    response.pluginId === request.pluginId && response.version === request.version && response.digest === request.digest &&
    response.workspaceId === request.workspaceId && response.deadlineAt === request.deadlineAt &&
    response.grants.length === request.grants.length && request.grants.every((grant, index) => response.grants[index] === grant) &&
    (request.type !== "invoke" || (response.snapshotId === request.snapshot.id && response.snapshotRevision === request.snapshot.revision));
}
