/** Logical v2 wire types. Field names follow the Authoring Host canon. */
export interface Scope {
  workspace_id: string;
  repository_id: number | null;
  branch: string;
  generation: string;
}
export interface Snapshot {
  id: string;
  local_commit: string | null;
  worktree_generation: string;
  draft_generation: string | null;
  remote_commit?: string | null;
}
export interface CacheKey {
  plugin_id: string;
  snapshot: Snapshot;
  schema_version: number;
  config_digest: string;
  model_digest?: string;
  key: string;
}
export interface ArtifactMetadata {
  artifact_id: string;
  media_type: string;
  filename: string;
  scope: Scope;
  snapshot: Snapshot;
  total_bytes: number;
  sha256: string;
}
export type Caller = "ui" | "mcp" | "plugin";
export interface ActionRequest {
  schema_version: 1;
  request_id: string;
  plugin_id: string;
  action_id: string;
  scope: Scope;
  snapshot: Snapshot;
  input: Record<string, unknown>;
  deadline_ms: number;
  idempotency_key?: string;
}
export interface ActionError {
  code: string;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
}
export type ActionResult<T = unknown> = {
  request_id: string;
  scope: Scope;
  snapshot: Snapshot;
} & ({ ok: true; value: T; warnings: string[] } | { ok: false; error: ActionError });
export type JsonSchema = boolean | { readonly [key: string]: unknown };
export interface ActionDescriptor {
  plugin_id: string;
  action_id: string;
  schema_version: 1;
  effect: "read" | "propose";
  input_schema: JsonSchema;
  output_schema: JsonSchema;
  required_capabilities: string[];
  callers: Caller[];
  requires_user_gesture: boolean;
  caller_plugins?: string[];
}
export interface SourceSpan {
  path: string;
  revision: string;
  start: number;
  end: number;
  quote: string;
}
export interface ReadPrecondition {
  path: string;
  revision: string | null;
  scope?: Scope;
  snapshot?: Snapshot;
}
export interface FileOperation {
  id: string;
  kind: "create" | "replace" | "delete";
  path: string;
  expected_revision: string | null;
  content?: number[];
  content_artifact?: string;
}
export interface ChangeUnit {
  id: string;
  label: string;
  depends_on: string[];
  operations: FileOperation[];
  source_operation_ids?: string[];
}
export interface ChangeSet {
  id: string;
  idempotency_key: string;
  scope: Scope;
  snapshot: Snapshot;
  title: string;
  reason: string;
  read_set: ReadPrecondition[];
  units: ChangeUnit[];
  evidence: SourceSpan[];
  /** Exact versioned domain input retained by the Host receipt authority. */
  source_payload?: unknown;
  source_payload_digest?: string;
  domain_evidence?: unknown[];
}
export interface ActionBinding {
  action_id: string;
  input_template: Record<string, unknown>;
}
export interface SurfaceDeclaration {
  id: string;
  kind: string;
  title: string;
  context: Record<string, unknown>;
  body: Record<string, unknown>;
}
/** Implemented by the trusted bridge, never by plugin-supplied JavaScript. */
export interface HostPort {
  request<T = unknown>(operation: string, payload: Record<string, unknown>): Promise<T>;
}
export class AuthoringError extends Error {
  constructor(readonly code: string, message: string, readonly retryable = false,
    readonly details?: Record<string, unknown>) { super(message); this.name = "AuthoringError"; }
}
