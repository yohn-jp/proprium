import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { EditorState } from "@codemirror/state";
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

export interface ManuscriptInputHandle {
  focus(): void;
  insert(symbol: WritingSymbolId): void;
}

export interface ManuscriptInputProps {
  value: string;
  onChange: (value: string) => void;
  onSelectionLengthChange?: (length: number) => void;
  placeholder?: string;
  labelledBy: string;
  style?: CSSProperties;
}

/** CodeMirror adapter retaining IME-safe editing, source bracket/ellipsis rules and history keymaps. */
export const ManuscriptInput = forwardRef<ManuscriptInputHandle, ManuscriptInputProps>(function ManuscriptInput({
  value,
  onChange,
  onSelectionLengthChange,
  placeholder,
  labelledBy,
  style,
}, ref) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const externalSyncRef = useRef(false);
  const latestRef = useRef({ onChange, onSelectionLengthChange });
  latestRef.current = { onChange, onSelectionLengthChange };

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
  }), []);

  useEffect(() => {
    const parent = containerRef.current;
    if (!parent) return;
    const state = EditorState.create({
      doc: value,
      extensions: [
        history(),
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
          }
        }),
        placeholder ? cmPlaceholder(placeholder) : [],
      ],
    });
    const view = new EditorView({ state, parent });
    viewRef.current = view;
    return () => {
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
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
  }, [value]);

  return <div ref={containerRef} className="manuscript-input" style={style} data-testid="manuscript-input" />;
});

function styleNonceExtension() {
  const nonce = document.querySelector<HTMLMetaElement>('meta[name="scriptorium-style-nonce"]')?.content;
  return nonce && nonce !== "__SCRIPTORIUM_STYLE_NONCE__" ? EditorView.cspNonce.of(nonce) : [];
}
