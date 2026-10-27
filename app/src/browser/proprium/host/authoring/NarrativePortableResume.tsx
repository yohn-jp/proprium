import { useEffect, useRef, useState } from "react";

type Read = (actionId: string, input: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>;
export interface PortableResumePosition {
  scene_id: string; manuscript_path: string; metadata_revision: string; manuscript_revision: string;
  draft_generation: null; sentence_index: number | null; scroll_top: number;
}
interface Marker {
  device_id: string; scene_id: string; title: string; manuscript_path: string; manuscript_revision: string;
  sentence_index: number | null; scroll_top: number; updated_at: string;
  availability: "ready" | "stale" | "missing"; publication: "local_only" | "remote_confirmed";
}
export interface NarrativePortableResumeProps {
  scopeKey: string;
  localSceneId?: string | null;
  read: Read;
  open: (event: Event, position: PortableResumePosition) => Promise<void>;
}
type Page = { items: Marker[]; next_cursor: string | null };

export async function validatePortableResume(read: Read, marker: Marker, signal: AbortSignal): Promise<PortableResumePosition> {
  if (marker.availability !== "ready") throw new Error("この位置は現在の本文に対応していません。");
  const context = await read("proprium.narrative.scene.context", { scene_id: marker.scene_id }, signal) as Record<string, unknown>;
  if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
  if (!context || context.scene_id !== marker.scene_id || context.manuscript_path !== marker.manuscript_path || context.manuscript_revision !== marker.manuscript_revision || typeof context.metadata_revision !== "string") throw new Error("保存位置の本文またはシーンが変更されました。");
  const position: PortableResumePosition = { scene_id: marker.scene_id, manuscript_path: marker.manuscript_path, metadata_revision: context.metadata_revision, manuscript_revision: marker.manuscript_revision, draft_generation: null, sentence_index: marker.sentence_index, scroll_top: marker.scroll_top };
  const result = await read("proprium.narrative.scene.continue", { resume_position: position }, signal) as { status?: string; candidate?: PortableResumePosition | null };
  if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
  if (!result || result.status !== "ready" || !result.candidate || result.candidate.scene_id !== position.scene_id || result.candidate.manuscript_path !== position.manuscript_path || result.candidate.manuscript_revision !== position.manuscript_revision || result.candidate.metadata_revision !== position.metadata_revision || result.candidate.draft_generation !== null || result.candidate.sentence_index !== position.sentence_index || result.candidate.scroll_top !== position.scroll_top) throw new Error("保存位置は現在の作品では利用できません。");
  return position;
}

export function NarrativePortableResume({ scopeKey, localSceneId, read, open }: NarrativePortableResumeProps) {
  const [state, setState] = useState<{ phase: "idle" | "loading" | "ready" | "validating" | "selected" | "error"; key?: string; items?: Marker[]; cursor?: string | null; position?: PortableResumePosition; message?: string }>({ phase: "idle" });
  const current = useRef(scopeKey); current.current = scopeKey;
  const active = useRef<AbortController | null>(null);
  useEffect(() => { active.current?.abort(); active.current = null; setState({ phase: "idle" }); return () => active.current?.abort(); }, [scopeKey]);
  const load = async (cursor?: string) => {
    active.current?.abort(); const controller = new AbortController(); active.current = controller;
    const key = scopeKey;
    setState({ phase: "loading", key });
    try {
      const page = await read("proprium.narrative.resume.marks.list", { limit: 50, ...(cursor ? { cursor } : {}) }, controller.signal) as Page;
      if (controller.signal.aborted || current.current !== key) return;
      if (!page || !Array.isArray(page.items) || page.items.length > 50 || !(page.next_cursor === null || typeof page.next_cursor === "string" && page.next_cursor.length > 0)) throw new Error("保存位置の一覧を読み取れませんでした。");
      setState({ phase: "ready", key, items: page.items, cursor: page.next_cursor });
    } catch (error) { if (!controller.signal.aborted && current.current === key) setState({ phase: "error", key, message: error instanceof Error ? error.message : "保存位置を読み取れませんでした。" }); }
  };
  const select = async (marker: Marker) => {
    active.current?.abort(); const controller = new AbortController(); active.current = controller;
    const key = scopeKey;
    setState(previous => ({ ...previous, phase: "validating", key }));
    try {
      const position = await validatePortableResume(read, marker, controller.signal);
      if (!controller.signal.aborted && current.current === key) setState(previous => ({ ...previous, phase: "selected", key, position }));
    } catch (error) { if (!controller.signal.aborted && current.current === key) setState({ phase: "error", key, message: error instanceof Error ? error.message : "保存位置を確認できませんでした。" }); }
  };
  const valid = state.key === scopeKey;
  return <section aria-label="端末別の保存位置">
    <button type="button" disabled={valid && (state.phase === "loading" || state.phase === "validating")} onClick={() => { void load(); }}>端末別の保存位置を確認</button>
    {valid && (state.phase === "loading" || state.phase === "validating") && <><span role="status">確認しています…</span><button type="button" onClick={() => { active.current?.abort(); setState({ phase: "idle" }); }}>キャンセル</button></>}
    {valid && state.items && <ul>{state.items.map(marker => <li key={`${marker.device_id}:${marker.scene_id}`}>
      <span>{marker.title} — {marker.device_id} — {marker.availability} — {marker.publication} — 文 {marker.sentence_index ?? "未指定"} — {marker.updated_at}</span>
      {localSceneId === marker.scene_id && <span>（この端末の位置を優先）</span>}
      <button type="button" disabled={marker.availability !== "ready" || state.phase === "validating"} onClick={() => { void select(marker); }}>この位置を確認</button>
    </li>)}</ul>}
    {valid && state.cursor && state.phase !== "validating" && <button type="button" onClick={() => { void load(state.cursor!); }}>次の保存位置</button>}
    {valid && state.phase === "selected" && state.position && <button type="button" onClick={event => { void open(event.nativeEvent, state.position!).catch(error => setState({ phase: "error", key: scopeKey, message: error instanceof Error ? error.message : "保存位置を開けませんでした。" })); }}>確認した位置を開く</button>}
    {valid && state.phase === "error" && <p role="alert">{state.message}</p>}
  </section>;
}
