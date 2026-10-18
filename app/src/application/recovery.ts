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

/** An unchanged in-memory operation can be dropped only after its exact generation was confirmed. */
export function isUnchangedEntryConfirmedByReceipt(
  entry: { text: string; operation: { id: string; generation: number } },
  editorText: string,
  receipts: readonly {
    state: string;
    acknowledged: readonly { operationId: string; generation: number }[];
  }[],
): boolean {
  return editorText === entry.text && receipts.some((receipt) =>
    receipt.state === "confirmed" && receipt.acknowledged.some((item) =>
      item.operationId === entry.operation.id && item.generation === entry.operation.generation,
    ),
  );
}
