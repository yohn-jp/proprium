import { useEffect, useState, type ReactElement } from "react";
import type { GitHubAccountSession, GitHubRepository } from "../git/github-sync.js";

interface GitHubRepositoryPickerProps {
  session: Pick<GitHubAccountSession, "listBranches"> | null;
  repositories: readonly GitHubRepository[];
  selectedRepositoryId: number | null;
  selectedBranch: string;
  onRepositoryChange: (repository: GitHubRepository | null) => void;
  onBranchChange: (branch: string) => void;
  onReconnect?: () => void;
  disabled?: boolean;
  idPrefix?: string;
}

function branchErrorMessage(error: unknown): string {
  const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : "";
  if (code === "authentication_required" || code === "authentication_expired") return "GitHubの認証が切れました。再接続してください。";
  if (code === "permission_denied") return "このRepositoryの読み取り権限がありません。GitHubの権限を確認してください。";
  if (code === "repository_mismatch") return "Repositoryの識別情報が変わりました。Repository一覧を読み込み直してください。";
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") return error.message;
  return "ブランチ一覧を読み込めませんでした。接続を確認して再試行してください。";
}

function branchErrorRequiresSignIn(message: string): boolean {
  return message.startsWith("GitHubの認証が切れました。");
}

export function GitHubRepositoryPicker({
  session,
  repositories,
  selectedRepositoryId,
  selectedBranch,
  onRepositoryChange,
  onBranchChange,
  onReconnect,
  disabled = false,
  idPrefix = "github",
}: GitHubRepositoryPickerProps): ReactElement {
  const selectedRepository = repositories.find(repository => repository.id === selectedRepositoryId) ?? null;
  const [branches, setBranches] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const [settledKey, setSettledKey] = useState("");
  const repositoryId = selectedRepository?.id ?? null;
  const owner = selectedRepository?.owner ?? "";
  const name = selectedRepository?.name ?? "";
  const defaultBranch = selectedRepository?.defaultBranch ?? "";
  const requestKey = JSON.stringify([repositoryId, owner, name, defaultBranch]);
  const visibleBranches = settledKey === requestKey ? branches : [];
  const visibleError = settledKey === requestKey ? error : "";
  const visibleLoading = loading || Boolean(selectedRepository && settledKey !== requestKey);

  useEffect(() => {
    let current = true;
    setBranches([]);
    setError(""); setSettledKey("");
    onBranchChange("");
    if (!session || !selectedRepository) {
      setLoading(false);
      return () => { current = false; };
    }
    if (!selectedRepository.permissions.pull) {
      setLoading(false);
      setError("このRepositoryの読み取り権限がありません。"); setSettledKey(requestKey);
      return () => { current = false; };
    }
    setLoading(true);
    void session.listBranches(selectedRepository).then(available => {
      if (!current) return;
      setBranches(available); setSettledKey(requestKey);
      setLoading(false);
      onBranchChange(available.includes(selectedBranch) ? selectedBranch : available.includes(defaultBranch) ? defaultBranch : "");
    }).catch((loadError: unknown) => {
      if (!current) return;
      setError(branchErrorMessage(loadError)); setSettledKey(requestKey);
      setLoading(false);
    });
    return () => { current = false; };
  }, [session, repositoryId, owner, name, defaultBranch, reload]);

  const repositoryIdInput = `${idPrefix}-repository-picker`;
  const branchInput = `${idPrefix}-branch-picker`;
  return <div className="github-repository-picker">
    <label htmlFor={repositoryIdInput}>Repository</label>
    <select id={repositoryIdInput} value={selectedRepositoryId ?? ""} disabled={disabled} onChange={event => {
      const repository = repositories.find(item => item.id === Number(event.target.value)) ?? null;
      onRepositoryChange(repository);
    }}>
      <option value="">Repositoryを選択</option>
      {repositories.map(repository => <option key={repository.id} value={repository.id} disabled={!repository.permissions.pull}>
        {repository.fullName}{repository.private ? " · private" : ""}{repository.permissions.pull ? "" : " · 読み取り権限なし"}
      </option>)}
    </select>
    {selectedRepository && <>
      <label htmlFor={branchInput}>ブランチ</label>
      <select id={branchInput} value={visibleBranches.includes(selectedBranch) ? selectedBranch : ""}
        disabled={disabled || visibleLoading || visibleBranches.length === 0 || Boolean(visibleError)}
        onChange={event => { if (visibleBranches.includes(event.target.value)) onBranchChange(event.target.value); }}>
        <option value="">{visibleLoading ? "ブランチを読み込み中…" : "ブランチを選択"}</option>
        {visibleBranches.map(branch => <option key={branch} value={branch}>{branch}{branch === defaultBranch ? " · default" : ""}</option>)}
      </select>
      <p className="repository-branch">Default: <code>{defaultBranch || "未設定"}</code></p>
      {visibleLoading && <p className="field-help" role="status">GitHubからブランチ一覧を読み込んでいます。</p>}
      {visibleError && <div className="github-branch-error" role="alert"><p>{visibleError}</p>
        {branchErrorRequiresSignIn(visibleError) && onReconnect
          ? <button type="button" className="quiet-button" disabled={disabled} onClick={onReconnect}>GitHubに再接続</button>
          : session && selectedRepository.permissions.pull && <button type="button" className="quiet-button" disabled={disabled} onClick={() => setReload(value => value + 1)}>再読み込み</button>}
      </div>}
      {!visibleLoading && !visibleError && visibleBranches.length === 0 && <p className="field-help" role="status">このRepositoryにはブランチがありません。</p>}
    </>}
  </div>;
}
