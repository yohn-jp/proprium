import { defineConfig } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import base from './authoring-publishing.playwright.config.js';

const source = resolve(process.env.PROPRIUM_E2E_SOURCE ?? '.');
const port = process.env.PROPRIUM_E2E_PORT ?? '4173';
if (port !== '4187') throw new Error('Run the signed BGE acceptance with PROPRIUM_E2E_PORT=4187; artifact serving remains pinned to port 4173');
const registryDirectory = process.env.PROPRIUM_PUBLISHING_REGISTRY_DIR ?? process.env.PROPRIUM_OFFICIAL_E2E_DIR;
const keyFile = process.env.PROPRIUM_PUBLISHING_REGISTRY_KEY_FILE;
if (!registryDirectory || !keyFile) throw new Error('Set PROPRIUM_PUBLISHING_REGISTRY_DIR and PROPRIUM_PUBLISHING_REGISTRY_KEY_FILE to the fresh signed registry and its public key');
const registryKey = process.env.PROPRIUM_SIGNED_AUTHORING_REGISTRY_PUBLIC_KEY ?? readFileSync(keyFile, 'utf8').trim();

// Browser Host runs on 4187 while the signed fixture bytes stay on the already admitted 4173 artifact origin.
process.env.PROPRIUM_OFFICIAL_E2E_DIR = registryDirectory;
process.env.PROPRIUM_AUTHORING_TEST_ARTIFACT_BASE = 'http://127.0.0.1:4173/plugin-fixture/';
process.env.VITE_PROPRIUM_PLUGIN_REGISTRY_URL = `http://127.0.0.1:${port}/plugin-fixture/registry.json`;
process.env.VITE_PROPRIUM_PLUGIN_REGISTRY_KEY = registryKey;
process.env.VITE_PROPRIUM_PLUGIN_ARTIFACT_ORIGINS = 'http://127.0.0.1:4173';

export default defineConfig({
  ...base,
  testMatch: 'semantic-bge-real.acceptance.ts',
  outputDir: join(source, 'tests/browser/test-results/semantic-bge-real'),
  fullyParallel: false,
  workers: 1,
  timeout: 55 * 60_000,
  expect: { timeout: 30_000 },
  projects: (base.projects ?? []).filter(project => project.name === 'desktop-chromium'),
  use: { ...base.use, actionTimeout: 30_000, trace: 'off', video: 'off', screenshot: 'off' },
});
