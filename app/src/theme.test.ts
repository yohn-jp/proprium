import assert from "node:assert/strict";
import test from "node:test";
import { chooseThemeMode, parseThemeMode, THEME_STORAGE_KEY } from "./theme";

test("theme mode accepts only the three supported appearance choices", () => {
  assert.equal(parseThemeMode("light"), "light");
  assert.equal(parseThemeMode("dark"), "dark");
  assert.equal(parseThemeMode("paper"), "paper");
  assert.equal(parseThemeMode("system"), null);
  assert.equal(parseThemeMode(null), null);
});

test("an explicit saved appearance wins over the system preference", () => {
  assert.equal(chooseThemeMode("paper", false), "paper");
  assert.equal(chooseThemeMode("dark", true), "dark");
  assert.equal(chooseThemeMode("light", false), "light");
});

test("a missing or invalid saved mode follows the system preference once at startup", () => {
  assert.equal(chooseThemeMode(null, true), "light");
  assert.equal(chooseThemeMode(null, false), "dark");
  assert.equal(chooseThemeMode("other", true), "light");
  assert.equal(THEME_STORAGE_KEY, "arcadia-theme-mode");
});
