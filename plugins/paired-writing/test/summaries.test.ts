import { test } from "node:test";
import assert from "node:assert/strict";
import { chapterSummaryFingerprint, isFreshSummary, parseSummaryOutput } from "../src/summaries.js";

test("summary parser requires three ordered lines and bounded scene facts", () => {
  assert.deepEqual(parseSummaryOutput('{"summaryLines":["一","二","三"],"characters":["灯"],"stateChanges":[]}', "scene"), { summaryLines: ["一", "二", "三"], characters: ["灯"], stateChanges: [] });
  assert.throws(() => parseSummaryOutput('{"summaryLines":["一","二"]}', "chapter"), { code: "invalid_input" });
});
test("summary freshness binds exact source and prompt and chapter child identity/order", () => {
  const children = [{ id: "a", sourceHash: "1".repeat(64) }, { id: "b", sourceHash: "2".repeat(64) }];
  const hash = chapterSummaryFingerprint(children);
  assert.notEqual(hash, chapterSummaryFingerprint([...children].reverse()));
  assert.notEqual(hash, chapterSummaryFingerprint([{ ...children[0]!, id: "c" }, children[1]!]));
  const record = { sourceHash: hash, promptVersion: "chapter-summary@2", model: "local", summaryLines: ["1", "2", "3"] };
  assert.equal(isFreshSummary(record, hash, "chapter-summary@2"), true);
  assert.equal(isFreshSummary(record, hash, "chapter-summary@3"), false);
  assert.equal(isFreshSummary(record, "other", "chapter-summary@2"), false);
});
