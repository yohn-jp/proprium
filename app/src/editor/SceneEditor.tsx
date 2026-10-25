import { createContext, forwardRef, memo, useCallback, useContext, useEffect, useImperativeHandle, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { Scene, SceneRead } from "../editor/contracts";
import { snapshotKey, type SnapshotId } from "@scriptorium/contracts";
import type { JournalEntry } from "../storage/journal";
import { MobileReadingPager } from "./MobileReadingPager";
import { ManuscriptInput, type ManuscriptInputHandle } from "./ManuscriptInput";
import { RubyText } from "./ruby";
import { TermAwareRubyText } from "./TermAwareRubyText";
import type { ResolveEditorTerms } from "./terms";
import { loadTypographySettings, storeTypographySettings, typographyPresetValues, TYPOGRAPHY_PRESETS, type TypographySettings, type TypographyPresetId } from "./typography";
import { WRITING_SYMBOLS } from "./writingSymbols";
import { loadReadingPage, saveReadingPage } from "../resume/continueCandidates";

type Durability = "draft" | "checkpointing" | "checkpointed" | "publication_unknown" | "saved";

interface EditorDurabilityStatusHandle {
  markPendingText: (text: string, revision: number) => void;
}

const PendingEditorTextContext = createContext(false);

const PendingEditorTextBoundary = forwardRef<EditorDurabilityStatusHandle, {
  text: string;
  textRevision: number;
  children: ReactNode;
}>(function PendingEditorTextBoundary({ text, textRevision, children }, ref) {
  const [pendingEditorText, setPendingEditorText] = useState(false);
  const pendingEditorTextRef = useRef<string | null>(null);
  const pendingEditorTextRevisionRef = useRef<number | null>(null);

  useImperativeHandle(ref, () => ({
    markPendingText(nextText, revision) {
      pendingEditorTextRef.current = nextText;
      pendingEditorTextRevisionRef.current = revision;
      setPendingEditorText(true);
    },
  }), []);

  useEffect(() => {
    if (!pendingEditorText ||
        (pendingEditorTextRevisionRef.current === textRevision && pendingEditorTextRef.current !== text)) return;
    pendingEditorTextRef.current = null;
    pendingEditorTextRevisionRef.current = null;
    setPendingEditorText(false);
  }, [pendingEditorText, text, textRevision]);

  return <PendingEditorTextContext.Provider value={pendingEditorText}>{children}</PendingEditorTextContext.Provider>;
});

const EditorDurabilityBadges = memo(function EditorDurabilityBadges({
  durability,
  pendingCount,
  draftStored,
  journalError,
}: {
  durability: Durability;
  pendingCount: number;
  draftStored: boolean;
  journalError: string;
}) {
  const pendingEditorText = useContext(PendingEditorTextContext);
  const currentDurability = pendingEditorText ? "draft" : durability;
  return <span className="durability-row" aria-label="保存状態">
    <span className="durability-badge is-current" data-state={currentDurability}>{
      currentDurability === "draft" ? journalError ? "Draft · 保存要確認" : pendingEditorText || !draftStored ? "Draft · 記録中" : "Draft · このブラウザーに保護済み"
        : currentDurability === "checkpointing" ? "Checkpoint · 結果確認中"
        : currentDurability === "checkpointed" ? "Checkpoint · GitHub未保存"
        : currentDurability === "publication_unknown" ? "GitHub保存 · 結果未確認"
        : "Saved to GitHub"
    }</span>
    {pendingCount > 0 && <span className="pending-count">未公開 {pendingCount} 件</span>}
  </span>;
});

const EditorDurabilityMessage = memo(function EditorDurabilityMessage({
  durability,
  draftStored,
  journalError,
}: {
  durability: Durability;
  draftStored: boolean;
  journalError: string;
}) {
  const pendingEditorText = useContext(PendingEditorTextContext);
  const currentDurability = pendingEditorText ? "draft" : durability;
  const currentDraftStored = pendingEditorText ? false : draftStored;
  const statusText = currentDurability === "draft"
    ? currentDraftStored ? "下書きはこのブラウザーに保護されています。" : "この下書きのブラウザー保存を確認できていません。"
    : currentDurability === "checkpointing"
      ? "チェックポイントの結果を確認しています。再試行では同じ操作 ID を使います。"
      : currentDurability === "checkpointed"
        ? "ローカルチェックポイントです。GitHub へ保存するまでブラウザーの記録を保持します。"
        : currentDurability === "publication_unknown"
          ? "GitHub への保存結果は未確認です。同じバッチで状態を再確認できます。"
          : "確認済みの GitHub 版を表示しています。";

  return <>
    <p className="durability-message" role="status" aria-live="polite">{statusText}</p>
    {journalError && <p className="status" data-kind="error" role="alert">{journalError}</p>}
  </>;
});

export interface ResumeRequest {
  id: number;
  repositoryKey: string;
  sceneId: string;
  cursorSentenceIndex: number | null;
  scrollTop: number;
  pageIndex?: number | null;
}

export interface ScratchAttachmentDraft {
  filename: string;
  mimeType: string;
  dataBase64: string;
  path?: string;
}

export interface ScratchDraftPayload {
  id: string;
  generation: number;
  createdAt?: string;
  text: string;
  attachments: ScratchAttachmentDraft[];
}

export interface ScratchDraftBinding {
  repositoryKey: string;
  snapshot: SnapshotId;
  sceneId: string;
  documentPath: string;
}

export function SceneEditor({
  projectId,
  authorScope,
  repositoryKey,
  snapshot,
  historySnapshot,
  scene,
  path,
  breadcrumb,
  text,
  textRevision,
  flushPendingReactPublish,
  readOnly,
  onTextChange,
  onRetryDraft,
  onCursorPositionChange,
  onReadingPageChange,
  resumeRequest,
  onResumeRequestApplied,
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
  historyExternal,
  historyContent,
  onRestoreHistoryBody,
  resolveTerms,
  onTermNavigate,
  scratchEntries,
  onDraftScratch,
  onCheckpointScratch,
  registerScratchFlush,
  registerNavigationFlush,
  scratchBusy,
  pendingCount,
}: {
  projectId: string;
  authorScope: string;
  repositoryKey: string;
  snapshot: SnapshotId;
  /** Manuscript history is GitHub history and must remain pinned to the observed remote HEAD. */
  historySnapshot: SnapshotId;
  scene: Scene;
  path: string;
  breadcrumb: string;
  text: string;
  textRevision: number;
  flushPendingReactPublish: () => void;
  readOnly?: boolean;
  onTextChange: (next: string) => void;
  onRetryDraft: () => void;
  onCursorPositionChange: (sceneId: string, cursorSentenceIndex: number | null, scrollTop: number) => void;
  onReadingPageChange: (sceneId: string, pageIndex: number) => void;
  resumeRequest: ResumeRequest | null;
  onResumeRequestApplied: (requestId: number) => void;
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
  /** Use when History is mounted as an independent workspace panel. */
  historyExternal?: boolean;
  historyContent?: ReactNode;
  onRestoreHistoryBody: (body: string) => void;
  resolveTerms?: ResolveEditorTerms;
  onTermNavigate?: (targetPath: string, termId: string) => void;
  scratchEntries: JournalEntry[];
  onDraftScratch: (draft: ScratchDraftPayload, binding: ScratchDraftBinding) => Promise<JournalEntry | null>;
  onCheckpointScratch: (entry: JournalEntry) => Promise<void>;
  registerScratchFlush: (flush: (() => Promise<JournalEntry | null>) | null) => void;
  registerNavigationFlush: (flush: (() => Promise<string | null>) | null) => void;
  scratchBusy: boolean;
  pendingCount: number;
}) {
  const snapshotIdentity = snapshotKey(snapshot);
  const editorRef = useRef<ManuscriptInputHandle>(null);
  const [reading, setReading] = useState(false);
  const [vertical, setVertical] = useState(false);
  const [preview, setPreview] = useState(false);
  const [zen, setZen] = useState(false);
  const [typewriterDim, setTypewriterDim] = useState(true);
  const [typography, setTypography] = useState<TypographySettings>(loadTypographySettings);
  const [readingPage, setReadingPage] = useState(() => loadReadingPage(authorScope, repositoryKey, scene.id));
  const [selectionLength, setSelectionLength] = useState(0);
  const pendingEditorStatusRef = useRef<EditorDurabilityStatusHandle>(null);
  const pendingEditorTextRef = useRef<string | null>(null);
  const pendingEditorTextRevisionRef = useRef<number | null>(null);
  const [printing, setPrinting] = useState(false);
  const editorReadOnly = readOnly ?? false;
  const displayText = pendingEditorTextRevisionRef.current === textRevision
    ? pendingEditorTextRef.current ?? text
    : text;

  useEffect(() => {
    if (!zen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setZen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [zen]);

  useEffect(() => storeTypographySettings(typography), [typography]);

  useEffect(() => {
    registerNavigationFlush(() => editorRef.current?.flushComposition() ?? Promise.resolve(null));
    return () => registerNavigationFlush(null);
  }, [registerNavigationFlush]);

  const onEditorTextChange = useCallback((next: string) => {
    pendingEditorTextRef.current = next;
    pendingEditorTextRevisionRef.current = textRevision;
    pendingEditorStatusRef.current?.markPendingText(next, textRevision);
    onTextChange(next);
  }, [onTextChange, textRevision]);

  useEffect(() => {
    saveReadingPage(authorScope, repositoryKey, scene.id, readingPage);
  }, [authorScope, repositoryKey, scene.id, readingPage]);

  useEffect(() => setReadingPage(loadReadingPage(authorScope, repositoryKey, scene.id)), [authorScope, repositoryKey, scene.id]);

  useEffect(() => {
    if (!resumeRequest || resumeRequest.repositoryKey !== repositoryKey || resumeRequest.sceneId !== scene.id) return;
    if (resumeRequest.pageIndex !== undefined && resumeRequest.pageIndex !== null) {
      setReadingPage(resumeRequest.pageIndex);
      setReading(true);
      onResumeRequestApplied(resumeRequest.id);
      return;
    }
    const frame = requestAnimationFrame(() => {
      editorRef.current?.restorePosition({
        cursorSentenceIndex: resumeRequest.cursorSentenceIndex,
        scrollTop: resumeRequest.scrollTop,
      });
      editorRef.current?.focus();
      onResumeRequestApplied(resumeRequest.id);
    });
    return () => cancelAnimationFrame(frame);
  }, [repositoryKey, scene.id, resumeRequest, onResumeRequestApplied]);

  const changeReadingPage = useCallback((pageIndex: number) => {
    setReadingPage(pageIndex);
    onReadingPageChange(scene.id, pageIndex);
  }, [onReadingPageChange, scene.id]);

  function printManuscript(): void {
    flushPendingReactPublish();
    setPrinting(true);
    requestAnimationFrame(() => {
      window.print();
      setPrinting(false);
    });
  }

  return (
    <PendingEditorTextBoundary ref={pendingEditorStatusRef} text={text} textRevision={textRevision}>
    <section className={`editor ${zen ? "is-zen" : ""} ${zen && typewriterDim && !vertical ? "is-typewriter-dim" : ""}`} aria-label="原稿エディター">
      <header className="editor-header">
        <div className="scene-heading">
          <p className="eyebrow">{breadcrumb}</p>
          <h1>{scene.title}</h1>
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

      <details className="editor-protection" open={Boolean(journalError) || undefined}>
        <summary aria-label="原稿の保護範囲を確認"><EditorDurabilityBadges durability={durability} pendingCount={pendingCount} draftStored={draftStored} journalError={journalError} /></summary>
        <div className="editor-protection-detail">
          <EditorDurabilityMessage durability={durability} draftStored={draftStored} journalError={journalError} />
          {journalError && <button type="button" onClick={onRetryDraft}>ブラウザーへの記録を再試行</button>}
          <p>Draftは同じブラウザー・作者・origin内の回復用です。Checkpointはこのブラウザーのlocal Git、GitHubへの保存は確認したrevisionだけが対象です。</p>
          <p>原稿 <code>{path}</code></p>
          <p>読込revision <code>{snapshot.overlayCommit ?? snapshot.remoteCommit}</code></p>
        </div>
      </details>

      {conflict && (
        <section className="conflict" aria-labelledby="conflict-title">
          <h2 id="conflict-title">リモートの原稿が更新されています</h2>
          <p>保護された下書きはそのままです。現在の GitHub 版を確認してから、この下書きを明示的に結び直してください。</p>
          <details>
            <summary>現在の GitHub 版</summary>
            <pre>{conflict.scene.text}</pre>
          </details>
          <div className="conflict-actions">
            <button type="button" onClick={onRebase} disabled={!canResolveDraft || editorReadOnly}>比較して下書きを最新の版に結び直す</button>
            <button type="button" className="quiet-button" onClick={onRestoreRemote} disabled={!canResolveDraft || editorReadOnly}>この文書の未チェックポイント下書きを削除して GitHub 版に戻す</button>
          </div>
        </section>
      )}

      <nav className="writing-toolbar" aria-label="執筆と閲覧">
        <button type="button" className="quiet-button" onClick={() => { flushPendingReactPublish(); setReading((current) => !current); }} aria-pressed={reading}>{reading ? "編集に戻る" : "読書モード"}</button>
        <button type="button" className="quiet-button" onClick={() => setVertical((current) => !current)} aria-pressed={vertical}>{vertical ? "横書き" : "縦書き"}</button>
        <button type="button" className="quiet-button" onClick={() => setPreview((current) => !current)} aria-pressed={preview}>プレビュー</button>
        <button type="button" className="quiet-button" onClick={() => setZen((current) => !current)} aria-pressed={zen}>{zen ? "集中を終了" : "集中"}</button>
        <button type="button" className="quiet-button" onClick={printManuscript}>印刷</button>
      </nav>
      <details className="typography-settings">
      <summary>文字と組版</summary>
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
        <label className="toolbar-group typography-preset">組版
          <select aria-label="組版プリセット" value={matchingPreset(typography) ?? "custom"} onChange={(event) => {
            const id = event.currentTarget.value as TypographyPresetId | "custom";
            if (id !== "custom") setTypography((value) => ({ ...value, ...typographyPresetValues(id) }));
          }}>
            <option value="custom">カスタム</option>
            {Object.entries(TYPOGRAPHY_PRESETS).map(([id, preset]) => <option key={id} value={id}>{preset.label}</option>)}
          </select>
        </label>
        <div className="toolbar-group" aria-label="読書幅">
          <button type="button" className="quiet-button compact-button" onClick={() => setTypography((value) => ({ ...value, maxWidth: Math.max(480, value.maxWidth - 40) }))} aria-label="読書幅を狭く" disabled={typography.maxWidth <= 480}>幅 −</button>
          <output aria-label="読書幅">{typography.maxWidth}px</output>
          <button type="button" className="quiet-button compact-button" onClick={() => setTypography((value) => ({ ...value, maxWidth: Math.min(960, value.maxWidth + 40) }))} aria-label="読書幅を広く" disabled={typography.maxWidth >= 960}>幅 ＋</button>
        </div>
        {zen && <button type="button" className="quiet-button" onClick={() => setTypewriterDim((current) => !current)} aria-pressed={typewriterDim}>現在行以外を減光</button>}
      </nav>
      </details>

      {reading && (
        <section
          className={`reading-view ${vertical ? "is-vertical" : ""}`}
          aria-label={vertical ? "縦書き読書モード" : "読書モード"}
          role="document"
          tabIndex={-1}
          style={readerStyle(typography)}
        >
          <MobileReadingPager mode={vertical ? "vertical" : "horizontal"} pageIndex={readingPage} onPageIndexChange={changeReadingPage}>
            <TermAwareRubyText
              key={`${repositoryKey}:${snapshotIdentity}:${path}`}
              text={displayText}
              resolveTerms={resolveTerms}
              onTermNavigate={onTermNavigate}
            />
          </MobileReadingPager>
        </section>
      )}
      <div className={`editor-columns ${preview ? "has-preview" : ""}`} hidden={reading} style={reading ? { display: "none" } : undefined}>
          <div className="manuscript-column">
            <label id="manuscript-label" htmlFor="manuscript">原稿 Markdown</label>
            <ManuscriptInput
              ref={editorRef}
              value={text}
              externalTextRevision={textRevision}
              readOnly={editorReadOnly}
              onChange={onEditorTextChange}
              onCursorPositionChange={(cursorSentenceIndex, scrollTop) => onCursorPositionChange(scene.id, cursorSentenceIndex, scrollTop)}
              onSelectionLengthChange={setSelectionLength}
              resolveTerms={reading ? undefined : resolveTerms}
              onTermNavigate={onTermNavigate}
              termResolutionKey={`${repositoryKey}:${snapshotIdentity}:${scene.id}:${path}`}
              labelledBy="manuscript-label"
              placeholder="物語の続きを書く"
              style={{
                "--editor-font-size": `${typography.fontSize}px`,
                "--editor-line-height": `${typography.lineHeight}`,
                "--editor-letter-spacing": `${typography.letterSpacing}em`,
                "--editor-font-family": typography.fontFamily === "mincho" ? "var(--manuscript-serif)" : "var(--manuscript-sans)",
                "--reader-font-size": `${typography.fontSize}px`,
                "--reader-line-height": `${typography.lineHeight}`,
                "--reader-letter-spacing": `${typography.letterSpacing}em`,
                "--reader-font-family": typography.fontFamily === "mincho" ? "var(--manuscript-serif)" : "var(--manuscript-sans)",
                "--reader-max-width": `${typography.maxWidth}px`,
              } as CSSProperties}
            />
            <p className="editor-hint">{displayText.length} 字 · 400字詰め換算 {displayText.length === 0 ? 0 : Math.ceil(displayText.length / 400)} 枚{selectionLength > 0 ? ` · 選択 ${selectionLength} 字 / 400字詰め換算 ${Math.ceil(selectionLength / 400)} 枚` : ""}。入力は IndexedDB に自動記録されます。</p>
            <div className="mobile-keyboard" aria-label="日本語入力補助">
              {WRITING_SYMBOLS.map(({ id, label, ariaLabel }) => (
                <button type="button" key={id} aria-label={ariaLabel} onClick={() => editorRef.current?.insert(id)} disabled={editorReadOnly}>{label}</button>
              ))}
            </div>
            <ScratchPanel
              disabled={scratchBusy || editorReadOnly}
              entries={scratchEntries}
              binding={{ repositoryKey, snapshot, sceneId: scene.id, documentPath: path }}
              onCheckpoint={onCheckpointScratch}
              onDraft={onDraftScratch}
              registerFlush={registerScratchFlush}
            />
          </div>
          <section className="preview-column" aria-labelledby="preview-title" hidden={!preview}>
            <h2 id="preview-title">{vertical ? "縦書きプレビュー" : "読みのプレビュー"}</h2>
            <div className={`manuscript-preview ${vertical ? "is-vertical" : ""}`} role="document" aria-label="ルビ付き読み取り専用プレビュー" style={readerStyle(typography)}>
              <RubyText text={displayText} />
            </div>
          </section>
      </div>
      <div className={`print-view ${vertical ? "is-vertical" : ""}`} aria-hidden={!printing} style={readerStyle(typography)}>
        <RubyText text={displayText} className="print-manuscript" />
      </div>
      {historyOpen && !historyExternal && historyContent}
    </section>
    </PendingEditorTextBoundary>
  );
}

function matchingPreset(settings: TypographySettings): string {
  for (const [id, preset] of Object.entries(TYPOGRAPHY_PRESETS)) {
    if (settings.fontFamily === preset.values.fontFamily && settings.lineHeight === preset.values.lineHeight && settings.letterSpacing === preset.values.letterSpacing && settings.maxWidth === preset.values.maxWidth) return id;
  }
  return "custom";
}

function readerStyle(settings: TypographySettings): CSSProperties {
  return {
    "--reader-font-size": `${settings.fontSize}px`,
    "--reader-line-height": `${settings.lineHeight}`,
    "--reader-letter-spacing": `${settings.letterSpacing}em`,
    "--reader-font-family": settings.fontFamily === "mincho" ? "var(--manuscript-serif)" : "var(--manuscript-sans)",
    "--reader-max-width": `${settings.maxWidth}px`,
  } as CSSProperties;
}

function attachmentDrafts(entry: JournalEntry): ScratchAttachmentDraft[] {
  return entry.operation.writes
    .filter((write) => write.path !== entry.documentPath && write.content !== null && write.encoding === "base64")
    .map((write) => {
      const filename = write.path.split("/").at(-1) ?? "capture.jpg";
      const extension = filename.split(".").at(-1)?.toLowerCase();
      const mimeType = extension === "png" ? "image/png" : extension === "webp" ? "image/webp" : extension === "gif" ? "image/gif" : "image/jpeg";
      return { filename, mimeType, dataBase64: write.content as string, path: write.path };
    });
}

function scratchCreatedAt(entry: JournalEntry): string | undefined {
  const content = entry.operation.writes.find((write) => write.path === entry.documentPath)?.content;
  if (typeof content === "string") {
    const raw = content.match(/^createdAt:\s*(.+)$/mu)?.[1];
    if (raw) {
      try {
        const value: unknown = JSON.parse(raw);
        if (typeof value === "string" && Number.isFinite(Date.parse(value))) return value;
      } catch { /* Older or malformed scratch metadata is preserved without synthesizing new bytes. */ }
    }
  }
  return undefined;
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string") return reject(new Error("画像ファイルを読み込めませんでした。"));
      const comma = result.indexOf(",");
      resolve(comma < 0 ? result : result.slice(comma + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error("画像ファイルを読み込めませんでした。"));
    reader.readAsDataURL(file);
  });
}

function ScratchPanel({
  disabled,
  entries,
  binding,
  onCheckpoint,
  onDraft,
  registerFlush,
}: {
  disabled: boolean;
  entries: JournalEntry[];
  binding: ScratchDraftBinding;
  onCheckpoint: (entry: JournalEntry) => Promise<void>;
  onDraft: (draft: ScratchDraftPayload, binding: ScratchDraftBinding) => Promise<JournalEntry | null>;
  registerFlush: (flush: (() => Promise<JournalEntry | null>) | null) => void;
}) {
  const initialDraft = (): ScratchDraftPayload => ({ id: crypto.randomUUID(), generation: 0, createdAt: new Date().toISOString(), text: "", attachments: [] });
  const [draft, setDraft] = useState<ScratchDraftPayload>(initialDraft);
  const [stored, setStored] = useState(true);
  const [error, setError] = useState("");
  const [checkingId, setCheckingId] = useState("");
  const [resumedId, setResumedId] = useState("");
  const [resumingKey, setResumingKey] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const draftRef = useRef(draft);
  const bindingRef = useRef(binding);
  const disposedRef = useRef(false);
  const pendingImageReadsRef = useRef(new Set<Promise<void>>());
  const imageQueueRef = useRef<Promise<void>>(Promise.resolve());
  const persistQueueRef = useRef<Promise<void>>(Promise.resolve());
  const onDraftRef = useRef(onDraft);
  const onCheckpointRef = useRef(onCheckpoint);
  onDraftRef.current = onDraft;
  onCheckpointRef.current = onCheckpoint;
  draftRef.current = draft;
  bindingRef.current = binding;

  const persist = useCallback(async (target: ScratchDraftPayload, targetBinding: ScratchDraftBinding): Promise<JournalEntry | null> => {
    const queued = persistQueueRef.current.then(() => onDraftRef.current(target, targetBinding));
    persistQueueRef.current = queued.then(() => undefined, () => undefined);
    const entry = await queued;
    if (!disposedRef.current && entry && draftRef.current.id === target.id && draftRef.current.generation === target.generation) {
      setStored(true);
      setError("");
    }
    return entry;
  }, []);

  const flush = useCallback(async (): Promise<JournalEntry | null> => {
    const targetBinding = bindingRef.current;
    await Promise.all([...pendingImageReadsRef.current]);
    for (let attempt = 0; attempt < 8; attempt++) {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      if (disposedRef.current || JSON.stringify(bindingRef.current) !== JSON.stringify(targetBinding)) {
        throw new Error("移動先が変わったため、古いシーンのスクラッチを保存できませんでした。");
      }
      const target = draftRef.current;
      if (!target.text.trim() && target.attachments.length === 0) return null;
      const existing = entries.find((entry) => entry.operation.id === target.id && entry.operation.generation === target.generation);
      if (stored && existing) return existing;
      try {
        const entry = await persist(target, targetBinding);
        if (draftRef.current.id !== target.id || draftRef.current.generation !== target.generation) continue;
        if (!entry) throw new Error("新しい世代のスクラッチがあるため、この記録は置き換えませんでした。");
        return entry;
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : "スクラッチの回復記録を保存できませんでした。";
        if (draftRef.current.id === target.id && draftRef.current.generation === target.generation) {
          setError(message);
          setStored(false);
        }
        throw caught;
      }
    }
    throw new Error("スクラッチの入力が続いているため、移動前に保存できませんでした。");
  }, [entries, persist, stored]);

  useEffect(() => {
    registerFlush(flush);
    const beforeUnload = (event: BeforeUnloadEvent) => {
      const current = draftRef.current;
      if (pendingImageReadsRef.current.size > 0 || (!stored && (current.text.trim() || current.attachments.length > 0))) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => {
      window.removeEventListener("beforeunload", beforeUnload);
      registerFlush(null);
      if (timer.current) clearTimeout(timer.current);
    };
  }, [flush, registerFlush, stored]);

  useEffect(() => () => { disposedRef.current = true; }, []);

  function updateDraft(next: ScratchDraftPayload): void {
    const targetBinding = bindingRef.current;
    draftRef.current = next;
    setDraft(next);
    setStored(false);
    setError("");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      void persist(next, targetBinding).catch((caught: unknown) => {
        if (!disposedRef.current && JSON.stringify(bindingRef.current) === JSON.stringify(targetBinding)) {
          setError(caught instanceof Error ? caught.message : "スクラッチの回復記録を保存できませんでした。");
        }
      });
    }, 350);
  }

  function editText(text: string): void {
    const current = draftRef.current;
    updateDraft({ ...current, generation: current.generation + 1, text });
  }

  async function addImages(files: FileList | null): Promise<void> {
    const selected = Array.from(files ?? []);
    if (selected.length === 0) return;
    const targetBinding = bindingRef.current;
    const targetDraftId = draftRef.current.id;
    const task = imageQueueRef.current.then(async () => {
      if (disposedRef.current || JSON.stringify(bindingRef.current) !== JSON.stringify(targetBinding) || draftRef.current.id !== targetDraftId) return;
      const current = draftRef.current;
      let totalBytes = current.attachments.reduce((sum, attachment) => sum + attachment.dataBase64.length, 0);
      const additions: ScratchAttachmentDraft[] = [];
      for (const file of selected) {
        if (!file.type.startsWith("image/")) throw new Error("スクラッチには画像ファイルを添付できます。");
        if (file.size > 3 * 1024 * 1024) throw new Error("画像は 1 件 3 MB 以下にしてください。");
        const dataBase64 = await fileToBase64(file);
        totalBytes += dataBase64.length;
        if (totalBytes > 5 * 1024 * 1024) throw new Error("添付画像の合計は 5 MB 以下にしてください。");
        additions.push({ filename: file.name || "capture.jpg", mimeType: file.type || "image/jpeg", dataBase64 });
      }
      if (disposedRef.current || JSON.stringify(bindingRef.current) !== JSON.stringify(targetBinding) || draftRef.current.id !== targetDraftId) return;
      const latest = draftRef.current;
      updateDraft({ ...latest, generation: latest.generation + 1, attachments: [...latest.attachments, ...additions] });
    });
    pendingImageReadsRef.current.add(task);
    imageQueueRef.current = task.catch(() => undefined);
    try {
      await task;
    } catch (caught) {
      if (!disposedRef.current && JSON.stringify(bindingRef.current) === JSON.stringify(targetBinding)) {
        setError(caught instanceof Error ? caught.message : "画像を添付できませんでした。");
      }
    } finally {
      pendingImageReadsRef.current.delete(task);
    }
  }

  async function resume(entry: JournalEntry): Promise<void> {
    if (resumingKey) return;
    const entryKey = `${entry.operation.id}:${entry.operation.generation}`;
    setResumingKey(entryKey);
    try {
      await flush();
      const current = draftRef.current;
      if ((current.text.trim() || current.attachments.length > 0) &&
          current.id === entry.operation.id && current.generation > entry.operation.generation) {
        setError("このスクラッチより新しい入力をDraftとして保護しました。最新の回復記録を選び直してください。");
        return;
      }
      const resumed: ScratchDraftPayload = {
        id: entry.operation.id,
        generation: entry.operation.generation,
        createdAt: scratchCreatedAt(entry),
        text: entry.text,
        attachments: attachmentDrafts(entry),
      };
      draftRef.current = resumed;
      setDraft(resumed);
      setStored(true);
      setResumedId(entry.operation.id);
      setError("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "現在のスクラッチを保護できなかったため、回復記録を開きませんでした。");
    } finally {
      setResumingKey("");
    }
  }

  async function checkpoint(entry?: JournalEntry): Promise<void> {
    try {
      const target = entry ?? await flush();
      if (!target) throw new Error("チェックポイントに含めるスクラッチがありません。");
      setCheckingId(target.operation.id);
      await onCheckpointRef.current(target);
      if (draftRef.current.id === target.operation.id) {
        const empty = initialDraft();
        draftRef.current = empty;
        setDraft(empty);
        setStored(true);
        setResumedId("");
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "スクラッチのチェックポイントに失敗しました。");
    } finally {
      setCheckingId("");
    }
  }

  const pending = entries.filter((entry) => entry.documentPath.startsWith("meta/scratch/"))
    .sort((left, right) => right.updatedAt - left.updatedAt);
  const hasActiveDraft = draft.text.trim().length > 0 || draft.attachments.length > 0;

  return (
    <details className="scratch-panel">
      <summary>スクラッチ <span>{draft.text.trim().length} 字 {hasActiveDraft ? stored ? "· Draft を保護済み" : "· Draft を保存中" : ""}</span></summary>
      <label htmlFor="scratch">本文に含まれないメモ</label>
      <textarea
        id="scratch"
        value={draft.text}
        disabled={disabled || resumingKey !== ""}
        onChange={(event) => editText(event.currentTarget.value)}
        onBlur={() => void flush().catch(() => undefined)}
        placeholder="台詞候補・没文など。本文には入りません"
        spellCheck={false}
      />
      <label className="scratch-attachment-picker">
        画像を添付
        <input aria-label="スクラッチ画像を添付" type="file" accept="image/*" capture="environment" multiple disabled={disabled || resumingKey !== ""} onChange={(event) => {
          void addImages(event.currentTarget.files);
          event.currentTarget.value = "";
        }} />
      </label>
      {draft.attachments.length > 0 && <p className="muted-list-item">画像 {draft.attachments.length} 件</p>}
      {error && <p className="status" data-kind="error" role="alert">{error}</p>}
      <button type="button" onClick={() => void checkpoint()} disabled={disabled || !hasActiveDraft || !stored || checkingId !== "" || resumingKey !== ""}>
        {checkingId === draft.id ? "確認中…" : resumedId === draft.id ? "このスクラッチをチェックポイント" : "スクラッチをチェックポイント"}
      </button>
      {pending.length > 0 && (
        <ul className="scratch-recovery-list" aria-label="回復できるスクラッチ">
          {pending.map((entry) => (
            <li key={`${entry.operation.id}:${entry.operation.generation}`}>
              <span>{entry.text.slice(0, 72) || "画像メモ"} · {entry.state === "draft" ? "Draft" : entry.state === "checkpointing" ? "確認中" : entry.state === "conflict" ? "競合" : "Checkpoint"}</span>
              {entry.state === "draft" && <button type="button" onClick={() => void resume(entry)} disabled={disabled || resumingKey !== ""}>{resumingKey === `${entry.operation.id}:${entry.operation.generation}` ? "保護を確認中…" : "続ける"}</button>}
              {entry.state === "draft" && <button type="button" onClick={() => void checkpoint(entry)} disabled={disabled || checkingId !== "" || resumingKey !== ""}>Checkpoint</button>}
            </li>
          ))}
        </ul>
      )}
    </details>
  );
}
