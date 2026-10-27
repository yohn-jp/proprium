import { defineConfig } from '@playwright/test';
import base from './playwright.config.js';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const source = resolve(process.env.PROPRIUM_E2E_SOURCE ?? '.');
const port = process.env.PROPRIUM_E2E_PORT ?? '4173';
process.env.PROPRIUM_E2E_PORT = port;
const baseURL = process.env.PROPRIUM_PUBLISHING_E2E_BASE_URL ?? `http://127.0.0.1:${port}/`;
const externalRegistry = process.env.PROPRIUM_PUBLISHING_REGISTRY_DIR;
const keyFile = process.env.PROPRIUM_PUBLISHING_REGISTRY_KEY_FILE;
if (Boolean(externalRegistry) !== Boolean(keyFile)) throw new Error('Provide both PROPRIUM_PUBLISHING_REGISTRY_DIR and PROPRIUM_PUBLISHING_REGISTRY_KEY_FILE');
if (externalRegistry && keyFile) {
  const artifactOrigin = process.env.PROPRIUM_PUBLISHING_REGISTRY_ORIGIN ?? 'https://authoring-build.invalid';
  process.env.VITE_PROPRIUM_PLUGIN_REGISTRY_URL = `${artifactOrigin}/plugins/registry.json`;
  process.env.VITE_PROPRIUM_PLUGIN_REGISTRY_KEY = readFileSync(keyFile, 'utf8').trim();
  process.env.VITE_PROPRIUM_PLUGIN_ARTIFACT_ORIGINS = artifactOrigin;
}
const configPath = join(tmpdir(), `proprium-publishing-vite-${process.pid}.mjs`);
writeFileSync(configPath, `import original from ${JSON.stringify(join(source, 'app/vite.proprium.config.ts'))}; export default (env) => ({ ...original(env), cacheDir: ${JSON.stringify(join(tmpdir(), `proprium-publishing-cache-${process.pid}`))} });\n`);
export default defineConfig({
  testDir: '.', testMatch: 'authoring-publishing.acceptance.ts', outputDir: join(tmpdir(), `proprium-publishing-results-${process.pid}`),
  globalSetup: externalRegistry ? undefined : './authoring-official.setup.ts',
  fullyParallel: false, workers: 1, timeout: 180_000, expect: { timeout: 15_000 }, reporter: 'list',
  use: { baseURL, actionTimeout: 15_000, headless: true, trace: 'retain-on-failure', screenshot: 'off', video: 'off', acceptDownloads: true },
  projects: base.projects,
  webServer: process.env.PROPRIUM_PUBLISHING_E2E_BASE_URL ? undefined : { command: `node ${JSON.stringify(join(source, 'app/node_modules/vite/bin/vite.js'))} ${JSON.stringify(join(source, 'app'))} --config ${JSON.stringify(configPath)} --host 127.0.0.1 --port ${port} --strictPort`, cwd: source, url: baseURL, reuseExistingServer: false, timeout: 120_000 },
});
