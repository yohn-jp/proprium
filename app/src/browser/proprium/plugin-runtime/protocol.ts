import type { PluginContext } from "./wit/generated/interfaces/proprium-plugin-guest.js";

export const PLUGIN_ABI = "proprium.component/v1";
export const PLUGIN_HOST_IMPORT = "proprium:plugin/host@1.0.0";
export const PLUGIN_GUEST_EXPORT = "proprium:plugin/guest@1.0.0";
export const CAPABILITIES = ["workspace.snapshot.read"] as const;
export type PluginCapability = typeof CAPABILITIES[number];

export const LIMITS = Object.freeze({
  componentBytes: 16 * 1024 * 1024,
  generatedBytes: 32 * 1024 * 1024,
  requestBytes: 256 * 1024,
  outputBytes: 256 * 1024,
  activeWorkers: 4,
  requestDeadlineMs: 10_000,
  stopDeadlineMs: 1_000,
});

export interface RuntimeSnapshot {
  readonly id: string;
  readonly revision: string;
}

export interface RuntimeContext extends PluginContext {}

export interface PluginTranscript {
  readonly requestId: string;
  readonly epoch: number;
  readonly workspaceId: string;
  readonly snapshotId: string;
  readonly value: string;
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

export type WorkerRequest =
  | { readonly type: "start"; readonly id: string; readonly epoch: number; readonly workspaceId: string; readonly pluginId: string; readonly version: string; readonly context: RuntimeContext; readonly component: Uint8Array }
  | { readonly type: "invoke"; readonly id: string; readonly epoch: number; readonly workspaceId: string; readonly snapshotId: string; readonly snapshotRevision: string; readonly request: string }
  | { readonly type: "stop"; readonly id: string; readonly epoch: number; readonly workspaceId: string };

export interface WorkerResponse {
  readonly type: WorkerRequest["type"];
  readonly id: string;
  readonly epoch: number;
  readonly workspaceId: string;
  readonly snapshotId?: string;
  readonly result?: PluginTranscript;
  readonly error?: { readonly code: RuntimeErrorCode; readonly message: string };
}

export function utf8Size(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function assertSnapshot(snapshot: RuntimeSnapshot): void {
  if (!snapshot || typeof snapshot.id !== "string" || snapshot.id.length < 1 || snapshot.id.length > 256 ||
      typeof snapshot.revision !== "string" || snapshot.revision.length < 1 || snapshot.revision.length > 256) {
    throw new PluginRuntimeError("invalid_input", "Snapshot identity is invalid");
  }
}

export function matchesResponse(request: WorkerRequest, response: WorkerResponse): boolean {
  return response !== null && typeof response === "object" && response.type === request.type &&
    response.id === request.id && response.epoch === request.epoch && response.workspaceId === request.workspaceId &&
    (request.type !== "invoke" || response.snapshotId === request.snapshotId);
}
