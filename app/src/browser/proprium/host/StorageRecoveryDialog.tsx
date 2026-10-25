import { useEffect, useRef, type ReactElement } from "react";

/** Keep recovery actionable above docked panes, bounded shelves and Ionic scroll containers. */
export function StorageRecoveryDialog({ title, busy, error, onVerify }: {
  title: string;
  busy: boolean;
  error: string;
  onVerify(): void;
}): ReactElement {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  return <>
    <button className="storage-recovery-launcher" type="button" onClick={() => dialog.current?.showModal()}>Git保存状態を確認</button>
    <dialog ref={dialog} className="storage-recovery-dialog" aria-labelledby="storage-recovery-title" aria-describedby="storage-recovery-description">
      <h2 id="storage-recovery-title">ブラウザー内Gitの整合性確認</h2>
      <p>{title}</p>
      <p id="storage-recovery-description">前回の操作結果が未確定です。保存データを削除せず、Gitオブジェクトと作業状態を検証します。未完了の変更を自動で再実行することはありません。</p>
      {error && <p className="storage-recovery-error" role="alert">{error}</p>}
      <div className="storage-recovery-actions">
        <button type="button" disabled={busy} onClick={onVerify}>{busy ? "整合性を確認中…" : "保存データの整合性を確認"}</button>
        <button type="button" disabled={busy} onClick={() => dialog.current?.close()}>後で確認</button>
      </div>
    </dialog>
  </>;
}
