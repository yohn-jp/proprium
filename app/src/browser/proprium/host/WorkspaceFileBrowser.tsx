import { useEffect, useRef, useState, type ReactNode, type PointerEvent as ReactPointerEvent } from "react";
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
  const [contextPath, setContextPath] = useState<string | null>(null);
  const menuRef = useRef<HTMLDialogElement>(null);
  const contextTrigger = useRef<HTMLButtonElement | null>(null);
  const longPress = useRef<{ path: string; x: number; y: number; timer: ReturnType<typeof setTimeout> } | null>(null);
  const suppressClick = useRef<string | null>(null);
  const suppressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function cancelLongPress(): void {
    if (longPress.current) clearTimeout(longPress.current.timer);
    longPress.current = null;
  }
  function openContext(path: string, trigger: HTMLButtonElement): void {
    cancelLongPress();
    contextTrigger.current = trigger;
    setNewPath(path);
    setNotice("");
    setContextPath(path);
  }
  function beginLongPress(event: ReactPointerEvent<HTMLButtonElement>, path: string): void {
    if (event.pointerType !== "touch" && event.pointerType !== "pen") return;
    cancelLongPress();
    const trigger = event.currentTarget;
    const x = event.clientX, y = event.clientY;
    longPress.current = { path, x, y, timer: setTimeout(() => {
      longPress.current = null;
      suppressClick.current = path;
      if (suppressTimer.current) clearTimeout(suppressTimer.current);
      suppressTimer.current = setTimeout(() => { suppressClick.current = null; }, 800);
      openContext(path, trigger);
    }, 500) };
  }
  function trackLongPress(event: ReactPointerEvent<HTMLButtonElement>): void {
    const press = longPress.current;
    if (press && Math.hypot(press.x - event.clientX, press.y - event.clientY) > 12) cancelLongPress();
  }
  useEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    if (contextPath && !menu.open) menu.showModal();
    if (!contextPath && menu.open) menu.close();
  }, [contextPath]);
  useEffect(() => () => {
    cancelLongPress();
    if (suppressTimer.current) clearTimeout(suppressTimer.current);
  }, []);
  function closeContext(): void {
    setContextPath(null);
    contextTrigger.current?.focus({ preventScroll: true });
  }
  async function create() {
    setNotice("");
    try { const path = documentPath(name, explicit); await props.onCreate(path); setName(""); }
    catch (error) { setNotice(error instanceof Error ? error.message : "文書を作成できませんでした。"); }
  }
  async function move() {
    const from = contextPath ?? props.selectedPath;
    if (!from || !props.canModify || props.busy) return;
    const to = newPath.trim();
    setNotice(""); props.onBusyChange(true);
    try {
      validateGitPath(to);
      if (from === to) throw new Error("新しい名前・保存先を入力してください。");
      const [source, destination] = await Promise.all([props.git.read(from), props.git.read(to)]);
      if (!source.data) throw new Error("元のファイルを読み込めません。一覧を更新してください。");
      if (destination.data !== null) throw new Error("その保存先には既にファイルがあります。別の名前を選んでください。");
      if (!(await props.beforeApply())) throw new Error("編集中の本文または作品が変わりました。端末に保存してから再試行してください。");
      await props.git.renameFile(from, to, source.revision, destination.revision);
      await props.onMoved(from, to);
      setNewPath(""); closeContext(); setNotice("名前・保存先を変更しました。GitHubにはまだ公開されていません。");
    } catch (error) { setNotice(error instanceof Error ? error.message : "ファイルを移動できませんでした。"); }
    finally { props.onBusyChange(false); }
  }
  function render(nodes: Node[]): ReactNode {
    return nodes.map(node => <li key={node.path}>{node.children.size ? <details open><summary>{node.name}</summary><ul>{render([...node.children.values()])}</ul></details> : <div className="file-row-group">
      <button type="button" aria-label={node.path} aria-current={props.selectedPath === node.path ? "page" : undefined}
        className={"file-row" + (props.selectedPath === node.path ? " file-selected" : "")}
        onClick={() => { if (suppressClick.current === node.path) { suppressClick.current = null; return; } props.onSelect(node.path); }}
        onContextMenu={event => { event.preventDefault(); if (!props.busy) openContext(node.path, event.currentTarget); }}
        onPointerDown={event => beginLongPress(event, node.path)}
        onPointerMove={trackLongPress}
        onPointerUp={cancelLongPress}
        onPointerCancel={cancelLongPress}
        onPointerLeave={cancelLongPress}
        disabled={props.busy}>
        <span className="file-path" id={"file-row-name-" + encodeURIComponent(node.path)}>{node.name}</span>
        {node.pending ? <small>作成中の下書き</small> : props.changedPaths.has(node.path) ? <small>未コミット</small> : null}
      </button>
      <button type="button" className="file-row-overflow" disabled={props.busy}
        aria-label="ファイルの操作" aria-describedby={"file-row-name-" + encodeURIComponent(node.path)}
        onClick={event => openContext(node.path, event.currentTarget)}>···</button>
    </div>}</li>);
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
    <dialog ref={menuRef} className="file-context-dialog" aria-label="ファイルの操作" onClose={() => { setContextPath(null); contextTrigger.current?.focus({ preventScroll: true }); }}>
      {contextPath && <>
        <div className="file-context-heading">
          <div><span>ファイルの操作</span><strong>{contextPath}</strong></div>
          <button type="button" onClick={closeContext} aria-label="操作メニューを閉じる">×</button>
        </div>
        <button type="button" className="file-context-open" onClick={() => { const path = contextPath; closeContext(); props.onSelect(path); }} disabled={props.busy}>ファイルを開く</button>
        <form onSubmit={event => { event.preventDefault(); void move(); }}>
          <label htmlFor="context-rename-path">名前・保存先を変更</label>
          <input id="context-rename-path" value={newPath} maxLength={1024} onChange={event => setNewPath(event.target.value)} />
          <button type="submit" disabled={props.busy || !props.canModify || !newPath.trim() || contextPath === newPath.trim()}>この端末で変更</button>
        </form>
        {!props.canModify && <p>変更前に現在の原稿を端末へ保存してください。</p>}
        <p className="file-context-hint">ここでの変更はローカルのみです。GitHubへの公開は別操作です。</p>
        {notice && <p role="alert" className="file-context-feedback">{notice}</p>}
      </>}
    </dialog>
    {props.selectedPath && <details className="file-rename-panel" key={props.selectedPath}>
      <summary>選択中の文書の名前・保存先を変更</summary>
      <p>{props.selectedPath}</p>
      <form onSubmit={event => { event.preventDefault(); void move(); }}><label htmlFor="rename-file-path">新しい名前・保存先</label><input id="rename-file-path" value={newPath} placeholder={props.selectedPath} onChange={event => setNewPath(event.target.value)} maxLength={1024} /><button type="submit" disabled={props.busy || !props.canModify || !newPath.trim()}>変更する</button></form>
      {!props.canModify && <p>編集中の本文を端末に保存してから変更してください。</p>}
    </details>}
    {props.transfer}
    {notice && !contextPath && <p role="status">{notice}</p>}
  </section>;
}
