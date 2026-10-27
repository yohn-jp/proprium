import type { WorkspaceIdentity } from "../git/protocol.js";
import { validateGitPath } from "../git/protocol.js";

export interface WritingResumeScope {
  readonly author_scope: string;
  readonly workspace_id: string;
  readonly repository_id: number | null;
  readonly branch: string;
}
/** Canon ResumePosition; no manuscript, selected text or journal payload. */
export interface WritingResumePosition {
  readonly scene_id: string;
  readonly manuscript_path: string;
  readonly metadata_revision: string;
  readonly manuscript_revision: string;
  readonly draft_generation: null;
  readonly sentence_index: number | null;
  readonly scroll_top: number;
}
export interface WritingResumeSelection { readonly anchor: number; readonly head: number }
export interface HostWritingResume {
  readonly position: WritingResumePosition;
  /** Exact UTF-16 selection is Host-only and never added to the guest DTO. */
  readonly selection: WritingResumeSelection | null;
}

export function writingResumeScope(workspace: WorkspaceIdentity, authorScope: string): WritingResumeScope {
  return { author_scope: authorScope, workspace_id: workspace.localWorkspaceId,
    repository_id: workspace.provider === "local" ? null : workspace.repositoryId, branch: workspace.branch };
}
function key(scope: WritingResumeScope): string {
  return `proprium:writing-resume:v1:${JSON.stringify([scope.author_scope,scope.workspace_id,scope.repository_id,scope.branch])}`;
}
function valid(value: unknown): value is HostWritingResume {
  if (!value || typeof value !== "object") return false;
  const row=value as HostWritingResume,p=row.position;
  return !!p && typeof p.scene_id === "string" && p.scene_id.length>0 && p.scene_id.length<=256 &&
    typeof p.manuscript_path === "string" && p.manuscript_path.length>0 && p.manuscript_path.length<=1024 &&
    typeof p.metadata_revision === "string" && /^[a-f0-9]{64}$/u.test(p.metadata_revision) &&
    typeof p.manuscript_revision === "string" && /^[a-f0-9]{64}$/u.test(p.manuscript_revision) && p.draft_generation===null &&
    (p.sentence_index===null || (Number.isSafeInteger(p.sentence_index) && p.sentence_index!>0)) &&
    Number.isFinite(p.scroll_top) && p.scroll_top>=0 &&
    (row.selection===null || (!!row.selection && Number.isSafeInteger(row.selection.anchor) && row.selection.anchor>=0 &&
      Number.isSafeInteger(row.selection.head) && row.selection.head>=0));
}
function project(value: HostWritingResume): HostWritingResume {
  const p=value.position;
  return { position: { scene_id:p.scene_id,manuscript_path:p.manuscript_path,metadata_revision:p.metadata_revision,
    manuscript_revision:p.manuscript_revision,draft_generation:null,sentence_index:p.sentence_index,scroll_top:p.scroll_top },
    selection:value.selection ? {anchor:value.selection.anchor,head:value.selection.head} : null };
}

/** Optional same-browser Host state, using the existing localStorage facility. */
export class HostWritingResumeStore {
  constructor(private readonly storage: Pick<Storage,"getItem"|"setItem">) {}
  load(scope: WritingResumeScope): HostWritingResume | null {
    try {
      const raw=this.storage.getItem(key(scope));if(!raw || raw.length>16384)return null;
      const record=JSON.parse(raw);
      if(record.schema!=="proprium.writing-resume/v1" || JSON.stringify(record.scope)!==JSON.stringify(scope) || !valid(record.value))return null;
      validateGitPath(record.value.position.manuscript_path);
      return project(record.value);
    } catch { return null; }
  }
  save(scope: WritingResumeScope, value: HostWritingResume): void {
    if(!valid(value))throw new Error("Resume revision, position or selection is invalid");
    validateGitPath(value.position.manuscript_path);
    this.storage.setItem(key(scope),JSON.stringify({schema:"proprium.writing-resume/v1",scope,value:project(value)}));
  }
}

export async function savedBodySha256(bytes: Uint8Array): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",Uint8Array.from(bytes))),byte=>byte.toString(16).padStart(2,"0")).join("");
}
