import assert from "node:assert/strict";
import test from "node:test";
import { createWorkspacePreset, hideWorkspacePanel, resizeWorkspaceSplit } from "./layout";
import {
  loadWorkspaceLayout,
  loadWorkspaceSnapshot,
  saveWorkspaceLayout,
  saveWorkspaceSnapshot,
  workspaceSnapshotStorageKey,
  workspaceStorageKey,
  type WorkspaceStorage,
} from "./persistence";

class MemoryStorage implements WorkspaceStorage {
  values = new Map<string, string>();
  failKey: string | null = null;
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void {
    if (key === this.failKey) throw new Error("quota exceeded");
    this.values.set(key, value);
  }
}

const panelIds = ["editor", "outline", "inspector", "history", "review"];

test("layout persistence is separate by author scope and device class", () => {
  assert.notEqual(workspaceStorageKey("author:one", "desktop"), workspaceStorageKey("author:one", "mobile"));
  assert.notEqual(workspaceStorageKey("author:one", "desktop"), workspaceStorageKey("author:two", "desktop"));
  assert.equal(workspaceStorageKey("author:one", "mobile"), "scriptorium:workspace:v1:author%3Aone:mobile");
  assert.notEqual(workspaceSnapshotStorageKey("author:one", "desktop"), workspaceSnapshotStorageKey("author:one", "mobile"));
  assert.notEqual(workspaceSnapshotStorageKey("author:one", "desktop"), workspaceSnapshotStorageKey("author:two", "desktop"));
});

test("a workspace save commits dock layout and floating geometry in one record", () => {
  const storage = new MemoryStorage();
  const desktop = createWorkspacePreset("writing", panelIds);
  const floatingLayout = hideWorkspacePanel(desktop, "outline");
  const floating = [{ panelId: "outline", left: 100, top: 120, width: 350, height: 390 }];
  const snapshot = { layout: floatingLayout, floating };

  assert.equal(saveWorkspaceSnapshot(storage, "author:one", "desktop", snapshot), true);
  const reloaded = loadWorkspaceSnapshot(storage, "author:one", "desktop", panelIds);
  assert.equal(reloaded.state, "valid");
  assert.deepEqual(reloaded, { ...snapshot, state: "valid" });

  const raw = storage.getItem(workspaceSnapshotStorageKey("author:one", "desktop"));
  assert.ok(raw);
  assert.equal(saveWorkspaceSnapshot(storage, "author:one", "mobile", { layout: desktop, floating: [] }), true);
  assert.notEqual(storage.getItem(workspaceSnapshotStorageKey("author:one", "mobile")), raw);
  assert.equal(storage.getItem(workspaceSnapshotStorageKey("author:one", "desktop")), raw);
});

test("a failed workspace record write leaves the previous complete snapshot available after reload", () => {
  const storage = new MemoryStorage();
  const previousLayout = hideWorkspacePanel(createWorkspacePreset("writing", panelIds), "outline");
  const previousFloating = [{ panelId: "outline", left: 100, top: 120, width: 350, height: 390 }];
  const previous = { layout: previousLayout, floating: previousFloating };
  assert.equal(saveWorkspaceSnapshot(storage, "author:one", "desktop", previous), true);
  const key = workspaceSnapshotStorageKey("author:one", "desktop");
  const previousBytes = storage.getItem(key);
  assert.ok(previousBytes);

  const changedLayout = resizeWorkspaceSplit(previousLayout, previousLayout.root.type === "split" ? previousLayout.root.id : "", [72, 28]);
  const changed = { layout: changedLayout, floating: [{ ...previousFloating[0]!, left: 120 }] };
  storage.failKey = key;
  assert.equal(saveWorkspaceSnapshot(storage, "author:one", "desktop", changed), false);
  storage.failKey = null;

  assert.equal(storage.getItem(key), previousBytes);
  assert.deepEqual(loadWorkspaceSnapshot(storage, "author:one", "desktop", panelIds), { ...previous, state: "valid" });
});

test("malformed workspace records fall back without deleting their original bytes", () => {
  const storage = new MemoryStorage();
  const key = workspaceSnapshotStorageKey("author:one", "desktop");
  const malformed = '{"version":99,"layout":{"version":1},"floating":[]}';
  storage.values.set(key, malformed);

  const loaded = loadWorkspaceSnapshot(storage, "author:one", "desktop", panelIds);
  assert.equal(loaded.state, "invalid");
  assert.equal(loaded.layout.preset, "writing");
  assert.deepEqual(loaded.floating, []);
  assert.equal(storage.getItem(key), malformed);

  assert.equal(saveWorkspaceSnapshot(storage, "author:one", "desktop", { layout: loaded.layout, floating: [] }), true);
  assert.equal(loadWorkspaceSnapshot(storage, "author:one", "desktop", panelIds).state, "valid");
});

test("unavailable module layouts and floating panels survive Core-only restoration", () => {
  const storage = new MemoryStorage();
  const ids = [...panelIds, "module:optional.panel"];
  const layout = hideWorkspacePanel(createWorkspacePreset("writing", ids), "module:optional.panel");
  const floating = [{ panelId: "module:optional.panel", left: 100, top: 120, width: 350, height: 390 }];
  assert.equal(saveWorkspaceSnapshot(storage, "author:one", "desktop", { layout, floating }), true);

  const loaded = loadWorkspaceSnapshot(storage, "author:one", "desktop", panelIds);
  assert.equal(loaded.state, "valid");
  assert.ok(loaded.layout.hiddenPanelIds.includes("module:optional.panel"));
  assert.deepEqual(loaded.floating, floating);
});

test("loading malformed state preserves its stored bytes until an explicit valid save", () => {
  const storage = new MemoryStorage();
  const key = workspaceStorageKey("author:one", "desktop");
  const malformed = "{ this is not a workspace layout";
  storage.values.set(key, malformed);

  const loaded = loadWorkspaceLayout(storage, "author:one", "desktop", panelIds);
  assert.equal(loaded.state, "invalid");
  assert.equal(loaded.layout.preset, "writing");
  assert.equal(storage.getItem(key), malformed);

  const replacement = createWorkspacePreset("research", panelIds);
  assert.equal(saveWorkspaceLayout(storage, "author:one", "desktop", replacement), true);
  assert.notEqual(storage.getItem(key), malformed);
  assert.equal(loadWorkspaceLayout(storage, "author:one", "desktop", panelIds).state, "valid");
});

test("oversized or non-declarative payloads are rejected without storage writes", () => {
  const storage = new MemoryStorage();
  const key = workspaceStorageKey("author:one", "desktop");
  const oversized = "x".repeat(64 * 1024 + 1);
  storage.values.set(key, oversized);
  assert.equal(loadWorkspaceLayout(storage, "author:one", "desktop", panelIds).state, "invalid");
  assert.equal(storage.getItem(key), oversized);

  const layout = createWorkspacePreset("writing", panelIds);
  assert.equal(saveWorkspaceLayout(storage, "author:one", "desktop", { ...layout, secret: "not allowed" } as never), false);
  assert.equal(storage.getItem(key), oversized);
});

test("storage errors fall back without pretending that persistence succeeded", () => {
  const inaccessible: WorkspaceStorage = {
    getItem() { throw new Error("blocked"); },
    setItem() { throw new Error("blocked"); },
  };
  assert.equal(loadWorkspaceLayout(inaccessible, "author:one", "mobile", panelIds).state, "unavailable");
  assert.equal(saveWorkspaceLayout(inaccessible, "author:one", "mobile", createWorkspacePreset("writing", panelIds)), false);
});
