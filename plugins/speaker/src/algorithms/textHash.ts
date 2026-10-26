/** Source FNV-1a dialogue hash used to bind corrections to exact text. */
export function hashDialogueText(text: string): string {
  let hash = 0x811c9dc5;
  const normalized = text.trim();
  for (let i = 0; i < normalized.length; i++) {
    hash ^= normalized.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
