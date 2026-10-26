import { useEffect, useState, type ReactElement } from "react";
import type { GitHubDevicePrompt } from "../git/github-sync.js";

export type GitHubAuthorizationStage = "waiting" | "verifying" | "repositories";

interface GitHubDeviceAuthorizationProps {
  prompt: GitHubDevicePrompt;
  stage: GitHubAuthorizationStage;
  onCancel?: () => void;
  onRetry?: () => void;
  retryDisabled?: boolean;
}

function remainingTime(expiresAt: number, now: number): number {
  return Math.max(0, Math.ceil((expiresAt - now) / 1000));
}

function formatRemaining(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return minutes > 0 ? `あと ${minutes}分 ${String(rest).padStart(2, "0")}秒` : `あと ${rest}秒`;
}

export function GitHubDeviceAuthorization({
  prompt,
  stage,
  onCancel,
  onRetry,
  retryDisabled = false,
}: GitHubDeviceAuthorizationProps): ReactElement {
  const [now, setNow] = useState(() => Date.now());
  const [copyMessage, setCopyMessage] = useState("");
  const left = remainingTime(prompt.expiresAt, now);
  const expired = left === 0;

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [prompt.expiresAt]);

  const copyCode = async (): Promise<void> => {
    setCopyMessage("");
    try {
      if (!navigator.clipboard?.writeText) throw new Error("clipboard_unavailable");
      await navigator.clipboard.writeText(prompt.userCode);
      setCopyMessage("認証コードをコピーしました。");
    } catch {
      setCopyMessage("コピーできませんでした。認証コードを選択してコピーしてください。");
    }
  };

  const status = expired
    ? "認証コードの有効期限が切れました。新しいコードを取得してください。"
    : stage === "verifying"
      ? "認証済みです。Workspaceとの接続を確認しています。"
      : stage === "repositories"
        ? "認証済みです。Repository一覧を読み込んでいます。"
        : `GitHubでの承認を待っています（${formatRemaining(left)}）。`;

  return <section className="device-prompt" aria-label="GitHub デバイス認証">
    <h3>GitHubの認証コード</h3>
    <strong aria-label={`認証コード ${prompt.userCode}`}>{prompt.userCode}</strong>
    <div className="device-prompt-actions">
      <button type="button" className="quiet-button" onClick={() => void copyCode()}>コードをコピー</button>
      <a href={expired ? undefined : prompt.verificationUri} tabIndex={expired ? -1 : undefined} target="_blank" rel="noopener noreferrer" aria-disabled={expired}>
        GitHubの認証画面を開く
      </a>
    </div>
    {copyMessage && <p className="field-help" role="status">{copyMessage}</p>}
    <p className="field-help" role="status" aria-live="polite">{status}</p>
    {expired && onRetry && <button type="button" className="quiet-button" disabled={retryDisabled} onClick={onRetry}>新しい認証コードを取得</button>}
    {onCancel && <button type="button" className="quiet-button" onClick={onCancel}>GitHub接続をキャンセル</button>}
  </section>;
}

interface GitHubAuthorizationErrorProps {
  message: string;
  onRetry: () => void;
  disabled?: boolean;
}

export function GitHubAuthorizationError({ message, onRetry, disabled = false }: GitHubAuthorizationErrorProps): ReactElement {
  return <section className="github-authorization-error" role="alert" aria-live="assertive">
    <p>{message}</p>
    <button type="button" className="quiet-button" disabled={disabled} onClick={onRetry}>もう一度試す</button>
  </section>;
}
