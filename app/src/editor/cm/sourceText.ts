import { EditorState } from "@codemirror/state";

// Keep CR bytes in the document rather than normalizing CRLF on load/flush.
// Host source spans use UTF-16 offsets in the original, unnormalized text.
export const manuscriptSourceText = EditorState.lineSeparator.of("\n");
