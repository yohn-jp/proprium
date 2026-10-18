#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const [baseUrlValue, profileName] = process.argv.slice(2);
if (!baseUrlValue || !['core', 'full'].includes(profileName)) {
  console.error('Usage: node scripts/verify-oci-http.mjs <base-url> <core|full>');
  process.exit(2);
}

const baseUrl = new URL(baseUrlValue);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const profile = JSON.parse(await readFile(path.join(root, 'profiles', `${profileName}.json`), 'utf8'));

async function get(pathname) {
  const response = await fetch(new URL(pathname, baseUrl), { redirect: 'error' });
  assert.equal(response.status, 200, `${pathname} returned HTTP ${response.status}`);
  return response;
}

const startup = await get('/health/startup');
assert.deepEqual(await startup.json(), { ok: true, started: true });

const ready = await get('/api/ready');
const readyBody = await ready.json();
assert.equal(readyBody.ok, true);
assert.equal(readyBody.pendingRequests, 1, 'readiness reports the request currently being served');
assert.equal(readyBody.pendingLocalCheckpoints, null);

const health = await get('/api/health');
assert.deepEqual(await health.json(), { status: 'ok' });

const versionResponse = await get('/api/version');
const version = await versionResponse.json();
assert.equal(version.name, 'scriptorium');
assert.equal(version.profile, profileName);
assert.equal(version.contractVersion, 1);
assert.ok(Array.isArray(version.modules));
const included = version.modules.filter((module) => module.availability !== 'not-included').map((module) => module.id).sort();
assert.deepEqual(included, [...profile.modules].sort(), 'runtime module metadata matches the selected profile');
assert.ok(version.modules.every((module) => module.availability === 'not-included' || module.availability === 'enabled-idle'),
  'image starts with included modules idle');

const assetUrls = new Set();
for (const entry of ['/', '/desktop/', '/mobile/']) {
  const htmlResponse = await get(entry);
  assert.match(htmlResponse.headers.get('content-type') ?? '', /^text\/html(?:;|$)/u);
  const html = await htmlResponse.text();
  assert.match(html, /<title>Scriptorium<\/title>/u);
  const nonce = html.match(/<meta name="scriptorium-style-nonce" content="([^"]+)"/u)?.[1];
  assert.ok(nonce && nonce !== '__SCRIPTORIUM_STYLE_NONCE__', `${entry} has a request-specific style nonce`);
  assert.ok(htmlResponse.headers.get('content-security-policy')?.includes(`'nonce-${nonce}'`));
  const entryAssets = [];
  for (const match of html.matchAll(/<(?:script|link)\b[^>]*>/gu)) {
    const tag = match[0];
    const src = tag.match(/\bsrc="([^"]+)"/u)?.[1];
    const href = tag.match(/\bhref="([^"]+)"/u)?.[1];
    if (src) entryAssets.push(src);
    if (href && /\brel="stylesheet"/u.test(tag)) entryAssets.push(href);
  }
  assert.ok(entryAssets.some((asset) => /\.js(?:\?|$)/u.test(asset)), `${entry} references JavaScript`);
  assert.ok(entryAssets.some((asset) => /\.css(?:\?|$)/u.test(asset)), `${entry} references CSS`);
  if (entry !== '/') assert.ok(entryAssets.every((asset) => asset.startsWith(entry)), `${entry} assets are isolated`);
  for (const asset of entryAssets) assetUrls.add(asset);
}

const checkedAssets = new Set();
const pendingAssets = [...assetUrls].map((url) => ({ url, from: baseUrl }));
const assetTypes = new Map([
  ['.js', /^text\/javascript(?:;|$)/u], ['.mjs', /^text\/javascript(?:;|$)/u], ['.css', /^text\/css(?:;|$)/u],
  ['.svg', /^image\/svg\+xml(?:;|$)/u], ['.png', /^image\/png(?:;|$)/u], ['.jpg', /^image\/jpeg(?:;|$)/u],
  ['.jpeg', /^image\/jpeg(?:;|$)/u], ['.webp', /^image\/webp(?:;|$)/u], ['.avif', /^image\/avif(?:;|$)/u],
  ['.gif', /^image\/gif(?:;|$)/u], ['.woff', /^font\/woff(?:;|$)/u], ['.woff2', /^font\/woff2(?:;|$)/u],
  ['.ttf', /^font\/ttf(?:;|$)/u], ['.otf', /^font\/otf(?:;|$)/u], ['.ico', /^image\/x-icon(?:;|$)/u],
]);
while (pendingAssets.length > 0) {
  const nextAsset = pendingAssets.shift();
  if (!nextAsset) continue;
  const assetUrl = new URL(nextAsset.url, nextAsset.from);
  assert.equal(assetUrl.origin, baseUrl.origin, `built asset ${assetUrl.href} stays on the application origin`);
  const assetPath = `${assetUrl.pathname}${assetUrl.search}`;
  if (checkedAssets.has(assetPath)) continue;
  checkedAssets.add(assetPath);
  const response = await get(assetPath);
  const contentType = response.headers.get('content-type') ?? '';
  const extension = path.extname(assetUrl.pathname).toLowerCase();
  const expectedType = assetTypes.get(extension);
  assert.ok(expectedType, `${assetPath} uses a supported static asset extension`);
  assert.match(contentType, expectedType, `${assetPath} has the expected MIME type`);
  const body = await response.text();
  assert.ok(body.length > 0, `${assetPath} is non-empty`);
  for (const match of body.matchAll(/["']((?:\/(?:desktop\/|mobile\/)?assets\/|\.{1,2}\/)[A-Za-z0-9._/-]{1,220}\.(?:m?js|css|svg|png|jpe?g|webp|avif|gif|woff2?|ttf|otf|ico)(?:\?[^"']*)?)["']/gu)) {
    pendingAssets.push({ url: match[1], from: assetUrl });
  }
}

console.info(`OCI HTTP checks passed: ${profileName} profile, ${included.length} included module(s) idle, health/readiness, launcher/Desktop/Mobile HTML nonces, and ${checkedAssets.size} built asset(s).`);
