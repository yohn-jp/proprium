import assert from "node:assert/strict";
import test from "node:test";
import { AuthoringSnapshotLeases, verifyAndRenewAuthoringSnapshot } from "./authoring-snapshot-lease.js";

const TTL = 5 * 60 * 1000;

function clock() {
  let now = 0;
  return {
    now: () => now,
    advance: (ms: number) => { now += ms; },
  };
}

test("a same-source assertion slides the Browser Git lease while it remains live", async () => {
  const time = clock();
  const leases = new AuthoringSnapshotLeases(TTL, time.now);
  leases.start("snapshot-a");
  time.advance(TTL - 1);

  assert.equal(await verifyAndRenewAuthoringSnapshot(leases, "snapshot-a", () => true, async () => true), "renewed");
  time.advance(2);
  assert.equal(leases.isActive("snapshot-a"), true);
  time.advance(TTL - 1);
  assert.equal(leases.isActive("snapshot-a"), false);
});

test("a source mismatch never extends the lease", async () => {
  const time = clock();
  const leases = new AuthoringSnapshotLeases(TTL, time.now);
  leases.start("snapshot-a");
  time.advance(TTL - 1);

  assert.equal(await verifyAndRenewAuthoringSnapshot(leases, "snapshot-a", () => true, async () => false), "source_changed");
  time.advance(2);
  assert.equal(leases.isActive("snapshot-a"), false);
});

test("an expired lease cannot be revived by a same-source assertion", async () => {
  const time = clock();
  const leases = new AuthoringSnapshotLeases(TTL, time.now);
  leases.start("snapshot-a");
  time.advance(TTL);
  let checkedSource = false;

  assert.equal(await verifyAndRenewAuthoringSnapshot(leases, "snapshot-a", () => true, async () => {
    checkedSource = true;
    return true;
  }), "expired");
  assert.equal(checkedSource, false);
  assert.equal(leases.renewIfActive("snapshot-a"), false);
});

test("a released lease cannot be revived while a source check is in flight", async () => {
  const time = clock();
  const leases = new AuthoringSnapshotLeases(TTL, time.now);
  leases.start("snapshot-a");
  let finishSourceCheck!: (sameSource: boolean) => void;
  const check = verifyAndRenewAuthoringSnapshot(leases, "snapshot-a", () => leases.isActive("snapshot-a"), () => new Promise(resolve => {
    finishSourceCheck = resolve;
  }));

  leases.release("snapshot-a");
  finishSourceCheck(true);
  assert.equal(await check, "expired");
  assert.equal(leases.renewIfActive("snapshot-a"), false);
});

test("expired lease cleanup leaves active leases intact", () => {
  const time = clock();
  const leases = new AuthoringSnapshotLeases(TTL, time.now);
  leases.start("snapshot-old");
  leases.start("snapshot-active");
  time.advance(TTL);
  leases.release("snapshot-old");
  leases.start("snapshot-new");

  assert.deepEqual(leases.pruneExpired(), ["snapshot-active"]);
  assert.equal(leases.isActive("snapshot-new"), true);
});
