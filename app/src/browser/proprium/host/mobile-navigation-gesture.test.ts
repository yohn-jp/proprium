import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyPageSwipe } from "../../../shells/mobile/mobileNavigationGestures.js";

const base = { startX: 190, startY: 300, endX: 85, endY: 310, viewportWidth: 390 };
test("horizontal swipe changes one tab direction only for deliberate horizontal travel", () => {
  assert.equal(classifyPageSwipe(base), "next");
  assert.equal(classifyPageSwipe({ ...base, endX: 295 }), "previous");
  assert.equal(classifyPageSwipe({ ...base, endX: 145 }), null);
  assert.equal(classifyPageSwipe({ ...base, endY: 440 }), null);
  assert.equal(classifyPageSwipe({ ...base, endX: 100, endY: 380 }), null);
});
test("Safari edge gestures and malformed coordinates stay browser-owned", () => {
  assert.equal(classifyPageSwipe({ ...base, startX: 20 }), null);
  assert.equal(classifyPageSwipe({ ...base, startX: 375 }), null);
  assert.equal(classifyPageSwipe({ ...base, viewportWidth: 0 }), null);
  assert.equal(classifyPageSwipe({ ...base, endX: Number.NaN }), null);
});
