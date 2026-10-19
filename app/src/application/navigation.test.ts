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
  assert.equal(mobilePath, "/mobile/projects/owner%2Fwork%20one/scenes/scene%2F3?volume=volume-1&chapter=chapter-2");
  assert.deepEqual(parseApplicationLocation(mobilePath), { mode: "mobile", resource });
  const desktopPath = switchApplicationPath(`${mobilePath}&view=settings&theme=dark`, "desktop");
  assert.equal(desktopPath, applicationPath("desktop", resource, "?theme=dark"));
  assert.equal(switchApplicationPath(applicationPath("desktop", resource, "?view=settings&theme=dark"), "mobile"),
    applicationPath("mobile", resource, "?view=writing&theme=dark"));
  const projectLibraryPath = switchApplicationPath("/desktop/projects/project-1?view=settings&theme=dark", "mobile");
  assert.equal(new URL(projectLibraryPath, "http://scriptorium.invalid").searchParams.get("view"), "library");
  assert.equal(new URL(projectLibraryPath, "http://scriptorium.invalid").searchParams.get("theme"), "dark");
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
