/**
 * Whether the editor text is represented by its current recoverable entry or,
 * when no entry exists, is still the clean text read from the repository.
 */
export function isTextRepresentedByRecoveryRecord(
  editorText: string,
  entryText: string | null,
  cleanText: string,
): boolean {
  return editorText === (entryText ?? cleanText);
}

export function isEntryAcknowledgedByReceipt(
  entry: { publicationBatchId?: string; operation: { id: string; generation: number } },
  receipt: {
    batchId: string;
    state: string;
    acknowledged: readonly { operationId: string; generation: number }[];
  },
): boolean {
  return Boolean(entry.publicationBatchId && receipt.state === "confirmed" &&
    receipt.batchId === entry.publicationBatchId && receipt.acknowledged.some((item) =>
      item.operationId === entry.operation.id && item.generation === entry.operation.generation,
    ));
}

export function isNonDraftEntryAcknowledgedByReceipt(
  entry: { state: string; publicationBatchId?: string; operation: { id: string; generation: number } },
  receipt: {
    batchId: string;
    state: string;
    acknowledged: readonly { operationId: string; generation: number }[];
  },
): boolean {
  return entry.state !== "draft" && isEntryAcknowledgedByReceipt(entry, receipt);
}

/** An unchanged in-memory operation can be dropped only after its exact generation was confirmed. */
export function isUnchangedEntryConfirmedByReceipt(
  entry: { text: string; publicationBatchId?: string; operation: { id: string; generation: number } },
  editorText: string,
  receipts: readonly {
    batchId: string;
    state: string;
    acknowledged: readonly { operationId: string; generation: number }[];
  }[],
): boolean {
  return editorText === entry.text && receipts.some((receipt) => isEntryAcknowledgedByReceipt(entry, receipt));
}

export type EditorRecoveryStatus = "pending" | "ready" | "unavailable";

interface SceneEditorLoadIdentity {
  currentProjectId: string | undefined;
  requestedProjectId: string;
  currentRepositoryMatches: boolean;
  currentAuthorScopeMatches: boolean;
  selectedSceneId: string;
  requestedSceneId: string;
  editorSceneId: string | undefined;
}

/** Identifies a retained editor that still represents the requested scene and author context. */
export function isSameSceneEditorLoad(input: SceneEditorLoadIdentity): boolean {
  return input.currentProjectId === input.requestedProjectId && input.currentRepositoryMatches && input.currentAuthorScopeMatches &&
    input.requestedSceneId.length > 0 && input.selectedSceneId === input.requestedSceneId && input.editorSceneId === input.requestedSceneId;
}

/** Only a fully recovered editor may remain writable while that same scene refreshes in the background. */
export function canRetainRecoveredEditorDuringSceneLoad(input: SceneEditorLoadIdentity & {
  recoveryStatus: EditorRecoveryStatus;
  editorRecoveryStatus: EditorRecoveryStatus | undefined;
}): boolean {
  return isSameSceneEditorLoad(input) && input.recoveryStatus === "ready" && input.editorRecoveryStatus === "ready";
}

export function recoveryStatusForJournalOpen(openError: string): EditorRecoveryStatus {
  return openError ? "unavailable" : "pending";
}

export function mayWriteEditor(input: {
  hasWritePermission: boolean;
  recoveryStatus: EditorRecoveryStatus;
  loadingScene: boolean;
  selectedSceneId: string;
  editorSceneId: string;
}): boolean {
  return input.hasWritePermission && input.recoveryStatus === "ready" && !input.loadingScene &&
    input.selectedSceneId.length > 0 && input.selectedSceneId === input.editorSceneId;
}
