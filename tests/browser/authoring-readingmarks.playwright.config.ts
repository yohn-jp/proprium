import { defineConfig } from '@playwright/test';
import base from './authoring-publishing.playwright.config.js';
import { realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
const source = resolve(process.env.PROPRIUM_E2E_SOURCE ?? '.');
const port = process.env.PROPRIUM_E2E_PORT ?? '4173';
const dependencies = realpathSync(join(source, 'node_modules')); 
const config = join(tmpdir(), `proprium-navigation-vite-${process.pid}.mjs`);
writeFileSync(config, `import original from ${JSON.stringify(join(source, 'app/vite.proprium.config.ts'))}; export default env => { const c = original(env); return { ...c, cacheDir: ${JSON.stringify(join(tmpdir(), `proprium-navigation-cache-${process.pid}`))}, server: { ...c.server, fs: { ...c.server?.fs, allow: [${JSON.stringify(source)}, ${JSON.stringify(dependencies)}] } } }; };\n`);
export default defineConfig({ ...base, webServer: undefined }, { testMatch: 'authoring-readingmarks.acceptance.ts', timeout: 300_000, expect: { timeout: 90_000 },
  webServer: process.env.PROPRIUM_PUBLISHING_E2E_BASE_URL ? undefined : { command: `node ${JSON.stringify(join(source, 'app/node_modules/vite/bin/vite.js'))} ${JSON.stringify(join(source, 'app'))} --config ${JSON.stringify(config)} --host 127.0.0.1 --port ${port} --strictPort`, cwd: source, url: `http://127.0.0.1:${port}/`, reuseExistingServer: false, timeout: 120_000 },
});
