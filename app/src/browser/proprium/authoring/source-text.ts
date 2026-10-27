/** SourceSpan offsets count the original UTF-16 text, including any UTF-8 BOM. */
export function sourceTextDecoder(): TextDecoder {
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
}
