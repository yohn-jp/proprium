import assert from "node:assert/strict";
import test from "node:test";
import { allChangedPathsReviewed, decodeGitText, historyHasUnsupportedModes } from "./git-review-content.js";

test("Git review decodes complete UTF-8 text and preserves line endings", () => {
  const bytes = new TextEncoder().encode("題名\r\n本文\n");
  assert.equal(decodeGitText(bytes), "題名\r\n本文\n");
  assert.equal(decodeGitText(new Uint8Array([0xef, 0xbb, 0xbf, 0x61])), "\ufeffa");
});

test("Git review marks invalid UTF-8 and NUL-bearing content as binary", () => {
  assert.equal(decodeGitText(new Uint8Array([0xff, 0x80, 0x00])), null);
  assert.equal(decodeGitText(new Uint8Array([0x61, 0x00, 0x62])), null);
});

test("local commit review is gated until every changed path is marked reviewed", () => {
  const paths = ["manuscript/scene-1.md", "notes/research.txt"];
  assert.equal(allChangedPathsReviewed([], new Set()), false);
  assert.equal(allChangedPathsReviewed(paths, new Set([paths[0]!])), false);
  assert.equal(allChangedPathsReviewed(paths, new Set(paths)), true);
});

test("byte-only history restore rejects executable additions, edits and symlinks", () => {
  assert.equal(historyHasUnsupportedModes([{ parentMode: null, commitMode: "100755" }]), true);
  assert.equal(historyHasUnsupportedModes([{ parentMode: "100755", commitMode: "100755" }]), true);
  assert.equal(historyHasUnsupportedModes([{ parentMode: "100755", commitMode: "100644" }]), true);
  assert.equal(historyHasUnsupportedModes([{ parentMode: null, commitMode: "120000" }]), true);
  assert.equal(historyHasUnsupportedModes([{ parentMode: null, commitMode: "100644" }, { parentMode: "100644", commitMode: null }]), false);
});
