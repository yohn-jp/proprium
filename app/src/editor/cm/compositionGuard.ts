import { type EditorState, type Extension, StateEffect, StateField } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

export const setEditorComposingEffect = StateEffect.define<boolean>();

export const editorComposingField = StateField.define<boolean>({
  create: () => false,
  update(composing, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(setEditorComposingEffect)) return effect.value;
    }
    return composing;
  },
});

export function isEditorComposing(state: EditorState): boolean {
  return state.field(editorComposingField, false) ?? false;
}

export function isViewComposing(view: EditorView): boolean {
  return view.composing || view.compositionStarted || isEditorComposing(view.state);
}

export function editorCompositionExtension(): Extension {
  return [
    editorComposingField,
    EditorView.domEventHandlers({
      compositionstart: (_event, view) => {
        if (!isEditorComposing(view.state)) view.dispatch({ effects: setEditorComposingEffect.of(true) });
        return false;
      },
      compositionend: (_event, view) => {
        if (isEditorComposing(view.state)) view.dispatch({ effects: setEditorComposingEffect.of(false) });
        return false;
      },
    }),
  ];
}
