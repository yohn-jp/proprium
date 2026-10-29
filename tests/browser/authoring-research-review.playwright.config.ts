import { defineConfig } from "@playwright/test";
import base from "./authoring-knowledge.playwright.config.js";

export default defineConfig({ ...base, testMatch: "authoring-research-review.acceptance.ts", testIgnore: [] });
