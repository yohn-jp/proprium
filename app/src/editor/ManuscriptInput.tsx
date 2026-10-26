import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { Compartment, EditorState, Transaction } from "@codemirror/state";
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  keymap,
  placeholder as cmPlaceholder,
} from "@codemirror/view";
import { forwardRef, useEffect, useImperativeHandle, useRef, type CSSProperties } from "react";
import { bracketPairsExtension } from "./cm/bracketPairs";
import { editorCompositionExtension, isViewComposing } from "./cm/compositionGuard";
import { ellipsisNormalizeExtension } from "./cm/ellipsisNormalize";
import { refreshTermAdornments, termAdornmentsExtension } from "./cm/termAdornments";
import { planWritingSymbol, type WritingSymbolId } from "./writingSymbols";
import { type ResolveEditorTerms } from "./terms";
import { createUiSentencePositionIndexCache, type UiSentencePositionIndexCache } from "../resume/continueCandidates";
import "./terminology.css";

export interface ManuscriptInputHandle {
  focus(): void;
  flushComposition(): Promise<string>;
  insert(symbol: WritingSymbolId): void;
  restorePosition(position: { cursorSentenceIndex: number | null; scrollTop: number }): void;
  getScrollTop(): number;
}

export interface ManuscriptInputProps {
  value: string;
  externalTextRevision: number;
  readOnly?: boolean;
  onChange: (value: string) => void;
  onSelectionLengthChange?: (length: number) => void;
  onCursorPositionChange?: (cursorSentenceIndex: number | null, scrollTop: number) => void;
  placeholder?: string;
  labelledBy: string;
  style?: CSSProperties;
  resolveTerms?: ResolveEditorTerms;
  onTermNavigate?: (targetPath: string, termId: string, event: Event) => void;
  onCompositionChange?: (composing: boolean) => void;
  termResolutionKey?: string;
}

/** CodeMirror adapter retaining IME-safe editing, source bracket/ellipsis rules and history keymaps. */
export const ManuscriptInput = forwardRef<ManuscriptInputHandle, ManuscriptInputProps>(function ManuscriptInput({
  value,
  externalTextRevision,
  readOnly = false,
  onChange,
  onSelectionLengthChange,
  onCursorPositionChange,
  placeholder,
  labelledBy,
  style,
  resolveTerms,
  onTermNavigate,
  onCompositionChange,
  termResolutionKey,
}, ref) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const sentencePositionIndexRef = useRef<UiSentencePositionIndexCache<EditorState["doc"]> | null>(null);
  const editabilityCompartment = useRef(new Compartment()).current;
  const externalSyncRef = useRef(false);
  const suppressPositionRef = useRef(false);
  const resolverRef = useRef<ResolveEditorTerms | undefined>(resolveTerms);
  const navigatorRef = useRef<((targetPath: string, termId: string, event: Event) => void) | undefined>(onTermNavigate);
  resolverRef.current = resolveTerms;
  navigatorRef.current = onTermNavigate;
  const latestRef = useRef({ onChange, onSelectionLengthChange, onCursorPositionChange, onCompositionChange });
  latestRef.current = { onChange, onSelectionLengthChange, onCursorPositionChange, onCompositionChange };
  const reportedComposition = useRef<boolean | null>(null);

  function reportComposition(view: EditorView): void {
    const composing = isViewComposing(view);
    if (reportedComposition.current === composing) return;
    reportedComposition.current = composing;
    latestRef.current.onCompositionChange?.(composing);
  }

  function sentencePositionIndex(doc: EditorState["doc"], text?: string) {
    const cache = sentencePositionIndexRef.current ??= createUiSentencePositionIndexCache<EditorState["doc"]>();
    return cache.get(doc, text);
  }

  function reportPosition(view: EditorView): void {
    if (suppressPositionRef.current) return;
    const selection = view.state.selection.main;
    latestRef.current.onCursorPositionChange?.(
      sentencePositionIndex(view.state.doc).indexAtOffset(selection.head),
      Math.max(0, view.scrollDOM.scrollTop),
    );
  }

  useImperativeHandle(ref, () => ({
    focus() {
      viewRef.current?.focus();
    },
    async flushComposition() {
      const view = viewRef.current;
      if (!view) return "";
      if (isViewComposing(view)) {
        view.contentDOM.blur();
        await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
        await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
        if (isViewComposing(view)) {
          throw new Error("日本語入力の変換が完了していません。変換を確定してから画面を切り替えてください。");
        }
      }
      return view.state.doc.toString();
    },
    insert(symbol) {
      const view = viewRef.current;
      if (!view) return;
      const selection = view.state.selection.main;
      const plan = planWritingSymbol(view.state.doc.toString(), selection.from, selection.to, symbol);
      view.dispatch({
        changes: { from: plan.from, to: plan.to, insert: plan.insert },
        selection: { anchor: plan.cursor },
        userEvent: "input.type",
      });
      view.focus();
    },
    restorePosition(position) {
      const view = viewRef.current;
      if (!view) return;
      const offset = sentencePositionIndex(view.state.doc).offsetAtIndex(position.cursorSentenceIndex);
      suppressPositionRef.current = true;
      if (offset !== null) {
        view.dispatch({
          selection: { anchor: Math.max(0, Math.min(offset, view.state.doc.length)) },
          annotations: Transaction.addToHistory.of(false),
        });
      }
      view.scrollDOM.scrollTop = Math.max(0, position.scrollTop);
      requestAnimationFrame(() => { suppressPositionRef.current = false; });
    },
    getScrollTop() {
      return Math.max(0, viewRef.current?.scrollDOM.scrollTop ?? 0);
    },
  }), []);

  useEffect(() => {
    const parent = containerRef.current;
    if (!parent) return;
    const state = EditorState.create({
      doc: value,
      extensions: [
        history(),
        editabilityCompartment.of(editabilityExtensions(readOnly)),
        drawSelection(),
        highlightActiveLine(),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        bracketPairsExtension(),
        ellipsisNormalizeExtension(),
        editorCompositionExtension(),
        termAdornmentsExtension(resolverRef, navigatorRef),
        styleNonceExtension(),
        EditorView.lineWrapping,
        EditorView.contentAttributes.of({
          id: "manuscript",
          "aria-labelledby": labelledBy,
          "aria-multiline": "true",
          role: "textbox",
          spellcheck: "false",
          autocapitalize: "off",
          enterkeyhint: "enter",
        }),
        EditorView.updateListener.of((update) => {
          reportComposition(update.view);
          const changedText = update.docChanged ? update.state.doc.toString() : null;
          const changedDocumentIndex = update.docChanged
            ? sentencePositionIndex(update.state.doc, changedText ?? undefined)
            : null;
          if (update.docChanged) {
            if (externalSyncRef.current) externalSyncRef.current = false;
            else if (changedText !== null) latestRef.current.onChange(changedText);
          }
          if (update.docChanged || update.selectionSet) {
            const selection = update.state.selection.main;
            latestRef.current.onSelectionLengthChange?.(selection.empty ? 0 : Math.abs(selection.to - selection.from));
            if (!externalSyncRef.current) {
              latestRef.current.onCursorPositionChange?.(
                (changedDocumentIndex ?? sentencePositionIndex(update.state.doc)).indexAtOffset(selection.head),
                Math.max(0, viewRef.current?.scrollDOM.scrollTop ?? 0),
              );
            }
          }
        }),
        placeholder ? cmPlaceholder(placeholder) : [],
      ],
    });
    sentencePositionIndex(state.doc, state.doc.toString());
    const view = new EditorView({ state, parent });
    viewRef.current = view;
    reportComposition(view);
    const onScroll = () => reportPosition(view);
    view.scrollDOM.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      reportedComposition.current = null;
      latestRef.current.onCompositionChange?.(false);
      view.scrollDOM.removeEventListener("scroll", onScroll);
      view.destroy();
      viewRef.current = null;
    };
  // CodeMirror initializes once; changing value and callbacks flow through refs and the sync effect.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    if (view) view.dispatch({ effects: editabilityCompartment.reconfigure(editabilityExtensions(readOnly)) });
  }, [editabilityCompartment, readOnly]);

  useEffect(() => {
    const view = viewRef.current;
    if (view) view.dispatch({ effects: refreshTermAdornments.of(null) });
  }, [resolveTerms, onTermNavigate, termResolutionKey]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || view.state.doc.toString() === value) return;
    externalSyncRef.current = true;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: value },
      annotations: Transaction.addToHistory.of(false),
    });
  }, [externalTextRevision, value]);

  return <div ref={containerRef} className="manuscript-input" style={style} data-testid="manuscript-input" />;
});

function styleNonceExtension() {
  const nonce = document.querySelector<HTMLMetaElement>('meta[name="scriptorium-style-nonce"]')?.content;
  return nonce && nonce !== "__SCRIPTORIUM_STYLE_NONCE__" ? EditorView.cspNonce.of(nonce) : [];
}

function editabilityExtensions(readOnly: boolean) {
  return [EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)];
}
