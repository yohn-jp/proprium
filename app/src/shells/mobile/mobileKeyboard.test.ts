import assert from "node:assert/strict";
import { test } from "node:test";
import { isWritingKeyboardVisible, type WritingViewportSample } from "./mobileKeyboard";

const base: WritingViewportSample = {
  editorFocused: true, lastUnfocusedHeight: 844, windowHeight: 844,
  visualHeight: 844, visualOffsetTop: 0,
};
test("soft keyboard hides chrome only when the editor is focused and occluded", () => {
  assert.equal(isWritingKeyboardVisible(base), false);
  assert.equal(isWritingKeyboardVisible({ ...base, visualHeight: 540 }), true);
  assert.equal(isWritingKeyboardVisible({ ...base, windowHeight: 560, visualHeight: 560 }), true);
  assert.equal(isWritingKeyboardVisible({ ...base, visualHeight: 740 }), false);
  assert.equal(isWritingKeyboardVisible({ ...base, editorFocused: false, visualHeight: 540 }), false);
  assert.equal(isWritingKeyboardVisible({ ...base, editorFocused: false, windowHeight: 560, visualHeight: 560 }), false);
});
test("invalid and offset visual viewport measurements never infer a keyboard", () => {
  assert.equal(isWritingKeyboardVisible({ ...base, visualHeight: null }), false);
  assert.equal(isWritingKeyboardVisible({ ...base, visualHeight: Number.NaN }), false);
  assert.equal(isWritingKeyboardVisible({ ...base, visualHeight: 680, visualOffsetTop: 40 }), false);
  assert.equal(isWritingKeyboardVisible({ ...base, lastUnfocusedHeight: 0 }), false);
});
