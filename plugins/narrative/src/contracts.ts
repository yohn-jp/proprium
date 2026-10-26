import type { GuestHost, HostCall } from "../../shared/guest.js";

export type Scope = {
  workspace_id: string;
  repository_id: number | null;
  branch: string;
  generation: string;
};

export type Snapshot = {
  id: string;
  local_commit: string | null;
  worktree_generation: string;
  draft_generation: string | null;
  remote_commit?: string | null;
};

export type ActionRequest = {
  request_id: string;
  plugin_id: "proprium.narrative";
  action_id: string;
  schema_version: 1;
  scope: Scope;
  snapshot: Snapshot;
  input: Record<string, unknown>;
  deadline_ms: number;
  idempotency_key?: string;
};

export type Diagnostic = {
  code: string;
  path?: string;
  message: string;
  severity: "warning" | "error";
  index?: number;
};

export type FileEntry = {
  path: string;
  revision: string;
  byte_length: number;
  media_type: string;
};

export type FilePage = {
  entries: FileEntry[];
  next_cursor: string | null;
};

export type ReadChunk = {
  revision: string;
  total_bytes: number;
  offset: number;
  bytes: Uint8Array | number[];
  next_offset: number | null;
};

export type FileRead = {
  revision: string;
  bytes: Uint8Array;
  text: string;
};

export type FileOperation = {
  id: string;
  kind: "create" | "replace" | "delete";
  path: string;
  expected_revision: string | null;
  content?: number[];
};

export type ChangeUnit = {
  id: string;
  label: string;
  depends_on: string[];
  operations: FileOperation[];
  source_operation_ids?: string[];
};

export type ChangeSet = {
  id: string;
  idempotency_key: string;
  scope: Scope;
  snapshot: Snapshot;
  title: string;
  reason: string;
  read_set: Array<{ path: string; revision: string | null }>;
  units: ChangeUnit[];
  evidence: unknown[];
};

export type HostChangePreview = {
  title: string;
  read_paths: string[];
  units: Array<{ id: string; label: string; depends_on: string[]; operation_paths: string[] }>;
};

export type ProposalValue = {
  proposal_id: string;
  preview: HostChangePreview;
};

export type NarrativeHost = GuestHost;
export type { HostCall };

export type StructureKind = "volume" | "chapter" | "scene";
export type StructureRow = {
  id: string;
  kind: StructureKind;
  title: string;
  order?: number;
  parent_id: string | null;
  metadata_path: string;
  metadata_revision: string;
  manuscript_path?: string;
  raw: Record<string, unknown>;
};
