import { useRef, useState, type ChangeEvent } from "react";
import type { BrowserLocalGit, WorkspaceFile } from "../git/index.js";
import { MAX_WORKSPACE_CHANGE_BYTES, MAX_WORKSPACE_CHANGE_COUNT } from "../git/protocol.js";
import { createWorkspaceArchive, readWorkspaceArchive, validateTransferFiles, MAX_WORKSPACE_ARCHIVE_BYTES, type TransferFile } from "./workspace-transfer.js";

export function downloadWorkspaceFile(name: string, data: Uint8Array, type = "application/octet-stream"): void {
  const url = URL.createObjectURL(new Blob([new Uint8Array(data)], { type }));
  const link = document.createElement("a");
  link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

interface Props {
  git: BrowserLocalGit;
  files: readonly WorkspaceFile[];
  busy: boolean;
  canImport: boolean;
  onBusyChange(value: boolean): void;
  onImportBusyChange(value: boolean): void;
  onImported(paths: string[]): Promise<void>;
  beforeApply(): Promise<boolean>;
}

export function WorkspaceTransferPanel({ git, files, busy, canImport, onBusyChange, onImportBusyChange, onImported, beforeApply }: Props) {
  const input = useRef<HTMLInputElement>(null);
  const [notice, setNotice] = useState("");
  const [working, setWorking] = useState(false);

  async function importFiles(event: ChangeEvent<HTMLInputElement>) {
    const selected = Array.from(event.currentTarget.files ?? []);
    event.currentTarget.value = "";
    if (!selected.length || busy || !canImport) return;
    setWorking(true); onImportBusyChange(true); setNotice("");
    try {
      if (selected.length > MAX_WORKSPACE_CHANGE_COUNT || selected.reduce((sum, file) => sum + file.size, 0) > MAX_WORKSPACE_ARCHIVE_BYTES) throw new Error("一度の取込は256ファイル・ZIPを含め68 MiB以内（展開後64 MiB以内）にしてください。");
      const imported: TransferFile[] = [];
      for (const file of selected) {
        const data = new Uint8Array(await file.arrayBuffer());
        if (/\.zip$/iu.test(file.name)) imported.push(...readWorkspaceArchive(data));
        else imported.push({ path: file.webkitRelativePath || file.name, data });
      }
      validateTransferFiles(imported);
      const changes = await Promise.all(imported.map(async file => ({ path: file.path, content: file.data, expectedRevision: (await git.read(file.path)).revision })));
      const replaced = changes.filter(file => file.expectedRevision.oid !== null);
      if (replaced.length && !window.confirm(`次の${replaced.length}件を置き換えます。取り込む内容を確認しましたか？\n${replaced.map(file => file.path).join("\n")}`)) return;
      if (!(await beforeApply())) throw new Error("編集中の本文または作品が変わりました。端末に保存してから再試行してください。");
      await git.applyChanges(changes);
      await onImported(imported.map(file => file.path));
      setNotice(`${imported.length}件をこの端末のファイルへ取り込みました。Gitコミット・GitHub公開は行っていません。`);
    } catch (error) { setNotice(error instanceof Error ? error.message : "ファイルを取り込めませんでした。"); }
    finally { setWorking(false); onImportBusyChange(false); }
  }

  async function exportFiles() {
    if (busy || !files.length) return;
    setWorking(true); onBusyChange(true); setNotice("");
    try {
      if (files.length > MAX_WORKSPACE_CHANGE_COUNT || files.reduce((sum, file) => sum + file.bytes, 0) > MAX_WORKSPACE_CHANGE_BYTES) throw new Error("一度のZIP書出しは256ファイル・合計64 MiB以内です。文書ごとの書出しも利用できます。");
      const contents: TransferFile[] = [];
      for (const file of files) {
        const current = await git.read(file.path);
        if (!current.data) throw new Error(`${file.path} は変更されました。一覧を更新して再試行してください。`);
        contents.push({ path: file.path, data: current.data });
      }
      downloadWorkspaceFile("workspace-files.zip", createWorkspaceArchive(contents), "application/zip");
      setNotice("保存済みファイルをZIPに書き出しました。Gitの履歴・編集中の未保存本文は含みません。");
    } catch (error) { setNotice(error instanceof Error ? error.message : "ファイルを書き出せませんでした。"); }
    finally { setWorking(false); onBusyChange(false); }
  }

  return <details className="workspace-transfer-panel">
    <summary>ファイルの取込・書出し</summary>
    <p>選んだ文書やZIPを取り込むか、この端末に保存済みのファイルをZIPで持ち出せます。</p>
    <div className="file-browser-actions">
      <button type="button" disabled={busy || !canImport} onClick={() => input.current?.click()}>ファイル・ZIPを取り込む</button>
      <input ref={input} type="file" multiple hidden aria-label="取り込むファイル・ZIP" onChange={event => void importFiles(event)} />
      <button type="button" disabled={busy || !files.length} onClick={() => void exportFiles()}>保存済みファイルをZIPに書き出す</button>
    </div>
    {!canImport && <p>編集中の文書を端末に保存してから取り込んでください。</p>}
    {working && <p role="status">ファイルを処理しています…</p>}
    {notice && <p role="status">{notice}</p>}
  </details>;
}
