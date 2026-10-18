import assert from "node:assert/strict";
import test from "node:test";
import {
  applicationPath,
  parseApplicationLocation,
  readUiModePreference,
  rememberUiMode,
  switchApplicationPath,
  UI_MODE_PREFERENCE_KEY,
} from "./navigation.js";

test("application paths retain resource identity when switching shells", () => {
  const resource = {
    projectId: "owner/work one",
    volumeId: "volume-1",
    chapterId: "chapter-2",
    sceneId: "scene/3",
  };
  const mobilePath = applicationPath("mobile", resource);
  assert.equal(mobilePath, "/mobile/projects/owner%2Fwork%20one/volumes/volume-1/chapters/chapter-2/scenes/scene%2F3");
  assert.deepEqual(parseApplicationLocation(mobilePath), { mode: "mobile", resource });
  assert.equal(switchApplicationPath(mobilePath, "desktop"), applicationPath("desktop", resource));
  assert.deepEqual(parseApplicationLocation("/desktop"), { mode: "desktop", resource: null });
});

test("explicit UI preference is read and remembered without selecting from paths", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  };
  assert.equal(readUiModePreference(storage), null);
  assert.equal(rememberUiMode("mobile", storage), true);
  assert.equal(values.get(UI_MODE_PREFERENCE_KEY), "mobile");
  assert.equal(readUiModePreference(storage), "mobile");
  values.set(UI_MODE_PREFERENCE_KEY, "tablet");
  assert.equal(readUiModePreference(storage), null);
});
