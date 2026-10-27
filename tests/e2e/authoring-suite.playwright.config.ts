import { defineConfig } from "@playwright/test";
import baseConfig from "./playwright.config.js";

const authoringPattern = "**/authoring-suite*.spec.ts";

export default defineConfig({
  ...baseConfig,
  testDir: ".",
  testMatch: authoringPattern,
  expect: { timeout: 60_000 },
  projects: (baseConfig.projects ?? []).map(project => ({ ...project, testMatch: authoringPattern })),
});
