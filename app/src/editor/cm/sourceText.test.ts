import assert from "node:assert/strict";
import test from "node:test";
import { EditorState } from "@codemirror/state";
import { history, undo } from "@codemirror/commands";
import { manuscriptSourceText } from "./sourceText.js";

test("opening, editing and undo preserve exact CRLF source and source-span offsets", () => {
  const source = "前書き\r\n|漢字《かんじ》\r\n本文\r\n";
  let state = EditorState.create({ doc: source, extensions: [manuscriptSourceText, history()] });
  assert.equal(state.doc.toString(), source);
  const start = source.indexOf("本文");
  assert.equal(state.doc.sliceString(start, start + 2), "本文");
  state = state.update({ changes: { from: start, to: start + 2, insert: "推敲文" } }).state;
  assert.equal(state.doc.toString(), source.replace("本文", "推敲文"));
  assert.equal(undo({ state, dispatch: transaction => { state = transaction.state; } }), true);
  assert.equal(state.doc.toString(), source);
});
