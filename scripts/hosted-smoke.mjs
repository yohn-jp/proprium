#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';

const metadataPath = '/usr/share/scriptorium/composition-manifest.json';
const manifest = JSON.parse(await readFile(metadataPath, 'utf8'));
const expectedModules = [...manifest.resolvedModules.map(({ id }) => id)].sort();

async function browserAssets(ui) {
  const distribution = path.join('/app/app/dist', ui);
  const viteManifest = JSON.parse(await readFile(path.join(distribution, '.vite/manifest.json'), 'utf8'));
  const entry = viteManifest?.['index.html'];
  const isHashedAsset = (value, extension) => typeof value === 'string' &&
    new RegExp(`^assets/[A-Za-z0-9._-]+-[A-Za-z0-9_-]{8}\\.${extension}$`, 'u').test(value);
  if (entry?.isEntry !== true || !isHashedAsset(entry.file, 'js')) {
    throw new Error(`${ui || 'launcher'} Vite manifest has no content-hashed application entry`);
  }
  const stylesheetFiles = Array.isArray(entry.css) ? entry.css : [viteManifest['style.css']?.file];
  if (stylesheetFiles.length === 0 || stylesheetFiles.some((file) => !isHashedAsset(file, 'css'))) {
    throw new Error(`${ui || 'launcher'} Vite manifest has no content-hashed application stylesheet`);
  }
  return {
    distribution,
    entryFile: entry.file,
    stylesheetFiles,
  };
}

const browserFiles = new Map();
for (const ui of ['', 'desktop', 'mobile']) browserFiles.set(ui, await browserAssets(ui));
const launcherFiles = browserFiles.get('');
if (manifest.browser?.entry !== `app/app/dist/${launcherFiles.entryFile}`) {
  throw new Error('Composition manifest does not bind the launcher browser entry to its Vite manifest');
}
const buildReport = JSON.parse(await readFile('/usr/share/scriptorium/build-artifact-report.json', 'utf8'));
const launcherBytes = await readFile(path.join(launcherFiles.distribution, launcherFiles.entryFile));
const launcherDigest = `sha256:${createHash('sha256').update(launcherBytes).digest('hex')}`;
if (buildReport.browserEntryPath !== `/app/app/dist/${launcherFiles.entryFile}` || buildReport.browserBundleDigest !== launcherDigest) {
  throw new Error('Build report does not bind the browser entry digest to the packaged Vite asset');
}
const token = process.env.SCRIPTORIUM_AUTH_TOKEN;
if (typeof token !== 'string' || !/^[a-f0-9]{64}$/u.test(token)) {
  throw new Error('Runtime smoke requires a fresh ephemeral token');
}
const dataDirectory = await mkdtemp(path.join(os.tmpdir(), 'scriptorium-runtime-smoke-'));
const port = 34117;
const child = spawn(process.execPath, ['/app/launch.mjs'], {
  cwd: '/app',
  stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    ...process.env,
    HOST: '127.0.0.1',
    PORT: String(port),
    SCRIPTORIUM_AUTH_TOKEN: token,
    SCRIPTORIUM_HOSTED_MODE: '0',
    SCRIPTORIUM_PROFILE: 'hosted',
    SCRIPTORIUM_DATA_DIR: path.join(dataDirectory, 'data'),
    SCRIPTORIUM_USAGE_DIR: path.join(dataDirectory, 'history'),
    SCRIPTORIUM_MODULE_CACHE_DIR: path.join(dataDirectory, 'module-cache'),
    SCRIPTORIUM_MODULE_PROFILE_PATH: '/app/generated/server.mjs',
  },
});
let output = '';
child.stdout.setEncoding('utf8').on('data', (chunk) => { output += chunk; });
child.stderr.setEncoding('utf8').on('data', (chunk) => { output += chunk; });

async function request(url, options) {
  return fetch(`http://127.0.0.1:${port}${url}`, { ...options, signal: AbortSignal.timeout(2_000) });
}

try {
  let ready;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Runtime exited before readiness: ${output}`);
    try {
      ready = await request('/health/ready');
      if (ready.status === 200) break;
    } catch {}
    await delay(250);
  }
  if (ready?.status !== 200) throw new Error(`Runtime did not become ready: ${output}`);
  const health = await ready.json();
  if (health.ok !== true) throw new Error('Runtime readiness endpoint did not report ok');
  const versionResponse = await request('/api/version');
  if (!versionResponse.ok) throw new Error(`Runtime version route returned ${versionResponse.status}`);
  const version = await versionResponse.json();
  const enabledModules = (version.modules ?? []).filter(({ availability }) => availability !== 'not-included').map(({ id }) => id).sort();
  if (JSON.stringify(enabledModules) !== JSON.stringify(expectedModules)) {
    throw new Error(`Runtime module closure mismatch: expected ${expectedModules.join(',')}, found ${enabledModules.join(',')}`);
  }
  const indexResponse = await request('/');
  if (!indexResponse.ok || !(indexResponse.headers.get('content-type') ?? '').includes('text/html')) {
    throw new Error(`Runtime browser index route returned ${indexResponse.status}`);
  }
  const html = await indexResponse.text();
  if (!html.includes(launcherFiles.entryFile)) throw new Error('Runtime browser index does not reference the manifest application bundle');
  const bundleResponse = await request('/main.js');
  if (!bundleResponse.ok || Number(bundleResponse.headers.get('content-length') ?? '0') < 1) {
    throw new Error(`Runtime browser bundle route returned ${bundleResponse.status}`);
  }
  const bundle = Buffer.from(await bundleResponse.arrayBuffer());
  if (!bundle.equals(launcherBytes) || bundleResponse.headers.get('cache-control') !== 'no-store') {
    throw new Error('Runtime fixed browser bundle alias does not serve the fresh packaged browser entry');
  }
  const hashedBundleResponse = await request(`/${launcherFiles.entryFile}`);
  if (!hashedBundleResponse.ok || hashedBundleResponse.headers.get('cache-control') !== 'public, max-age=31536000, immutable' ||
      !Buffer.from(await hashedBundleResponse.arrayBuffer()).equals(launcherBytes)) {
    throw new Error('Runtime content-hashed browser entry is not immutable or differs from packaged bytes');
  }
  const launcherStylesheet = launcherFiles.stylesheetFiles[0];
  const launcherStyleBytes = await readFile(path.join(launcherFiles.distribution, launcherStylesheet));
  const stylesheetAlias = await request('/styles.css');
  if (!stylesheetAlias.ok || stylesheetAlias.headers.get('cache-control') !== 'no-store' ||
      !Buffer.from(await stylesheetAlias.arrayBuffer()).equals(launcherStyleBytes)) {
    throw new Error('Runtime fixed stylesheet alias does not serve the fresh packaged stylesheet');
  }
  for (const ui of ['desktop', 'mobile']) {
    const page = await request(`/${ui}/`);
    if (!page.ok || !(await page.text()).includes(`/${ui}/${browserFiles.get(ui).entryFile}`)) throw new Error(`${ui} entry is unavailable`);
    const response = await request(`/${ui}/main.js`);
    const bytes = Buffer.from(await response.arrayBuffer());
    const uiFiles = browserFiles.get(ui);
    const expectedBytes = await readFile(path.join(uiFiles.distribution, uiFiles.entryFile));
    if (!response.ok || response.headers.get('cache-control') !== 'no-store' || !bytes.equals(expectedBytes)) {
      throw new Error(`${ui} fixed browser bundle alias differs from packaged bytes`);
    }
    const directResponse = await request(`/${ui}/${uiFiles.entryFile}`);
    if (!directResponse.ok || directResponse.headers.get('cache-control') !== 'public, max-age=31536000, immutable' ||
        !Buffer.from(await directResponse.arrayBuffer()).equals(expectedBytes)) {
      throw new Error(`${ui} content-hashed browser entry is not immutable or differs from packaged bytes`);
    }
    const uiStylesheet = uiFiles.stylesheetFiles[0];
    const uiStyleBytes = await readFile(path.join(uiFiles.distribution, uiStylesheet));
    const styleResponse = await request(`/${ui}/styles.css`);
    if (!styleResponse.ok || styleResponse.headers.get('cache-control') !== 'no-store' ||
        !Buffer.from(await styleResponse.arrayBuffer()).equals(uiStyleBytes)) {
      throw new Error(`${ui} fixed stylesheet alias differs from packaged bytes`);
    }
  }
  console.log(`Hosted runtime startup smoke passed (${expectedModules.length} modules, ${bundle.length} browser bytes)`);
} finally {
  child.kill('SIGTERM');
  await Promise.race([new Promise((resolve) => child.once('exit', resolve)), delay(5_000)]);
  if (child.exitCode === null) child.kill('SIGKILL');
  await rm(dataDirectory, { recursive: true, force: true });
}
