#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';

const metadataPath = '/usr/share/scriptorium/composition-manifest.json';
const manifest = JSON.parse(await readFile(metadataPath, 'utf8'));
const expectedModules = [...manifest.resolvedModules.map(({ id }) => id)].sort();
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
  if (!html.includes('main.js')) throw new Error('Runtime browser index does not reference the built application bundle');
  const bundleResponse = await request('/main.js');
  if (!bundleResponse.ok || Number(bundleResponse.headers.get('content-length') ?? '0') < 1) {
    throw new Error(`Runtime browser bundle route returned ${bundleResponse.status}`);
  }
  const bundle = Buffer.from(await bundleResponse.arrayBuffer());
  const expectedBundle = await readFile('/app/app/dist/main.js');
  if (!bundle.equals(expectedBundle)) throw new Error('Runtime browser route does not serve the built browser bundle');
  console.log(`Hosted runtime startup smoke passed (${expectedModules.length} modules, ${bundle.length} browser bytes)`);
} finally {
  child.kill('SIGTERM');
  await Promise.race([new Promise((resolve) => child.once('exit', resolve)), delay(5_000)]);
  if (child.exitCode === null) child.kill('SIGKILL');
  await rm(dataDirectory, { recursive: true, force: true });
}
