/** The proposal response is text-only; binary originals cannot be reviewed safely in this UI. */
export function snapshotProposalBefore(path: string, data: Uint8Array | null): string | null {
  if (data === null) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(data);
  } catch {
    throw new Error(`The file ${path} is binary or is not valid UTF-8, so the Browser Host cannot show a safe before/after review.`);
  }
}
