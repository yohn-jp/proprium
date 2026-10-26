import { useState, type ReactNode } from "react";
import type { BrowserLocalGit, WorkspaceFile } from "../git/index.js";
import { validateGitPath } from "../git/protocol.js";
import { documentPath } from "./workspace-transfer.js";
import "./file-browser.css";

interface Node { name: string; path: string; children: Map<string, Node>; file?: WorkspaceFile; pending?: boolean; }
function fileTree(files: readonly WorkspaceFile[], pendingPath?: string): Node[] {
  const root: Node = { name: "", path: "", children: new Map() };
  for (const file of [...files, ...(pendingPath && !files.some(file => file.path === pendingPath) ? [{ path: pendingPath, type: "blob" as const, oid: "", bytes: 0 }] : [])]) {
    let parent = root;
    const parts = file.path.split("/");
    parts.forEach((name, index) => {
      let node = parent.children.get(name);
      if (!node) { node = { name, path: parts.slice(0, index + 1).join("/"), children: new Map() }; parent.children.set(name, node); }
      if (index === parts.length - 1) { node.file = file; node.pending = file.path === pendingPath && !files.some(item => item.path === pendingPath); }
      parent = node;
    });
  }
  const sort = (nodes: Iterable<Node>) => [...nodes].sort((a, b) => Number(!a.children.size) - Number(!b.children.size) || a.name.localeCompare(b.name, "ja", { numeric: true }));
  const flattenSort = (node: Node) => { node.children = new Map(sort(node.children.values()).map(child => [child.name, child])); node.children.forEach(flattenSort); };
  flattenSort(root);
  return sort(root.children.values());
}

interface Props {
  git: BrowserLocalGit;
  files: readonly WorkspaceFile[];
  selectedPath: string | null;
  pendingPath?: string;
  changedPaths: ReadonlySet<string>;
  busy: boolean;
  canModify: boolean;
  recovery?: ReactNode;
  transfer?: ReactNode;
  onBusyChange(value: boolean): void;
  onSelect(path: string): void;
  onCreate(path: string): Promise<void>;
  onMoved(from: string, to: string): Promise<void>;
  beforeApply(): Promise<boolean>;
}

export function WorkspaceFileBrowser(props: Props) {
  const [name, setName] = useState("");
  const [explicit, setExplicit] = useState(false);
  const [newPath, setNewPath] = useState("");
  const [notice, setNotice] = useState("");
  async function create() {
    setNotice("");
    try { const path = documentPath(name, explicit); await props.onCreate(path); setName(""); }
    catch (error) { setNotice(error instanceof Error ? error.message : "文書を作成できませんでした。"); }
  }
  async function move() {
    if (!props.selectedPath || !props.canModify || props.busy) return;
    const from = props.selectedPath, to = newPath.trim();
    setNotice(""); props.onBusyChange(true);
    try {
      validateGitPath(to);
      if (from === to) throw new Error("新しい名前・保存先を入力してください。");
      const [source, destination] = await Promise.all([props.git.read(from), props.git.read(to)]);
      if (!source.data) throw new Error("元のファイルを読み込めません。一覧を更新してください。");
      if (destination.data !== null) throw new Error("その保存先には既にファイルがあります。別の名前を選んでください。");
      if (!(await props.beforeApply())) throw new Error("編集中の本文または作品が変わりました。端末に保存してから再試行してください。");
      await props.git.applyChanges([{ path: from, content: null, expectedRevision: source.revision }, { path: to, content: source.data, expectedRevision: destination.revision }]);
      await props.onMoved(from, to);
      setNewPath(""); setNotice("名前・保存先を変更しました。GitHubにはまだ公開されていません。");
    } catch (error) { setNotice(error instanceof Error ? error.message : "ファイルを移動できませんでした。"); }
    finally { props.onBusyChange(false); }
  }
  function render(nodes: Node[]): ReactNode {
    return nodes.map(node => <li key={node.path}>{node.children.size ? <details open><summary>{node.name}</summary><ul>{render([...node.children.values()])}</ul></details> : <button type="button" aria-label={node.path} aria-current={props.selectedPath === node.path ? "page" : undefined} className={`file-row ${props.selectedPath === node.path ? "file-selected" : ""}`} onClick={() => props.onSelect(node.path)} disabled={props.busy}><span className="file-path">{node.name}</span>{node.pending ? <small>作成中の下書き</small> : props.changedPaths.has(node.path) ? <small>未コミット</small> : null}</button>}</li>);
  }
  return <section className="host-file-browser" aria-labelledby="workspace-files-heading">
    <div className="section-title-row"><h2 id="workspace-files-heading">文書とファイル</h2><span className="count-badge">{props.files.length + (props.pendingPath && !props.files.some(file => file.path === props.pendingPath) ? 1 : 0)}</span></div>
    <form className="document-create-form" onSubmit={event => { event.preventDefault(); void create(); }}>
      <label htmlFor="new-file-path">{explicit ? "新しいファイルパス" : "文書名"}</label>
      <div><input id="new-file-path" aria-label="New file path" value={name} onChange={event => setName(event.target.value)} placeholder={explicit ? "notes/example.md" : "文書名（拡張子は省略できます）"} maxLength={1024} /><button type="submit" aria-label="Create new file" disabled={props.busy || !name.trim()}>作成</button></div>
      <label className="file-browser-checkbox"><input type="checkbox" checked={explicit} onChange={event => setExplicit(event.target.checked)} />ファイルパスを指定する</label>
    </form>
    {props.files.length || props.pendingPath ? <ul className="file-list file-tree" aria-label="Repository files">{render(fileTree(props.files, props.pendingPath))}</ul> : <p className="sidebar-empty">まだ文書がありません。文書名を入力して作成するか、手元のファイルを取り込めます。</p>}
    {props.recovery}
    {props.selectedPath && <details className="file-rename-panel" key={props.selectedPath}>
      <summary>選択中の文書の名前・保存先を変更</summary>
      <p>{props.selectedPath}</p>
      <form onSubmit={event => { event.preventDefault(); void move(); }}><label htmlFor="rename-file-path">新しい名前・保存先</label><input id="rename-file-path" value={newPath} placeholder={props.selectedPath} onChange={event => setNewPath(event.target.value)} maxLength={1024} /><button type="submit" disabled={props.busy || !props.canModify || !newPath.trim()}>変更する</button></form>
      {!props.canModify && <p>編集中の本文を端末に保存してから変更してください。</p>}
    </details>}
    {props.transfer}
    {notice && <p role="status">{notice}</p>}
  </section>;
}
