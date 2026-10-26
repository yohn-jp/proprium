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
  const repositoryId = selectedRepository?.id ?? null;
  const owner = selectedRepository?.owner ?? "";
  const name = selectedRepository?.name ?? "";
  const defaultBranch = selectedRepository?.defaultBranch ?? "";

  useEffect(() => {
    let current = true;
    setBranches([]);
    setError("");
    onBranchChange("");
    if (!session || !selectedRepository) {
      setLoading(false);
      return () => { current = false; };
    }
    if (!selectedRepository.permissions.pull) {
      setLoading(false);
      setError("このRepositoryの読み取り権限がありません。");
      return () => { current = false; };
    }
    setLoading(true);
    void session.listBranches(selectedRepository).then(available => {
      if (!current) return;
      setBranches(available);
      setLoading(false);
      onBranchChange(available.includes(selectedBranch) ? selectedBranch : available.includes(defaultBranch) ? defaultBranch : "");
    }).catch((loadError: unknown) => {
      if (!current) return;
      setError(branchErrorMessage(loadError));
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
      <select id={branchInput} value={branches.includes(selectedBranch) ? selectedBranch : ""}
        disabled={disabled || loading || branches.length === 0 || Boolean(error)}
        onChange={event => { if (branches.includes(event.target.value)) onBranchChange(event.target.value); }}>
        <option value="">{loading ? "ブランチを読み込み中…" : "ブランチを選択"}</option>
        {branches.map(branch => <option key={branch} value={branch}>{branch}{branch === defaultBranch ? " · default" : ""}</option>)}
      </select>
      <p className="repository-branch">Default: <code>{defaultBranch || "未設定"}</code></p>
      {loading && <p className="field-help" role="status">GitHubからブランチ一覧を読み込んでいます。</p>}
      {error && <div className="github-branch-error" role="alert"><p>{error}</p>
        {branchErrorRequiresSignIn(error) && onReconnect
          ? <button type="button" className="quiet-button" disabled={disabled} onClick={onReconnect}>GitHubに再接続</button>
          : session && selectedRepository.permissions.pull && <button type="button" className="quiet-button" disabled={disabled} onClick={() => setReload(value => value + 1)}>再読み込み</button>}
      </div>}
      {!loading && !error && branches.length === 0 && <p className="field-help" role="status">このRepositoryにはブランチがありません。</p>}
    </>}
  </div>;
}
