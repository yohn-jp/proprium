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
