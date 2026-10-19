import assert from "node:assert/strict";
import test from "node:test";
import { createWorkspacePreset } from "./layout";
import { loadWorkspaceLayout, saveWorkspaceLayout, workspaceStorageKey, type WorkspaceStorage } from "./persistence";

class MemoryStorage implements WorkspaceStorage {
  values = new Map<string, string>();
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.values.set(key, value); }
}

const panelIds = ["editor", "outline", "inspector", "history", "review"];

test("layout persistence is separate by author scope and device class", () => {
  assert.notEqual(workspaceStorageKey("author:one", "desktop"), workspaceStorageKey("author:one", "mobile"));
  assert.notEqual(workspaceStorageKey("author:one", "desktop"), workspaceStorageKey("author:two", "desktop"));
  assert.equal(workspaceStorageKey("author:one", "mobile"), "scriptorium:workspace:v1:author%3Aone:mobile");
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
