/** Decode Git bytes only when they are UTF-8 text; binary bytes are never coerced. */
export function decodeGitText(data: Uint8Array): string | null {
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(data);
    // Valid UTF-8 can still be binary (for example, a file containing NUL bytes).
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)) return null;
    return text;
  } catch {
    return null;
  }
}

/** A local commit is review-ready only after every changed path was explicitly opened and marked. */
export function allChangedPathsReviewed(paths: readonly string[], reviewed: ReadonlySet<string>): boolean {
  return paths.length > 0 && paths.every((path) => reviewed.has(path));
}
