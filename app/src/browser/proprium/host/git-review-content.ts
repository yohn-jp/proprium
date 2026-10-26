import type { CommitFileChange } from "../git/protocol.js";

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

/** Keep raw Worker/API English errors out of localized Host review surfaces. */
export function localizeGitReviewError(error: unknown, fallback: string): string {
  const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : "";
  switch (code) {
    case "revision_conflict": return "確認後に対象ファイルが変更されました。最新の状態を確認してから、もう一度お試しください。";
    case "workspace_busy": return "別のタブでこのワークスペースを使用中です。処理が終わってから、もう一度お試しください。";
    case "storage_unknown": return "ブラウザー内のGit保存状態を確認できません。保存状態を確認してから、もう一度お試しください。";
    case "not_initialized": return "このワークスペースのローカルGitを初期化できません。ワークスペースを開き直してください。";
    case "invalid_path": return "このファイルパスは現在のローカルGit操作では扱えません。";
    default: return fallback;
  }
}

/** Byte-only worktree writes cannot reproduce executable bits or symlinks. */
export function historyHasUnsupportedModes(changes: readonly Pick<CommitFileChange, "parentMode" | "commitMode">[]): boolean {
  return changes.some(change => [change.parentMode, change.commitMode].some(mode => mode !== null && mode !== "100644"));
}
