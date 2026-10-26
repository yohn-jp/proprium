import assert from "node:assert/strict";
import test from "node:test";
import { snapshotProposalBefore } from "./proposal-review.js";

test("snapshots a UTF-8 original exactly and distinguishes a new file", () => {
  assert.equal(snapshotProposalBefore("note.md", new TextEncoder().encode("# 原稿\n")), "# 原稿\n");
  assert.equal(snapshotProposalBefore("new.md", null), null);
  assert.equal(snapshotProposalBefore("empty.md", new Uint8Array()), "");
});

test("rejects a binary original instead of presenting a misleading text review", () => {
  assert.throws(() => snapshotProposalBefore("image.png", new Uint8Array([0xff, 0x00])), /binary/u);
});
