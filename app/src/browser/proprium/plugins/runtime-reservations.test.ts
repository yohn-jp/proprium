import assert from "node:assert/strict";
import test from "node:test";
import { RuntimeReservations } from "./runtime-reservations.js";

test("overlapping calls reserve the same runtime until both have settled", async () => {
  const reservations = new RuntimeReservations();
  let firstDone!: () => void;
  let secondDone!: () => void;
  const first = reservations.run("narrative", () => new Promise<void>(resolve => { firstDone = resolve; }));
  const second = reservations.run("narrative", () => new Promise<void>(resolve => { secondDone = resolve; }));
  assert.equal(reservations.isBusy("narrative"), true);
  firstDone(); await first;
  assert.equal(reservations.isBusy("narrative"), true);
  secondDone(); await second;
  assert.equal(reservations.isBusy("narrative"), false);
});

test("nested callers remain reserved and rejection releases only the failed callee", async () => {
  const reservations = new RuntimeReservations();
  await reservations.run("speaker", async () => {
    await assert.rejects(reservations.run("knowledge", async () => {
      assert.equal(reservations.isBusy("speaker"), true);
      assert.equal(reservations.isBusy("knowledge"), true);
      throw new Error("denied");
    }), /denied/);
    assert.equal(reservations.isBusy("speaker"), true);
    assert.equal(reservations.isBusy("knowledge"), false);
  });
  assert.equal(reservations.isBusy("speaker"), false);
});
