import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { resolveBracketInput } from "./bracketLogic";
import { isViewComposing } from "./compositionGuard";

export { BRACKET_PAIRS } from "./bracketLogic";

export function bracketPairsExtension(): Extension {
  return EditorView.inputHandler.of((view, from, to, text) => {
    if (isViewComposing(view)) return false;
    const resolved = resolveBracketInput(view.state.doc, from, to, text);
    if (!resolved) return false;
    if (resolved.insert === "") {
      view.dispatch({ selection: { anchor: resolved.cursor }, userEvent: "input.type" });
    } else {
      view.dispatch({
        changes: { from, to, insert: resolved.insert },
        selection: { anchor: resolved.cursor },
        userEvent: "input.type",
      });
    }
    return true;
  });
}
