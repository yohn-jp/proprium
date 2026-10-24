import { ApiError } from "../api-error";

export function messageOf(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401 && error.code === "UNAUTHORIZED") return "セッションの有効期限が切れました。もう一度ログインしてください。";
    if (error.status === 409 || error.status === 412) return "保存先が更新されています。保護された下書きを残して競合を確認してください。";
    return error.message;
  }
  return error instanceof Error ? error.message : "処理に失敗しました。";
}
