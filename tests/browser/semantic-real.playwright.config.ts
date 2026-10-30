import { defineConfig } from '@playwright/test';
import base from './authoring-publishing.playwright.config.js';
import { join, resolve } from 'node:path';

const source = resolve(process.env.PROPRIUM_E2E_SOURCE ?? '.');

/** Keep the signed authoring registry build and Browser Host server from the publishing acceptance lane. */
export default defineConfig({
  ...base,
  testMatch: 'semantic-real.acceptance.ts',
  outputDir: join(source, 'tests/browser/test-results/semantic-real'),
  timeout: 15 * 60_000,
  expect: { timeout: 30_000 },
  use: { ...base.use, actionTimeout: 30_000, trace: 'off', video: 'off', screenshot: 'off' },
});
