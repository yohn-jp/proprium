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
