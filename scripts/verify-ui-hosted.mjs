#!/usr/bin/env node

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const selections = Object.freeze({
  'no-addon': [],
  story: ['story'],
  mcp: ['mcp'],
});

function usage() {
  console.error('Usage: node scripts/verify-ui-hosted.mjs --package <production-package> --profile <no-addon|story|mcp> [--port <port>]');
  process.exit(2);
}

function parseArgs(argv) {
  let packageDirectory;
  let profile;
  let port = 34117;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--package' && argv[index + 1]) packageDirectory = path.resolve(argv[++index]);
    else if (argv[index] === '--profile' && argv[index + 1]) profile = argv[++index];
    else if (argv[index] === '--port' && argv[index + 1]) {
      const value = Number(argv[++index]);
      if (!Number.isInteger(value) || value < 1 || value > 65535) usage();
      port = value;
    } else usage();
  }
  if (!packageDirectory || !Object.hasOwn(selections, profile)) usage();
  return { packageDirectory, profile, requestedModules: selections[profile], port };
}

function verifyDeployedPackage(packageDirectory, requestedModules) {
  const result = spawnSync(process.execPath, [
    path.join(root, 'scripts/profile-build.mjs'),
    '--modules-json', JSON.stringify(requestedModules),
    '--verify-deploy', packageDirectory,
  ], { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error('Hosted deployed-profile verification exited with status ' + String(result.status));
}

function closeForSelection(requestedModules, manifests) {
  const byId = new Map(manifests.map((manifest) => [manifest.id, manifest]));
  const included = new Set();
  const visit = (id) => {
    if (included.has(id)) return;
    const manifest = byId.get(id);
    assert.ok(manifest, 'production package is missing selected module ' + id);
    included.add(id);
    for (const dependency of manifest.dependencies ?? []) visit(dependency);
  };
  for (const id of requestedModules) visit(id);
  return [...included].sort();
}

async function main() {
  const { packageDirectory, profile, requestedModules, port } = parseArgs(process.argv.slice(2));
  const packageManifest = JSON.parse(await readFile(path.join(packageDirectory, 'generated/module-manifests.json'), 'utf8'));
  assert.equal(packageManifest.profile, 'hosted');
  assert.ok(Array.isArray(packageManifest.modules));

  const actualModules = packageManifest.modules.map(({ id }) => id).sort();
  const expectedModules = closeForSelection(requestedModules, packageManifest.modules);
  assert.deepEqual(actualModules, expectedModules, 'production package contains exactly the selected module dependency closure');
  verifyDeployedPackage(packageDirectory, requestedModules);

  const serverCatalog = await import(pathToFileURL(path.join(packageDirectory, 'generated/server.mjs')).href);
  const browserCatalog = await import(pathToFileURL(path.join(packageDirectory, 'generated/browser.mjs')).href);
  const expectedServer = packageManifest.modules.filter(({ serverEntry }) => serverEntry).map(({ id }) => id).sort();
  const expectedBrowser = packageManifest.modules.filter(({ browserEntry }) => browserEntry).map(({ id }) => id).sort();
  assert.deepEqual(Object.keys(serverCatalog.moduleLoaders).sort(), expectedServer, 'generated server loaders match the selected production modules');
  assert.deepEqual(Object.keys(browserCatalog.moduleBrowserLoaders).sort(), expectedBrowser, 'generated browser loaders match the selected production modules');

  const launchPath = path.join(packageDirectory, 'launch.mjs');
  const distributionRoot = path.join(packageDirectory, 'app/dist');
  await readFile(launchPath);
  await readFile(path.join(distributionRoot, 'index.html'));
  for (const ui of ['desktop', 'mobile']) await readFile(path.join(distributionRoot, ui, 'index.html'));

  const token = randomBytes(32).toString('hex');
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), 'scriptorium-ui-hosted-acceptance-'));
  const baseUrl = new URL('http://127.0.0.1:' + port);
  const child = spawn(process.execPath, [launchPath], {
    cwd: packageDirectory,
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
      SCRIPTORIUM_MODULE_PROFILE_PATH: path.join(packageDirectory, 'generated/server.mjs'),
    },
  });

  let output = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => { output += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { output += chunk; });

  async function get(pathname) {
    const response = await fetch(new URL(pathname, baseUrl), {
      redirect: 'error',
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(response.status, 200, pathname + ' returned HTTP ' + response.status);
    return response;
  }

  const assetTypes = new Map([
    ['.js', /^text\/javascript(?:;|$)/u],
    ['.mjs', /^text\/javascript(?:;|$)/u],
    ['.css', /^text\/css(?:;|$)/u],
    ['.svg', /^image\/svg\+xml(?:;|$)/u],
    ['.png', /^image\/png(?:;|$)/u],
    ['.jpg', /^image\/jpeg(?:;|$)/u],
    ['.jpeg', /^image\/jpeg(?:;|$)/u],
    ['.webp', /^image\/webp(?:;|$)/u],
    ['.avif', /^image\/avif(?:;|$)/u],
    ['.gif', /^image\/gif(?:;|$)/u],
    ['.woff', /^font\/woff(?:;|$)/u],
    ['.woff2', /^font\/woff2(?:;|$)/u],
    ['.ttf', /^font\/ttf(?:;|$)/u],
    ['.otf', /^font\/otf(?:;|$)/u],
    ['.ico', /^image\/x-icon(?:;|$)/u],
  ]);

  try {
    let ready;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      if (child.exitCode !== null) throw new Error('Hosted package exited before readiness: ' + output);
      try {
        ready = await get('/health/ready');
        if (ready.status === 200) break;
      } catch {}
      await delay(250);
    }
    assert.ok(ready?.status === 200, 'Hosted package did not become ready: ' + output);
    assert.deepEqual(await ready.json(), { ok: true });

    const health = await get('/api/health');
    assert.deepEqual(await health.json(), { status: 'ok' });
    const version = await (await get('/api/version')).json();
    assert.equal(version.profile, 'hosted');
    assert.ok(Array.isArray(version.modules));
    const included = version.modules.filter(({ availability }) => availability !== 'not-included').map(({ id }) => id).sort();
    assert.deepEqual(included, expectedModules, 'runtime capabilities match the selected production package');
    assert.ok(version.modules.every(({ availability }) => availability === 'not-included' || availability === 'enabled-idle'));

    const assetUrls = new Set();
    for (const entry of ['/', '/desktop/', '/mobile/']) {
      const response = await get(entry);
      assert.match(response.headers.get('content-type') ?? '', /^text\/html(?:;|$)/u);
      const html = await response.text();
      assert.match(html, /<title>[^<]+<\/title>/u);
      const nonce = html.match(/<meta name="scriptorium-style-nonce" content="([^"]+)"/u)?.[1];
      assert.ok(nonce && nonce !== '__SCRIPTORIUM_STYLE_NONCE__', entry + ' has a request-specific style nonce');
      assert.ok(response.headers.get('content-security-policy')?.includes("'nonce-" + nonce + "'"));
      const entryAssets = [];
      for (const match of html.matchAll(/<(?:script|link)\b[^>]*>/gu)) {
        const tag = match[0];
        const src = tag.match(/\bsrc="([^"]+)"/u)?.[1];
        const href = tag.match(/\bhref="([^"]+)"/u)?.[1];
        if (src) entryAssets.push(src);
        if (href && /\brel="stylesheet"/u.test(tag)) entryAssets.push(href);
      }
      assert.ok(entryAssets.some((asset) => /\.js(?:\?|$)/u.test(asset)), entry + ' references JavaScript');
      assert.ok(entryAssets.some((asset) => /\.css(?:\?|$)/u.test(asset)), entry + ' references CSS');
      if (entry !== '/') assert.ok(entryAssets.every((asset) => asset.startsWith(entry)), entry + ' assets are isolated');
      for (const asset of entryAssets) assetUrls.add(asset);
    }

    const checkedAssets = new Set();
    const pendingAssets = [...assetUrls].map((url) => ({ url, from: baseUrl }));
    while (pendingAssets.length > 0) {
      const nextAsset = pendingAssets.shift();
      if (!nextAsset) continue;
      const assetUrl = new URL(nextAsset.url, nextAsset.from);
      assert.equal(assetUrl.origin, baseUrl.origin, 'built asset stays on the application origin: ' + assetUrl.href);
      const assetPath = assetUrl.pathname + assetUrl.search;
      if (checkedAssets.has(assetPath)) continue;
      checkedAssets.add(assetPath);
      const response = await get(assetPath);
      const contentType = response.headers.get('content-type') ?? '';
      const extension = path.extname(assetUrl.pathname).toLowerCase();
      const expectedType = assetTypes.get(extension);
      assert.ok(expectedType, assetPath + ' uses a supported static asset extension');
      assert.match(contentType, expectedType, assetPath + ' has the expected MIME type');
      const bytes = Buffer.from(await response.arrayBuffer());
      assert.ok(bytes.length > 0, assetPath + ' is non-empty');
      const relativePath = decodeURIComponent(assetUrl.pathname).replace(/^\/+/, '');
      const diskPath = path.resolve(distributionRoot, relativePath);
      assert.ok(diskPath.startsWith(path.resolve(distributionRoot) + path.sep), assetPath + ' stays inside the packaged distribution');
      assert.deepEqual(bytes, await readFile(diskPath), assetPath + ' serves the exact production package bytes');
      const body = bytes.toString('utf8');
      for (const match of body.matchAll(/["']((?:\/(?:desktop\/|mobile\/)?assets\/|\.{1,2}\/)[A-Za-z0-9._/-]{1,220}\.(?:m?js|css|svg|png|jpe?g|webp|avif|gif|woff2?|ttf|otf|ico)(?:\?[^"']*)?)["']/gu)) {
        pendingAssets.push({ url: match[1], from: assetUrl });
      }
    }
    console.log('Hosted production smoke passed (' + profile + '): modules [' + (expectedModules.join(',') || 'none') + '], server loaders [' + (expectedServer.join(',') || 'none') + '], browser loaders [' + (expectedBrowser.join(',') || 'none') + '], launcher/Desktop/Mobile CSP and ' + checkedAssets.size + ' exact assets.');
  } finally {
    child.kill('SIGTERM');
    await Promise.race([new Promise((resolve) => child.once('exit', resolve)), delay(5_000)]);
    if (child.exitCode === null) {
      child.kill('SIGKILL');
      await Promise.race([new Promise((resolve) => child.once('exit', resolve)), delay(1_000)]);
    }
    await rm(dataDirectory, { recursive: true, force: true });
  }

  assert.equal(child.exitCode, 0, 'Hosted production package exited unsuccessfully: ' + output);
  assert.ok(output.includes('Scriptorium shutdown complete'), 'Hosted package did not complete API shutdown: ' + output);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Hosted UI package verification failed');
  process.exitCode = 1;
});
