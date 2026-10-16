import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { RepositoryIdentity } from "@scriptorium/contracts";
import type { Scene, SceneRead } from "../api";
import { BrowserJournal } from "../storage/journal";
import { ManuscriptInput, type ManuscriptInputHandle } from "./ManuscriptInput";
import { RubyText } from "./ruby";
import { loadTypographySettings, storeTypographySettings, type TypographySettings } from "./typography";
import { WRITING_SYMBOLS } from "./writingSymbols";

type Durability = "draft" | "checkpointing" | "checkpointed" | "publication_unknown" | "saved";

export function SceneEditor({
  projectId,
  scene,
  path,
  breadcrumb,
  text,
  onTextChange,
  durability,
  draftStored,
  journalError,
  conflict,
  canResolveDraft,
  onRebase,
  onRestoreRemote,
  canCheckpoint,
  checkpointBusy,
  onCheckpoint,
  canPublish,
  publishBusy,
  onPublish,
  onHistory,
  historyOpen,
  journal,
  repository,
  onJournalError,
  pendingCount,
}: {
  projectId: string;
  scene: Scene;
  path: string;
  breadcrumb: string;
  text: string;
  onTextChange: (next: string) => void;
  durability: Durability;
  draftStored: boolean;
  journalError: string;
  conflict: SceneRead | null;
  canResolveDraft: boolean;
  onRebase: () => void;
  onRestoreRemote: () => void;
  canCheckpoint: boolean;
  checkpointBusy: boolean;
  onCheckpoint: () => void;
  canPublish: boolean;
  publishBusy: boolean;
  onPublish: () => void;
  onHistory: () => void;
  historyOpen: boolean;
  journal: BrowserJournal | null;
  repository: RepositoryIdentity;
  onJournalError: (message: string) => void;
  pendingCount: number;
}) {
  const editorRef = useRef<ManuscriptInputHandle>(null);
  const [reading, setReading] = useState(false);
  const [vertical, setVertical] = useState(false);
  const [zen, setZen] = useState(false);
  const [typewriterDim, setTypewriterDim] = useState(true);
  const [typography, setTypography] = useState<TypographySettings>(loadTypographySettings);
  const [selectionLength, setSelectionLength] = useState(0);
  const [printing, setPrinting] = useState(false);

  useEffect(() => {
    if (!zen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setZen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [zen]);

  useEffect(() => storeTypographySettings(typography), [typography]);

  const statusText = durability === "draft"
    ? draftStored ? "下書きはこのブラウザーに保護されています。" : "この下書きのブラウザー保存を確認できていません。"
    : durability === "checkpointing"
      ? "チェックポイントの結果を確認しています。再試行では同じ操作 ID を使います。"
      : durability === "checkpointed"
        ? "ローカルチェックポイントです。GitHub へ保存するまでブラウザーの記録を保持します。"
        : durability === "publication_unknown"
          ? "GitHub への保存結果は未確認です。同じバッチで状態を再確認できます。"
          : "確認済みの GitHub 版を表示しています。";

  function printManuscript(): void {
    setPrinting(true);
    requestAnimationFrame(() => {
      window.print();
      setPrinting(false);
    });
  }

  return (
    <section className={`editor ${zen ? "is-zen" : ""} ${zen && typewriterDim && !vertical ? "is-typewriter-dim" : ""}`} aria-label="原稿エディター">
      <header className="editor-header">
        <div className="scene-heading">
          <p className="eyebrow">{breadcrumb} · {path}</p>
          <h1>{scene.title}</h1>
          <div className="durability-row" aria-label="保存状態">
            <span className={`durability-badge ${durability === "draft" ? "is-current" : ""}`}>Draft</span>
            <span className={`durability-badge ${durability === "checkpointing" || durability === "checkpointed" || durability === "publication_unknown" ? "is-current" : ""}`}>Checkpoint</span>
            <span className={`durability-badge ${durability === "saved" ? "is-current" : ""}`}>Saved to GitHub</span>
            {pendingCount > 0 && <span className="pending-count">未公開 {pendingCount} 件</span>}
          </div>
        </div>
        <div className="editor-actions" aria-label="保存と表示">
          <button type="button" onClick={onCheckpoint} disabled={!canCheckpoint || checkpointBusy}>
            {checkpointBusy || durability === "checkpointing" ? "確認中…" : "Checkpoint"}
          </button>
          <button type="button" className="quiet-button" onClick={onPublish} disabled={!canPublish || publishBusy}>
            {publishBusy ? "GitHub に保存中…" : "Save to GitHub"}
          </button>
          <button type="button" className="quiet-button" onClick={onHistory} aria-expanded={historyOpen}>
            履歴
          </button>
        </div>
      </header>

      <p className="durability-message" role="status" aria-live="polite">{statusText}</p>
      {journalError && <p className="status" data-kind="error" role="alert">{journalError}</p>}

      {conflict && (
        <section className="conflict" aria-labelledby="conflict-title">
          <h2 id="conflict-title">リモートの原稿が更新されています</h2>
          <p>保護された下書きはそのままです。現在の GitHub 版を確認してから、この下書きを明示的に結び直してください。</p>
          <details>
            <summary>現在の GitHub 版</summary>
            <pre>{conflict.scene.text}</pre>
          </details>
          <div className="conflict-actions">
            <button type="button" onClick={onRebase} disabled={!canResolveDraft}>比較して下書きを最新の版に結び直す</button>
            <button type="button" className="quiet-button" onClick={onRestoreRemote} disabled={!canResolveDraft}>この文書の未チェックポイント下書きを削除して GitHub 版に戻す</button>
          </div>
        </section>
      )}

      <nav className="typography-toolbar" aria-label="原稿の表示設定">
        <div className="toolbar-group" aria-label="文字サイズ">
          <button type="button" className="quiet-button compact-button" onClick={() => setTypography((value) => ({ ...value, fontSize: Math.max(14, value.fontSize - 2) }))} aria-label="文字を小さく" disabled={typography.fontSize <= 14}>A−</button>
          <output aria-label="文字サイズ">{typography.fontSize}px</output>
          <button type="button" className="quiet-button compact-button" onClick={() => setTypography((value) => ({ ...value, fontSize: Math.min(24, value.fontSize + 2) }))} aria-label="文字を大きく" disabled={typography.fontSize >= 24}>A＋</button>
        </div>
        <div className="toolbar-group" aria-label="行間">
          <button type="button" className="quiet-button compact-button" onClick={() => setTypography((value) => ({ ...value, lineHeight: Math.max(1.4, Math.round((value.lineHeight - 0.1) * 10) / 10) }))} aria-label="行間を詰める" disabled={typography.lineHeight <= 1.4}>行間 −</button>
          <button type="button" className="quiet-button compact-button" onClick={() => setTypography((value) => ({ ...value, lineHeight: Math.min(2.4, Math.round((value.lineHeight + 0.1) * 10) / 10) }))} aria-label="行間を広げる" disabled={typography.lineHeight >= 2.4}>行間 ＋</button>
        </div>
        <button type="button" className="quiet-button" onClick={() => setTypography((value) => ({ ...value, fontFamily: value.fontFamily === "mincho" ? "gothic" : "mincho" }))} aria-pressed={typography.fontFamily === "mincho"}>{typography.fontFamily === "mincho" ? "明朝" : "ゴシック"}</button>
        <button type="button" className="quiet-button" onClick={() => setTypography((value) => ({ ...value, letterSpacing: Math.max(0, Math.round((value.letterSpacing - 0.02) * 100) / 100) }))} aria-label="字送りを詰める" disabled={typography.letterSpacing <= 0}>字送り −</button>
        <output aria-label="字送り">{typography.letterSpacing.toFixed(2)}</output>
        <button type="button" className="quiet-button" onClick={() => setTypography((value) => ({ ...value, letterSpacing: Math.min(0.2, Math.round((value.letterSpacing + 0.02) * 100) / 100) }))} aria-label="字送りを広げる" disabled={typography.letterSpacing >= 0.2}>字送り ＋</button>
        <button type="button" className="quiet-button" onClick={() => setVertical((current) => !current)} aria-pressed={vertical}>{vertical ? "横書き" : "縦書き"}</button>
        <button type="button" className="quiet-button" onClick={() => setReading((current) => !current)} aria-pressed={reading}>{reading ? "編集に戻る" : "読書モード"}</button>
        <button type="button" className="quiet-button" onClick={() => setZen((current) => !current)} aria-pressed={zen}>{zen ? "集中を終了" : "集中"}</button>
        {zen && <button type="button" className="quiet-button" onClick={() => setTypewriterDim((current) => !current)} aria-pressed={typewriterDim}>現在行以外を減光</button>}
        <button type="button" className="quiet-button" onClick={printManuscript}>印刷</button>
      </nav>

      {reading ? (
          <section className={`reading-view ${vertical ? "is-vertical" : ""}`} aria-label={vertical ? "縦書き読書モード" : "読書モード"}>
          <RubyText text={text} />
        </section>
      ) : (
        <div className="editor-columns">
          <div className="manuscript-column">
            <label id="manuscript-label" htmlFor="manuscript">原稿 Markdown</label>
            <ManuscriptInput
              ref={editorRef}
              value={text}
              onChange={onTextChange}
              onSelectionLengthChange={setSelectionLength}
              labelledBy="manuscript-label"
              placeholder="物語の続きを書く"
              style={{
                "--editor-font-size": `${typography.fontSize}px`,
                "--editor-line-height": `${typography.lineHeight}`,
                "--editor-letter-spacing": `${typography.letterSpacing}em`,
                "--editor-font-family": typography.fontFamily === "mincho" ? "var(--manuscript-serif)" : "var(--manuscript-sans)",
              } as CSSProperties}
            />
            <p className="editor-hint">{text.length} 字 · 400字詰め換算 {text.length === 0 ? 0 : Math.ceil(text.length / 400)} 枚{selectionLength > 0 ? ` · 選択 ${selectionLength} 字 / 400字詰め換算 ${Math.ceil(selectionLength / 400)} 枚` : ""}。入力は IndexedDB に自動記録されます。</p>
            <div className="mobile-keyboard" aria-label="日本語入力補助">
              {WRITING_SYMBOLS.map(({ id, label, ariaLabel }) => (
                <button type="button" key={id} aria-label={ariaLabel} onClick={() => editorRef.current?.insert(id)}>{label}</button>
              ))}
            </div>
            <ScratchPanel journal={journal} repository={repository} path={path} onError={onJournalError} />
          </div>
          <section className="preview-column" aria-labelledby="preview-title">
            <h2 id="preview-title">{vertical ? "縦書きプレビュー" : "読みのプレビュー"}</h2>
            <div className={`manuscript-preview ${vertical ? "is-vertical" : ""}`} role="document" aria-label="ルビ付き読み取り専用プレビュー">
              <RubyText text={text} />
            </div>
          </section>
        </div>
      )}
      <div className={`print-view ${vertical ? "is-vertical" : ""}`} aria-hidden={!printing}>
        <RubyText text={text} />
      </div>
    </section>
  );
}

function ScratchPanel({
  journal,
  repository,
  path,
  onError,
}: {
  journal: BrowserJournal | null;
  repository: RepositoryIdentity;
  path: string;
  onError: (message: string) => void;
}) {
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(false);
  const [saved, setSaved] = useState(true);
  const loadGeneration = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const currentText = useRef(text);
  const onErrorRef = useRef(onError);
  const writeGeneration = useRef(0);
  currentText.current = text;
  onErrorRef.current = onError;
  const repositoryId = JSON.stringify([repository.provider, repository.ownerScope, repository.repositoryId, repository.defaultBranch]);

  useEffect(() => {
    const generation = ++loadGeneration.current;
    writeGeneration.current++;
    setText("");
    setSaved(true);
    if (!journal) return;
    setLoading(true);
    void journal.getScratch(repository, path).then((value) => {
      if (loadGeneration.current === generation) setText(value);
    }).catch((error: unknown) => {
      if (loadGeneration.current === generation) onErrorRef.current(error instanceof Error ? error.message : "スクラッチを読み込めませんでした。");
    }).finally(() => {
      if (loadGeneration.current === generation) setLoading(false);
    });
    return () => {
      loadGeneration.current++;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [journal, path, repositoryId]);

  async function flush(value: string, generation: number): Promise<void> {
    if (!journal) {
      onError("IndexedDB が利用できないため、スクラッチを保存できません。");
      return;
    }
    await journal.putScratch(repository, path, value);
    if (writeGeneration.current === generation) setSaved(true);
  }

  function change(value: string): void {
    setText(value);
    setSaved(false);
    if (timer.current) clearTimeout(timer.current);
    const generation = ++writeGeneration.current;
    timer.current = setTimeout(() => {
      void flush(value, generation).catch((error: unknown) => onError(error instanceof Error ? error.message : "スクラッチを保存できませんでした。"));
    }, 350);
  }

  return (
    <details className="scratch-panel">
      <summary>スクラッチ <span>{text.trim().length} 字 {loading ? "· 読み込み中" : saved ? "· 保存済み" : "· 保存中"}</span></summary>
      <label htmlFor="scratch">本文に含まれないメモ</label>
      <textarea id="scratch" value={text} onChange={(event) => change(event.currentTarget.value)} onBlur={() => {
        if (timer.current) clearTimeout(timer.current);
        const generation = ++writeGeneration.current;
        void flush(currentText.current, generation).catch((error: unknown) => onError(error instanceof Error ? error.message : "スクラッチを保存できませんでした。"));
      }} placeholder="台詞候補・没文など。本文には入りません" spellCheck={false} />
    </details>
  );
}
