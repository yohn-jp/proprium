import { useEffect, useRef, useState } from "react";

type Read = (actionId: string, input: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>;
export interface NarrativeNavigationProps {
  sceneId: string | null;
  /** Must change for every workspace, snapshot or invocation epoch change. */
  scopeKey: string;
  read: Read;
  open: (event: Event, sceneId: string, treeRevision: string) => Promise<void>;
}
type Row = { id: string; kind: "volume" | "chapter" | "scene" };
type Page = { items: Row[]; next_cursor: string | null; tree_revision: string };
type Next = { sceneId: string; treeRevision: string } | null;

/** Consume only the canonical paged hierarchy and retain its first revision across all reads. */
export async function findNextScene(read: Read, sceneId: string, signal: AbortSignal): Promise<Next> {
  let revision: string | undefined;
  let calls = 0;
  let found = false;
  const children = async (parent: string | null, kind: Row["kind"]): Promise<Row[]> => {
    const rows: Row[] = [];
    const seen = new Set<string>();
    let cursor: string | null = null;
    do {
      if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
      if (++calls > 2048) throw new Error("作品構成が大きすぎます。構成一覧から選択してください。");
      const result = await read("proprium.narrative.hierarchy.tree", {
        parent_id: parent, limit: 200, ...(cursor ? { cursor } : {}),
        ...(revision ? { expected_tree_revision: revision } : {}),
      }, signal) as Page;
      if (!result || !Array.isArray(result.items) || typeof result.tree_revision !== "string" || !result.tree_revision || !(result.next_cursor === null || typeof result.next_cursor === "string" && result.next_cursor.length > 0) || (revision && result.tree_revision !== revision)) throw new Error("作品構成の検証に失敗しました。");
      revision ??= result.tree_revision;
      for (const row of result.items) {
        if (!row || typeof row.id !== "string" || !row.id || row.kind !== kind) throw new Error("作品構成の検証に失敗しました。");
        rows.push(row);
        if (rows.length > 100000) throw new Error("作品構成が大きすぎます。構成一覧から選択してください。");
      }
      cursor = result.next_cursor;
      if (cursor && seen.has(cursor)) throw new Error("作品構成のページが循環しています。");
      if (cursor) seen.add(cursor);
    } while (cursor);
    return rows;
  };
  const volumes = await children(null, "volume");
  for (const volume of volumes) {
    const chapters = await children(volume.id, "chapter");
    for (const chapter of chapters) {
      const scenes = await children(chapter.id, "scene");
      for (const scene of scenes) {
        if (found) return { sceneId: scene.id, treeRevision: revision! };
        if (scene.id === sceneId) found = true;
      }
    }
  }
  if (!found) throw new Error("現在のシーンが作品構成に見つかりません。");
  return null;
}

export function NarrativeNavigation({ sceneId, scopeKey, read, open }: NarrativeNavigationProps) {
  const [state, setState] = useState<{ phase: "idle" | "loading" | "ready" | "end" | "error"; next?: Next; key?: string; message?: string }>({ phase: "idle" });
  const request = useRef<AbortController | null>(null);
  const identity = useRef({ scopeKey, sceneId });
  identity.current = { scopeKey, sceneId };
  useEffect(() => { request.current?.abort(); request.current = null; setState({ phase: "idle" }); return () => { request.current?.abort(); }; }, [scopeKey, sceneId]);
  const search = async () => {
    if (!sceneId) return;
    request.current?.abort();
    const controller = new AbortController(); request.current = controller;
    const captured = { scopeKey, sceneId };
    setState({ phase: "loading" });
    try {
      const next = await findNextScene(read, sceneId, controller.signal);
      if (controller.signal.aborted || identity.current.scopeKey !== captured.scopeKey || identity.current.sceneId !== captured.sceneId) return;
      setState(next ? { phase: "ready", next, key: JSON.stringify([captured.scopeKey, captured.sceneId]) } : { phase: "end" });
    } catch (error) {
      if (controller.signal.aborted || identity.current.scopeKey !== captured.scopeKey || identity.current.sceneId !== captured.sceneId) return;
      setState({ phase: "error", message: error instanceof Error ? error.message : "次のシーンを確認できませんでした。" });
    }
  };
  return <section aria-label="次のシーン">
    <button type="button" disabled={!sceneId || state.phase === "loading"} onClick={() => { void search(); }}>次のシーンを確認</button>
    {state.phase === "loading" && <><span role="status">作品構成を確認しています…</span><button type="button" onClick={() => { request.current?.abort(); setState({ phase: "idle" }); }}>キャンセル</button></>}
    {state.phase === "ready" && state.next && state.key === JSON.stringify([scopeKey, sceneId]) && <button type="button" onClick={event => { const next = state.next!; void open(event.nativeEvent, next.sceneId, next.treeRevision).catch(error => setState({ phase: "error", message: error instanceof Error ? error.message : "シーンを開けませんでした。" })); }}>次のシーンを開く</button>}
    {state.phase === "end" && <p role="status">最後のシーンです。</p>}
    {state.phase === "error" && <p role="alert">{state.message}</p>}
  </section>;
}
