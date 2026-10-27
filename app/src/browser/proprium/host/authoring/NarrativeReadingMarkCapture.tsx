import { useState } from "react";

export interface ReadingMarkSelection {
  scene_id: string;
  offset: number;
  length: number;
  snippet: string;
  expected_metadata_revision: string;
  expected_manuscript_revision: string;
}
export interface NarrativeReadingMarkCaptureProps {
  capture: () => ReadingMarkSelection;
  propose: (event: Event, input: ReadingMarkSelection & { comment: string }) => Promise<void>;
}

/** Compute guest offsets against the saved text, including an optional UTF-8 BOM. */
export function savedSelectionRange(raw: string, visible: string, anchor: number, head: number): { offset: number; length: number; snippet: string } {
  const prefix = raw === visible ? 0 : raw === `\ufeff${visible}` ? 1 : -1;
  if (prefix < 0) throw new Error("保存済み本文とエディターの内容が一致しません。保存してから選択してください。");
  if (!Number.isSafeInteger(anchor) || !Number.isSafeInteger(head) || anchor < 0 || head < 0 || anchor > visible.length || head > visible.length) throw new Error("選択範囲が本文の外にあります。");
  const start = Math.min(anchor, head), end = Math.max(anchor, head);
  if (start === end) throw new Error("本文の範囲を選択してください。");
  if (end - start > 16384) throw new Error("選択範囲は 16384 UTF-16 単位以内にしてください。");
  const splitsSurrogate = (index: number) => index > 0 && index < visible.length && visible.charCodeAt(index - 1) >= 0xd800 && visible.charCodeAt(index - 1) <= 0xdbff && visible.charCodeAt(index) >= 0xdc00 && visible.charCodeAt(index) <= 0xdfff;
  if (splitsSurrogate(start) || splitsSurrogate(end)) throw new Error("文字の途中で選択範囲を区切れません。");
  return { offset: start + prefix, length: end - start, snippet: visible.slice(start, end) };
}

export function NarrativeReadingMarkCapture({ capture, propose }: NarrativeReadingMarkCaptureProps) {
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  return <section aria-label="選択範囲に読書マーク">
    <label>コメント（任意）<input value={comment} maxLength={200} onChange={event => setComment(event.currentTarget.value)} /></label>
    <button type="button" disabled={busy} onClick={event => {
      setError(""); setStatus("");
      try {
        const selected = capture();
        setBusy(true);
        void propose(event.nativeEvent, { ...selected, comment }).then(() => setStatus("読書マークの変更提案を作成しました。レビューで確認してください。"), reason => setError(reason instanceof Error ? reason.message : "変更提案を作成できませんでした。")).finally(() => setBusy(false));
      } catch (reason) { setError(reason instanceof Error ? reason.message : "選択範囲を取得できませんでした。"); }
    }}>選択範囲に読書マークを提案</button>
    {busy && <span role="status">提案を作成しています…</span>}
    {status && <p role="status">{status}</p>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
