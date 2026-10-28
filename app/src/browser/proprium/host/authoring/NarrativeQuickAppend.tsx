import { useState, type FormEvent } from "react";

export interface NarrativeQuickAppendProps {
  /** The Host supplies the tail of the active CodeMirror document. */
  paragraphs: readonly string[];
  disabled?: boolean;
  /** Inserts into the existing editor and resolves only after the Host accepts the Draft journal write. */
  append: (event: Event, text: string, operationId: string) => Promise<void>;
}

export function recentManuscriptParagraphs(text: string): string[] {
  return text.replace(/\r\n?/gu, "\n").split(/\n[\t ]*\n/u)
    .map(value => value.trim())
    .filter(Boolean)
    .slice(-3);
}

export function NarrativeQuickAppend({ paragraphs, disabled = false, append }: NarrativeQuickAppendProps) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [composing, setComposing] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [operationId, setOperationId] = useState("");
  const context = paragraphs.map(value => value.trim()).filter(Boolean).slice(-3);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || composing || disabled || !text.trim()) return;
    const id = operationId || crypto.randomUUID();
    setOperationId(id);
    setBusy(true);
    setNotice("");
    setError("");
    void append(event.nativeEvent, text, id).then(() => {
      setText("");
      setOperationId("");
      setNotice("原稿の末尾に追加し、Host の下書き回復記録へ保存しました。");
    }, reason => setError(reason instanceof Error ? reason.message : "文章を原稿へ追加できませんでした。"))
      .finally(() => setBusy(false));
  };
  return <section className="narrative-quick-append" aria-label="クイック追記">
    <h2>クイック追記</h2>
    <p>直前の段落を確認し、文章を現在の原稿末尾へ追加します。</p>
    {context.length > 0 ? <ol aria-label="直前の段落">{context.map((paragraph, index) => <li key={`${index}:${paragraph}`}>{paragraph}</li>)}</ol> : <p>直前の段落はありません。</p>}
    <form onSubmit={submit}>
      <label htmlFor="narrative-quick-append-text">追記する文章</label>
      <textarea id="narrative-quick-append-text" value={text} disabled={disabled || busy}
        onChange={event => { setText(event.currentTarget.value); setNotice(""); }}
        onCompositionStart={() => setComposing(true)} onCompositionEnd={() => setComposing(false)}
        rows={5} />
      <button type="submit" disabled={disabled || busy || composing || !text.trim()}>原稿に追記</button>
    </form>
    {busy && <p role="status">原稿に追記し、回復記録を確認しています…</p>}
    {notice && <p role="status">{notice}</p>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
