import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { EditorState, Transaction } from "@codemirror/state";
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  keymap,
  placeholder as cmPlaceholder,
} from "@codemirror/view";
import { forwardRef, useEffect, useImperativeHandle, useRef, type CSSProperties } from "react";
import { bracketPairsExtension } from "./cm/bracketPairs";
import { editorCompositionExtension } from "./cm/compositionGuard";
import { ellipsisNormalizeExtension } from "./cm/ellipsisNormalize";
import { planWritingSymbol, type WritingSymbolId } from "./writingSymbols";
import { offsetAtUiSentenceIndex, uiSentenceIndexAtOffset } from "../resume/continueCandidates";

export interface ManuscriptInputHandle {
  focus(): void;
  insert(symbol: WritingSymbolId): void;
  restorePosition(position: { cursorSentenceIndex: number | null; scrollTop: number }): void;
  getScrollTop(): number;
}

export interface ManuscriptInputProps {
  value: string;
  readOnly?: boolean;
  onChange: (value: string) => void;
  onSelectionLengthChange?: (length: number) => void;
  onCursorPositionChange?: (cursorSentenceIndex: number | null, scrollTop: number) => void;
  placeholder?: string;
  labelledBy: string;
  style?: CSSProperties;
}

/** CodeMirror adapter retaining IME-safe editing, source bracket/ellipsis rules and history keymaps. */
export const ManuscriptInput = forwardRef<ManuscriptInputHandle, ManuscriptInputProps>(function ManuscriptInput({
  value,
  readOnly = false,
  onChange,
  onSelectionLengthChange,
  onCursorPositionChange,
  placeholder,
  labelledBy,
  style,
}, ref) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const externalSyncRef = useRef(false);
  const suppressPositionRef = useRef(false);
  const latestRef = useRef({ onChange, onSelectionLengthChange, onCursorPositionChange });
  latestRef.current = { onChange, onSelectionLengthChange, onCursorPositionChange };

  function reportPosition(view: EditorView): void {
    if (suppressPositionRef.current) return;
    const selection = view.state.selection.main;
    latestRef.current.onCursorPositionChange?.(
      uiSentenceIndexAtOffset(view.state.doc.toString(), selection.head),
      Math.max(0, view.scrollDOM.scrollTop),
    );
  }

  useImperativeHandle(ref, () => ({
    focus() {
      viewRef.current?.focus();
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
      const offset = offsetAtUiSentenceIndex(view.state.doc.toString(), position.cursorSentenceIndex);
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
        EditorState.readOnly.of(readOnly),
        EditorView.editable.of(!readOnly),
        drawSelection(),
        highlightActiveLine(),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        bracketPairsExtension(),
        ellipsisNormalizeExtension(),
        editorCompositionExtension(),
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
          if (update.docChanged) {
            if (externalSyncRef.current) externalSyncRef.current = false;
            else latestRef.current.onChange(update.state.doc.toString());
          }
          if (update.docChanged || update.selectionSet) {
            const selection = update.state.selection.main;
            latestRef.current.onSelectionLengthChange?.(selection.empty ? 0 : Math.abs(selection.to - selection.from));
            if (!externalSyncRef.current) {
              latestRef.current.onCursorPositionChange?.(
                uiSentenceIndexAtOffset(update.state.doc.toString(), selection.head),
                Math.max(0, viewRef.current?.scrollDOM.scrollTop ?? 0),
              );
            }
          }
        }),
        placeholder ? cmPlaceholder(placeholder) : [],
      ],
    });
    const view = new EditorView({ state, parent });
    viewRef.current = view;
    const onScroll = () => reportPosition(view);
    view.scrollDOM.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      view.scrollDOM.removeEventListener("scroll", onScroll);
      view.destroy();
      viewRef.current = null;
    };
  // CodeMirror initializes once; changing value and callbacks flow through refs and the sync effect.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || view.state.doc.toString() === value) return;
    externalSyncRef.current = true;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: value },
      annotations: Transaction.addToHistory.of(false),
    });
  }, [value]);

  return <div ref={containerRef} className="manuscript-input" style={style} data-testid="manuscript-input" />;
});

function styleNonceExtension() {
  const nonce = document.querySelector<HTMLMetaElement>('meta[name="scriptorium-style-nonce"]')?.content;
  return nonce && nonce !== "__SCRIPTORIUM_STYLE_NONCE__" ? EditorView.cspNonce.of(nonce) : [];
}
