import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { clearDraft, draftKey, loadDraft, restoreDraft, saveDraft, type DraftStorage } from "./drafts.js";

class MemoryStorage implements DraftStorage {
  readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

describe("local writing drafts", () => {
  it("keeps drafts isolated by project and scene and restores the base revision", () => {
    const storage = new MemoryStorage();
    assert.equal(saveDraft(storage, "project-a", "scene-1", "unsaved text", "rev-1"), true);

    assert.equal(loadDraft(storage, "project-b", "scene-1"), null);
    const draft = loadDraft(storage, "project-a", "scene-1");
    assert.ok(draft);
    assert.deepEqual(restoreDraft({ text: "saved text", revision: "rev-2" }, draft), {
      text: "unsaved text",
      revision: "rev-1",
      restored: true,
      stale: true,
    });
  });

  it("drops a draft that already matches the canonical scene and clears after save", () => {
    const storage = new MemoryStorage();
    saveDraft(storage, "project-a", "scene/1", "same text", "rev-1");
    const draft = loadDraft(storage, "project-a", "scene/1");
    assert.ok(draft);
    assert.deepEqual(restoreDraft({ text: "same text", revision: "rev-2" }, draft), {
      text: "same text",
      revision: "rev-2",
      restored: false,
      stale: false,
    });

    clearDraft(storage, "project-a", "scene/1");
    assert.equal(loadDraft(storage, "project-a", "scene/1"), null);
    assert.equal(draftKey("project-a", "scene/1"), "scriptorium:draft:project-a:scene%2F1");
  });

  it("ignores malformed or foreign-key data", () => {
    const storage = new MemoryStorage();
    storage.setItem(draftKey("project-a", "scene-1"), JSON.stringify({ version: 1, text: "wrong" }));
    assert.equal(loadDraft(storage, "project-a", "scene-1"), null);
  });
});
