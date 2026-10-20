import { createHash, randomUUID } from 'node:crypto';
import { fork, spawn } from 'node:child_process';
import { access, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { once } from 'node:events';
import { createServer as createTcpServer } from 'node:net';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';
import { git } from './dataset.mjs';
import { save } from './common.mjs';

const [datasetArg, runtimeRootArg, runtimeManifestArg, expectedSourceArg, outputArg,
  idleArg = '35000', addedRttArg = '80', streamWindowArg = '35000', phaseArg = 'full'] = process.argv.slice(2);
if (!datasetArg || !runtimeRootArg || !runtimeManifestArg || !expectedSourceArg || !outputArg) {
  throw new Error('Usage: node scripts/performance/core64-network.mjs <synthetic-dataset> <runtime-root> <runtime-manifest.json> <expected-runtime-source-full-sha> <result.json> [idle-ms=35000] [added-rtt-ms=80] [stream-window-ms=35000]');
}
const datasetPath = resolve(datasetArg);
const runtimeRoot = resolve(runtimeRootArg);
const runtimeManifestPath = resolve(runtimeManifestArg);
const expectedRuntimeSource = expectedSourceArg.toLowerCase();
const output = resolve(outputArg);
const taskTmpRoot = '/data/scriptorium-c64-network-tmp';
const idleMs = Number(idleArg);
const addedRttMs = Number(addedRttArg);
const streamWindowMs = Number(streamWindowArg);
if (![idleMs, addedRttMs, streamWindowMs].every(Number.isFinite) || idleMs < 0 || addedRttMs < 0 || streamWindowMs < 0) {
  throw new Error('Probe durations and added RTT must be non-negative numbers');
}
if (!['full', 'remaining'].includes(phaseArg)) throw new Error(`Unknown probe phase: ${phaseArg}`);
try { await access(output); throw new Error(`Result already exists: ${output}`); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
await mkdir(dirname(output), { recursive: true });
await mkdir(taskTmpRoot, { recursive: true });

const sha256 = value => createHash('sha256').update(value).digest('hex');
const productionTreeIdentity = {
  'app/src': '6114d95c43649dec93887034cc35a5d3d3b09e96',
  'packages/core/src': 'eee5bb9d8d9cbe811aa04d143ee8d24acae4b28d',
  'packages/api/src': 'bbf7aaf1f5a10a77cbb707447ac54937092cd616',
  'profiles/core': '29f1c8f2ee691be603db1f811b2c5fb61d1a4f40',
};
const productionReferenceCommit = 'e8aa3ecd7d1e0bfb3d81a003a2bc0320c9cc6d47';
const runtimeManifestBytes = await readFile(runtimeManifestPath);
const runtimeManifest = JSON.parse(runtimeManifestBytes.toString('utf8'));
if (!/^[0-9a-f]{40}$/.test(expectedRuntimeSource) || runtimeManifest.sourceCommit !== expectedRuntimeSource) {
  throw new Error(`Runtime manifest sourceCommit must equal the requested full source SHA ${expectedRuntimeSource}`);
}
const runtimeHead = git(runtimeRoot, 'rev-parse', 'HEAD');
if (runtimeHead !== runtimeManifest.sourceCommit) {
  throw new Error(`Runtime checkout HEAD ${runtimeHead} differs from manifest sourceCommit ${runtimeManifest.sourceCommit}`);
}
if (runtimeManifest.schemaVersion !== 1 || runtimeManifest.profile !== 'core' ||
    runtimeManifest.buildCommand !== 'SCRIPTORIUM_PROFILE=core pnpm build') {
  throw new Error('Runtime manifest does not describe the pinned Core build profile and command');
}
const requiredRoots = [
  'packages/core/dist',
  'packages/api/dist',
  'packages/contracts/dist',
  'packages/module-runtime/dist',
  'app/dist',
  'profiles/core/generated',
];
const artifactRoots = runtimeManifest.artifactRoots;
if (!Array.isArray(artifactRoots) || artifactRoots.length === 0 ||
    artifactRoots.some(root => typeof root !== 'string' || root.startsWith('/') || root.includes('\\') ||
      root.split('/').some(part => part === '' || part === '.' || part === '..'))) {
  throw new Error('Runtime manifest artifactRoots are malformed');
}
for (const root of requiredRoots) {
  if (!artifactRoots.includes(root)) throw new Error(`Runtime manifest is missing artifact root ${root}`);
}
if (!runtimeManifest.runtimeRoot || resolve(runtimeManifest.runtimeRoot) !== runtimeRoot) {
  throw new Error(`Runtime manifest root ${runtimeManifest.runtimeRoot} differs from supplied runtimeRoot ${runtimeRoot}`);
}
const identity = runtimeManifest.productionIdentity;
if (identity?.referenceCommit !== productionReferenceCommit || identity.identical !== true ||
    runtimeManifest.dirtyProductionPaths?.length !== 0 || !Array.isArray(identity.comparedPaths)) {
  throw new Error('Runtime manifest does not prove a clean production identity comparison with the expected runtime reference');
}
for (const [identityPath, expectedTree] of Object.entries(productionTreeIdentity)) {
  const comparedRoot = identityPath.split('/')[0];
  if (identity.trees?.[identityPath] !== expectedTree || !identity.comparedPaths.includes(comparedRoot)) {
    throw new Error(`Runtime production identity differs at ${identityPath}`);
  }
}
if (!Array.isArray(runtimeManifest.files) || runtimeManifest.files.length === 0) {
  throw new Error('Runtime manifest has no artifact file inventory');
}
const listedFiles = new Map();
let runtimeBytes = 0;
for (const entry of runtimeManifest.files) {
  if (!entry || typeof entry.path !== 'string' || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0 ||
      !/^[0-9a-f]{64}$/.test(entry.sha256 ?? '')) throw new Error('Malformed runtime artifact entry');
  if (entry.path.includes('\\') || entry.path.split('/').some(part => part === '.' || part === '..') ||
      !artifactRoots.some(root => entry.path.startsWith(`${root}/`))) {
    throw new Error(`Runtime artifact path is outside the allowed build roots: ${entry.path}`);
  }
  const absolute = resolve(runtimeRoot, entry.path);
  const rel = relative(runtimeRoot, absolute);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel) || listedFiles.has(entry.path)) {
    throw new Error(`Unsafe or duplicate runtime artifact path ${entry.path}`);
  }
  const stat = await lstat(absolute);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Runtime artifact is not a regular file: ${entry.path}`);
  const bytes = await readFile(absolute);
  if (bytes.length !== entry.bytes || sha256(bytes) !== entry.sha256) {
    throw new Error(`Runtime artifact does not match manifest: ${entry.path}`);
  }
  listedFiles.set(entry.path, entry);
  runtimeBytes += bytes.length;
}
for (const entryPath of ['packages/core/dist/index.js', 'packages/api/dist/server.js', 'app/dist/index.html']) {
  if (!listedFiles.has(entryPath)) throw new Error(`Runtime manifest does not inventory required entrypoint ${entryPath}`);
}
if (runtimeManifest.totals?.fileCount !== runtimeManifest.files.length || runtimeManifest.totals?.bytes !== runtimeBytes) {
  throw new Error('Runtime manifest totals do not match its verified file inventory');
}
const runtimeArtifactVerification = {
  root: runtimeRoot,
  manifest: runtimeManifestPath,
  manifestSha256: sha256(runtimeManifestBytes),
  expectedSourceCommit: expectedRuntimeSource,
  actualSourceCommit: runtimeHead,
  profile: runtimeManifest.profile,
  artifactRoots,
  productionIdentity: identity,
  toolchain: runtimeManifest.toolchain,
  verifiedFiles: listedFiles.size,
  verifiedBytes: runtimeBytes,
};

const dataset = JSON.parse(await readFile(join(datasetPath, 'dataset.json'), 'utf8'));
const seedPath = join(datasetPath, 'seed');
const sourceBareRemote = resolve(join(datasetPath, 'origin.git'));
const sourceFixtureState = () => ({
  seedHead: git(seedPath, 'rev-parse', 'HEAD'),
  seedStatus: git(seedPath, 'status', '--porcelain=v1', '--untracked-files=all'),
  sourceBareRefs: git(datasetPath, '--git-dir', sourceBareRemote, 'for-each-ref', '--format=%(refname) %(objectname)'),
});
const sourceFixtureBefore = sourceFixtureState();
if (sourceFixtureBefore.seedHead !== dataset.commit || sourceFixtureBefore.seedStatus !== '' ||
    !sourceFixtureBefore.sourceBareRefs.split('\n').includes(`refs/heads/main ${dataset.commit}`)) {
  throw new Error('G0 source fixture seed or canonical bare remote does not match its manifest; refusing to run');
}
const harnessSource = git(process.cwd(), 'rev-parse', 'HEAD');
const report = {
  harness: {
    source: harnessSource,
    scriptSha256: createHash('sha256').update(await readFile(new URL(import.meta.url))).digest('hex'),
  },
  dataset,
  runtime: runtimeArtifactVerification,
  node: process.version,
  visibilitySetup: {
    requested: process.env.SCRIPTORIUM_E2E_NATIVE_VISIBILITY === '1',
    display: process.env.DISPLAY ?? null,
    status: process.env.SCRIPTORIUM_E2E_NATIVE_VISIBILITY === '1'
      ? 'pending raw headful Chromium + CDP noDefaults setup'
      : 'NOT_CHECKED: native headful visibility environment was not passed',
  },
  args: { idleMs, addedRttMs, streamWindowMs, phase: phaseArg },
  status: 'running',
  bootstrap: [],
  polling: {},
  streams: {},
  notChecked: [
    'Native GitHub/GHES external-push detection: the bounded probe pushes only to a disposable local bare remote.',
    'SSE backpressure and queue saturation: connection windows do not manufacture an event backlog.',
  ],
  sourceFixture: { sourceBareRemote, before: sourceFixtureBefore, after: null, unchanged: null },
};
let server, browser, currentContext, ready, base;
let nativeVisibility;
const activeDirectStreams = new Set();
const networkRows = [];

const delay = ms => new Promise(resolveDelay => setTimeout(resolveDelay, ms));
const apiPath = request => {
  try { return new URL(request.url()).pathname; } catch { return request.url(); }
};
const isStreamRequest = request => {
  const path = apiPath(request);
  return path.endsWith('/events') || request.resourceType() === 'eventsource' ||
    (request.method() === 'GET' && request.headers().accept?.includes('text/event-stream'));
};
const browserNetwork = page => {
  const inFlight = new Set();
  const openStreams = new Map();
  let lastFiniteActivity = performance.now();
  page.on('request', request => {
    const row = { at: performance.now(), method: request.method(), path: apiPath(request), streaming: isStreamRequest(request) };
    networkRows.push(row);
    if (row.streaming) openStreams.set(request, row);
    else { inFlight.add(request); lastFiniteActivity = performance.now(); }
  });
  const settle = request => {
    if (inFlight.delete(request)) lastFiniteActivity = performance.now();
    openStreams.delete(request);
  };
  page.on('requestfinished', settle);
  page.on('requestfailed', settle);
  return {
    inFlight,
    openStreams,
    async waitQuiet() {
      const deadline = performance.now() + 60000;
      while (performance.now() < deadline) {
        if (inFlight.size === 0 && performance.now() - lastFiniteActivity >= 500) return;
        await page.waitForTimeout(100);
      }
      throw new Error('Finite browser requests did not settle');
    },
  };
};

async function unusedTcpPort() {
  const control = createTcpServer();
  await new Promise((resolveListen, reject) => {
    control.once('error', reject);
    control.listen(0, '127.0.0.1', () => resolveListen());
  });
  const address = control.address();
  if (!address || typeof address === 'string') throw new Error('Could not allocate a loopback port for native Chromium CDP');
  const port = address.port;
  await new Promise((resolveClose, reject) => control.close(error => error ? reject(error) : resolveClose()));
  return port;
}

async function stopBrowserProcess(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  const stopped = await Promise.race([exited.then(() => true), delay(2000).then(() => false)]);
  if (!stopped) {
    const killed = once(child, 'exit').then(() => true);
    child.kill('SIGKILL');
    await Promise.race([killed, delay(2000)]);
  }
}

async function connectNativeHeadfulContext() {
  if (process.env.SCRIPTORIUM_E2E_NATIVE_VISIBILITY !== '1') {
    throw new Error('Native hidden/focus measurement requires SCRIPTORIUM_E2E_NATIVE_VISIBILITY=1');
  }
  if (!/^:97(?:\.0)?$/.test(process.env.DISPLAY ?? '')) {
    throw new Error(`Native hidden/focus measurement requires the validated Xvfb :97 display; got ${process.env.DISPLAY ?? 'unset'}`);
  }
  const executable = process.env.SCRIPTORIUM_E2E_CHROMIUM;
  if (!executable) throw new Error('Native hidden/focus measurement requires SCRIPTORIUM_E2E_CHROMIUM');

  await mkdir(taskTmpRoot, { recursive: true });
  const profile = await mkdtemp(join(taskTmpRoot, 'native-chromium-'));
  const port = await unusedTcpPort();
  const child = spawn(executable, [
    '--no-sandbox',
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${port}`,
    '--remote-allow-origins=*',
    'about:blank',
  ], { env: process.env, stdio: 'ignore' });
  let browserConnection;
  let spawnError;
  child.once('error', error => { spawnError = error; });
  try {
    const deadline = Date.now() + 10000;
    let endpointReady = false;
    while (Date.now() < deadline) {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null) throw new Error(`Native Chromium exited before CDP was ready (code ${child.exitCode})`);
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json/version`);
        if (response.ok) { endpointReady = true; break; }
      } catch { /* Wait for the loopback CDP endpoint. */ }
      await delay(100);
    }
    if (!endpointReady) throw new Error('Native Chromium CDP endpoint did not start within 10 seconds');
    browserConnection = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { noDefaults: true });
    const context = browserConnection.contexts()[0];
    if (!context) throw new Error('Native Chromium did not expose its default browser context');
    const page = context.pages()[0] ?? await context.newPage();
    await page.setViewportSize({ width: 1440, height: 1000 });
    page.setDefaultTimeout(60000);
    const cdp = await context.newCDPSession(page);
    let windowId;
    try { ({ windowId } = await cdp.send('Browser.getWindowForTarget')); }
    finally { await cdp.detach(); }
    const result = {
      browser: browserConnection,
      context,
      page,
      facts: {
        method: 'raw headful Chromium + chromium.connectOverCDP(noDefaults:true) + browser.contexts()[0]',
        display: process.env.DISPLAY,
        browserVersion: browserConnection.version(),
        initialWindowId: windowId,
        noDefaults: true,
        freshProfile: true,
        headlessFlag: false,
        playwrightVersion: '1.64.1',
        validatedHarnessCommit: '5c6a2b2c35391a951d3f01ffdcd00707644c8bba',
      },
      async close() {
        await browserConnection.close().catch(() => undefined);
        await stopBrowserProcess(child);
        await rm(profile, { recursive: true, force: true });
      },
    };
    if (!/^155\./.test(result.facts.browserVersion)) {
      throw new Error(`Native visibility setup requires Chromium 155; found ${result.facts.browserVersion}`);
    }
    return result;
  } catch (error) {
    await browserConnection?.close().catch(() => undefined);
    await stopBrowserProcess(child);
    await rm(profile, { recursive: true, force: true });
    throw error;
  }
}

async function browserWindowId(context, page) {
  const session = await context.newCDPSession(page);
  try { return (await session.send('Browser.getWindowForTarget')).windowId; }
  finally { await session.detach(); }
}

async function serverStats() {
  const response = once(server, 'message');
  server.send('stats');
  return (await response)[0];
}

function serverSnapshot(stats) {
  return {
    requests: stats.requests,
    counts: stats.counts,
    cpu: stats.cpu,
    memory: stats.memory,
    resourceUsage: stats.usage,
    io: stats.io,
  };
}

function usageDelta(before, after) {
  const cpu = before.cpu && after.cpu ? {
    userUs: after.cpu.user - before.cpu.user,
    systemUs: after.cpu.system - before.cpu.system,
  } : null;
  const io = before.io && after.io
    ? Object.fromEntries(Object.keys(after.io).map(key => [key, after.io[key] - before.io[key]]))
    : null;
  return { cpu, io, rssBeforeBytes: before.memory?.rss ?? null, rssAfterBytes: after.memory?.rss ?? null,
    peakRssKiB: after.resourceUsage?.maxRSS ?? null };
}

async function writeProgress() { await save(output, report); }

async function newPage({ addedRttMs: rtt = 0, context: existingContext, page: existingPage } = {}) {
  const context = existingContext ?? await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.route('**/api/**', async route => {
    if (rtt > 0) await delay(rtt);
    await route.continue();
  });
  const page = existingPage ?? await context.newPage();
  page.setDefaultTimeout(60000);
  const network = browserNetwork(page);
  return { context, page, network };
}

async function openExistingProject(name, rttMs = 0, nativeContext = undefined) {
  const nativePage = nativeContext?.page;
  const { context, page, network } = await newPage({ addedRttMs: rttMs,
    ...(nativeContext ? { context: nativeContext.context, page: nativePage } : {}) });
  currentContext = context;
  const requestStart = networkRows.length;
  const serverRequestStart = (await serverStats()).requests.length;
  const nodeStart = performance.now();
  await page.goto(`${base}/desktop/`);
  await page.getByLabel('アクセストークン').fill('synthetic-benchmark-local-token-000000');
  await page.getByRole('button', { name: 'ログイン', exact: true }).click();
  const firstScene = page.locator('button.scene-button').filter({ hasText: /^Chapter One: Scene 1$/ });
  await firstScene.waitFor();
  await firstScene.click();
  await page.locator('.scene-heading h1').waitFor();
  await page.waitForFunction(() => document.querySelector('.cm-content')?.textContent?.includes('Synthetic scene 1') === true);
  const nodeEnd = performance.now();
  const browserEntries = await page.evaluate(() => {
    const nav = performance.getEntriesByType('navigation')[0];
    const resources = performance.getEntriesByType('resource');
    const pick = entry => ({
      name: entry.name,
      initiatorType: entry.initiatorType ?? 'navigation',
      startTime: entry.startTime,
      responseEnd: entry.responseEnd,
      transferSize: entry.transferSize,
      encodedBodySize: entry.encodedBodySize,
      decodedBodySize: entry.decodedBodySize,
    });
    return [
      ...(nav ? [pick(nav)] : []),
      ...resources.filter(entry => entry.responseEnd > 0).map(pick),
    ];
  });
  const requests = networkRows.slice(requestStart).filter(row => row.at <= nodeEnd);
  const bytes = browserEntries.reduce((sum, entry) => sum + (entry.transferSize || 0), 0);
  const serverAfter = await serverStats();
  const result = {
    name,
    addedRttPerApiRequestMs: rttMs,
    durationMs: nodeEnd - nodeStart,
    requestCount: requests.length,
    requests,
    bytes: {
      resourceTimingTransferBytes: bytes,
      encodedBodyBytes: browserEntries.reduce((sum, entry) => sum + (entry.encodedBodySize || 0), 0),
      entries: browserEntries,
      method: 'same-origin Performance Resource Timing transferSize; local loopback has no proxy or compression',
    },
    server: {
      requests: serverAfter.requests.slice(serverRequestStart),
      snapshot: serverSnapshot(serverAfter),
    },
  };
  report.bootstrap.push(result);
  await writeProgress();
  return { context, page, network, result };
}

async function makeProject() {
  const { context, page, network } = await newPage();
  currentContext = context;
  await page.goto(`${base}/desktop/`);
  await page.getByLabel('アクセストークン').waitFor();
  await page.getByLabel('アクセストークン').fill('synthetic-benchmark-local-token-000000');
  await page.getByRole('button', { name: 'ログイン', exact: true }).click();
  await page.getByLabel('GitHub リポジトリ URL').fill(pathToFileURL(ready.remote).href);
  const registration = page.waitForResponse(response => response.request().method() === 'POST' && apiPath(response.request()) === '/api/projects');
  await page.getByRole('button', { name: 'リポジトリを登録' }).click();
  const response = await registration;
  if (!response.ok()) throw new Error(`Synthetic project registration failed (${response.status()})`);
  const project = await response.json();
  const firstScene = page.locator('button.scene-button').filter({ hasText: /^Chapter One: Scene 1$/ });
  await firstScene.waitFor();
  await firstScene.click();
  await page.locator('.scene-heading h1').waitFor();
  await page.waitForFunction(() => document.querySelector('.cm-content')?.textContent?.includes('Synthetic scene 1') === true);
  if (network.inFlight.size) await network.waitQuiet();
  await context.close();
  currentContext = undefined;
  return project.id;
}

function matchingRows(rows, pathTail) { return rows.filter(row => row.path.endsWith(pathTail)); }

function cookieHeader(cookies) { return cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; '); }

async function openDirectStream(name, cookie, lastEventId = '') {
  const controller = new AbortController();
  const startedAt = performance.now();
  const headers = { ...(cookie ? { Cookie: cookie } : {}), ...(lastEventId ? { 'Last-Event-ID': lastEventId } : {}) };
  const response = await fetch(`${base}/api/${name}/events`, {
    headers,
    signal: controller.signal,
  });
  const stream = { name, response, controller, startedAt, connectedAt: performance.now(), events: [], frames: 0, closedAt: null };
  if (!response.ok) await response.arrayBuffer();
  if (response.ok && response.body) {
    activeDirectStreams.add(stream);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    stream.readTask = (async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let boundary;
          while ((boundary = buffer.indexOf('\n\n')) >= 0) {
            const frame = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            if (!frame || frame.startsWith(':')) continue;
            stream.frames++;
            const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n');
            if (data) {
              try { stream.events.push(JSON.parse(data)); } catch { stream.events.push({ parseError: true }); }
            }
          }
        }
      } catch (error) { stream.readError = error.message; }
      finally { stream.closedAt = performance.now(); activeDirectStreams.delete(stream); }
    })();
  }
  return stream;
}

async function stopDirectStream(stream) {
  if (!stream?.response?.ok) return;
  stream.controller.abort();
  await Promise.race([stream.readTask, delay(2000)]);
  activeDirectStreams.delete(stream);
}

async function externalPush(remote, datasetPath, revision) {
  await mkdir(taskTmpRoot, { recursive: true });
  const scratch = await mkdtemp(join(taskTmpRoot, `external-${randomUUID()}-`));
  const clone = join(scratch, 'remote');
  try {
    git(scratch, 'clone', remote, clone);
    const branch = git(clone, 'branch', '--show-current');
    git(clone, 'config', 'user.name', 'Scriptorium C64 Network Probe');
    git(clone, 'config', 'user.email', 'c64-network@example.invalid');
    await writeFile(join(clone, 'network-external-push.txt'), `synthetic external push ${revision}\n`);
    git(clone, 'add', 'network-external-push.txt');
    git(clone, 'commit', '--quiet', '-m', `Synthetic external push ${revision}`);
    const head = git(clone, 'rev-parse', 'HEAD');
    git(clone, 'push', '--quiet', 'origin', `HEAD:refs/heads/${branch}`);
    return { head, branch, pushedAt: performance.now() };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

async function sseScopeAndReconnect(cookie, projectId) {
  const paths = ['projects', 'jobs'];
  const unauthorized = {};
  for (const name of paths) {
    const stream = await openDirectStream(name, '');
    unauthorized[name] = stream.response.status;
  }
  if (unauthorized.projects !== 401 || unauthorized.jobs !== 401) {
    throw new Error(`Unexpected unauthenticated SSE scope statuses: ${JSON.stringify(unauthorized)}`);
  }

  const bearerOnly = {};
  for (const name of paths) {
    const response = await fetch(`${base}/api/${name}/events`, {
      headers: { Authorization: 'Bearer synthetic-benchmark-local-token-000000' },
    });
    bearerOnly[name] = response.status;
    await response.body?.cancel();
  }
  if (bearerOnly.projects !== 200 || bearerOnly.jobs !== 403) {
    throw new Error(`Unexpected bearer-only SSE scope statuses: ${JSON.stringify(bearerOnly)}`);
  }

  const project = await openDirectStream('projects', cookie);
  if (!project.response.ok) throw new Error(`Owner project SSE failed (${project.response.status})`);
  const startedAt = performance.now();
  const sync = await fetch(`${base}/api/projects/${projectId}/sync`, { method: 'POST', headers: { Cookie: cookie, Origin: base } });
  const syncPayload = sync.ok ? await sync.json() : await sync.text();
  const eventDeadline = performance.now() + 10000;
  while (performance.now() < eventDeadline && !project.events.some(event => event.phase === 'completed' || event.phase === 'failed')) await delay(20);
  const event = project.events.find(item => item.phase === 'completed' || item.phase === 'failed') ?? null;
  const projectScope = {
    syncStatus: sync.status,
    projectIdInEvent: event?.projectId ?? null,
    reason: event?.reason ?? null,
    phase: event?.phase ?? null,
    routeResponseMs: performance.now() - startedAt,
    syncPayload,
  };
  if (sync.status !== 200 || event?.phase !== 'completed' || event.projectId !== projectId) {
    throw new Error(`Project sync SSE did not deliver an owner-scoped completion: ${JSON.stringify(projectScope)}`);
  }
  await stopDirectStream(project);

  const reconnect = {};
  for (const name of paths) {
    const reconnectStart = performance.now();
    const reconnected = await openDirectStream(name, cookie, `unknown-cursor-${name}`);
    const reconnectMs = performance.now() - reconnectStart;
    await delay(500);
    if (reconnected.response.status !== 200) {
      throw new Error(`Owner ${name} SSE reconnect failed (${reconnected.response.status})`);
    }
    reconnect[name] = {
      status: reconnected.response.status,
      responseMs: reconnectMs,
      lastEventId: `unknown-cursor-${name}`,
      replayFramesWithin500ms: reconnected.frames,
    };
    await stopDirectStream(reconnected);
  }
  return {
    unauthorizedStatus: unauthorized,
    bearerOnlyStatus: bearerOnly,
    ownerStatus: { projects: 200, jobs: 200 },
    projectScope,
    reconnect,
  };
}

async function measureStreamWindow(name, streams, durationMs) {
  const before = await serverStats();
  const startedAt = performance.now();
  await delay(durationMs);
  const after = await serverStats();
  return {
    name,
    durationMs: performance.now() - startedAt,
    clientOpenSseCount: activeDirectStreams.size,
    clientOpenSseNames: [...activeDirectStreams].map(stream => stream.name),
    requestedStreams: streams,
    before: serverSnapshot(before),
    after: serverSnapshot(after),
    delta: usageDelta(before, after),
  };
}

try {
  server = fork(new URL('./core64-network-server.mjs', import.meta.url),
    [datasetPath, runtimeRoot, runtimeManifestPath, expectedRuntimeSource, runtimeArtifactVerification.manifestSha256],
    { cwd: runtimeRoot, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  [ready] = await once(server, 'message');
  if (!ready?.ready || ready.runtimeSource !== expectedRuntimeSource ||
      ready.runtimeManifestSha256 !== runtimeArtifactVerification.manifestSha256) {
    throw new Error('Synthetic API server did not report the verified runtime artifact identity');
  }
  base = `http://127.0.0.1:${ready.port}`;
  const workerRemote = resolve(ready.remote);
  if (workerRemote === sourceBareRemote) throw new Error('The API worker remote aliases the immutable G0 source bare remote');
  report.server = {
    startupMs: ready.startupMs,
    runtimeSource: ready.runtimeSource,
    runtimeManifestSha256: ready.runtimeManifestSha256,
    staticDir: ready.staticDir,
    workerRemote,
    workerRemoteBaseHead: git(workerRemote, 'rev-parse', 'refs/heads/main'),
    sourceRemoteHead: sourceFixtureBefore.sourceBareRefs.split('\n').find(ref => ref.startsWith('refs/heads/main '))?.split(' ')[1],
    workerRemoteCreatedBy: 'existing scripts/performance/server.mjs per-run bare clone',
  };
  browser = await chromium.launch({ headless: true,
    ...(process.env.SCRIPTORIUM_E2E_CHROMIUM ? { executablePath: process.env.SCRIPTORIUM_E2E_CHROMIUM } : {}) });
  report.browser = browser.version();

  const projectId = await makeProject();
  report.projectId = projectId;
  report.setup = { syntheticProjectRegistered: true, includedInBootstrapMeasurements: false };
  report.skippedPhases = phaseArg === 'remaining'
    ? ['Visible/hidden idle, external-push, and native visibility cohort are preserved in network-small.json and were not rerun.']
    : [];
  await writeProgress();

  let ownerCookie;
  if (phaseArg === 'full') {
  const local = await openExistingProject('loopback', 0);
  const localPage = local.page;
  await local.network.waitQuiet();
  ownerCookie = cookieHeader(await local.context.cookies(base));
  if (!ownerCookie) throw new Error('Owner session cookie was unavailable for SSE scope measurements');

  const idleStart = networkRows.length;
  const visibleAt = performance.now();
  await localPage.waitForTimeout(idleMs);
  const visibleRows = networkRows.slice(idleStart);
  report.polling.visible = {
    requestedMs: idleMs,
    elapsedMs: performance.now() - visibleAt,
    visibility: await localPage.evaluate(() => document.visibilityState),
    requestCount: visibleRows.length,
    observationCount: matchingRows(visibleRows, '/observation').length,
    observationRequests: matchingRows(visibleRows, '/observation'),
    allRequests: visibleRows,
  };
  await writeProgress();

  const projectHintStream = await openDirectStream('projects', ownerCookie);
  if (!projectHintStream.response.ok) throw new Error(`Project event hint stream failed (${projectHintStream.response.status})`);
  const observationStart = networkRows.length;
  const push = await externalPush(ready.remote, datasetPath, 1);
  await localPage.waitForFunction(head => document.body.innerText.includes(head.slice(0, 12)), push.head, { timeout: Math.max(idleMs + 5000, 25000) });
  const observedAt = performance.now();
  const detectionRows = networkRows.slice(observationStart);
  report.polling.externalPush = {
    type: 'synthetic local bare-remote push; no GitHub access',
    head: push.head,
    workerRemoteHeadAfterPush: git(workerRemote, 'rev-parse', `refs/heads/${push.branch}`),
    branch: push.branch,
    detectionMs: observedAt - push.pushedAt,
    observationRequestsAfterPush: matchingRows(detectionRows, '/observation'),
    projectEventFramesDuringExternalPush: projectHintStream.events.length,
    projectEventScope: 'project SSE is a local sync hint; the external bare-remote push is detected by authoritative observation polling',
  };
  await writeProgress();

  await writeProgress();

  await local.context.close();
  currentContext = undefined;

  if (process.env.SCRIPTORIUM_E2E_NATIVE_VISIBILITY === '1') {
    try {
      nativeVisibility = await connectNativeHeadfulContext();
      report.visibilitySetup = {
        ...report.visibilitySetup,
        status: 'ready',
        ...nativeVisibility.facts,
      };
    } catch (error) {
      report.visibilitySetup = {
        ...report.visibilitySetup,
        status: 'NOT_CHECKED: native headful Chromium setup failed',
        error: error instanceof Error ? error.message : String(error),
      };
      report.polling.hiddenAndFocus = {
        status: 'NOT_CHECKED',
        reason: report.visibilitySetup.status,
        error: report.visibilitySetup.error,
      };
      report.notChecked.push('Natural hidden polling and focus-return freshness: native headful Chromium did not start successfully.');
    }
    if (nativeVisibility) {
    const nativeVisible = await openExistingProject('native-headful-visible', 0, nativeVisibility);
    await nativeVisible.network.waitQuiet();
    const nativeVisibleStart = networkRows.length;
    const nativeVisibleAt = performance.now();
    await nativeVisible.page.waitForTimeout(idleMs);
    const nativeVisibleRows = networkRows.slice(nativeVisibleStart);
    report.polling.nativeVisible = {
      requestedMs: idleMs,
      elapsedMs: performance.now() - nativeVisibleAt,
      visibility: await nativeVisible.page.evaluate(() => document.visibilityState),
      focus: await nativeVisible.page.evaluate(() => document.hasFocus()),
      requestCount: nativeVisibleRows.length,
      observationCount: matchingRows(nativeVisibleRows, '/observation').length,
      observationRequests: matchingRows(nativeVisibleRows, '/observation'),
      allRequests: nativeVisibleRows,
      setupCommit: nativeVisibility.facts.validatedHarnessCommit,
    };

    const foreground = await nativeVisibility.context.newPage();
    await foreground.goto('about:blank');
    const originalWindowId = await browserWindowId(nativeVisibility.context, nativeVisible.page);
    const foregroundWindowId = await browserWindowId(nativeVisibility.context, foreground);
    await foreground.bringToFront();
    let naturallyHidden = false;
    let hiddenError;
    try {
      await nativeVisible.page.waitForFunction(() => document.visibilityState === 'hidden', null, { timeout: 3000 });
      naturallyHidden = true;
    } catch (error) {
      if (!(error instanceof Error) || error.name !== 'TimeoutError') throw error;
      hiddenError = error.message;
    }

    if (originalWindowId !== foregroundWindowId || !naturallyHidden) {
      report.polling.hiddenAndFocus = {
        status: 'NOT_CHECKED',
        reason: originalWindowId !== foregroundWindowId
          ? 'Foreground page was not in the original Chromium window; natural hidden state is not attributable to the validated same-window switch.'
          : `Original page did not naturally report hidden after same-window tab switch: ${hiddenError ?? 'unknown reason'}`,
        originalWindowId,
        foregroundWindowId,
        visibilityAfterSwitch: await nativeVisible.page.evaluate(() => document.visibilityState),
        setupCommit: nativeVisibility.facts.validatedHarnessCommit,
      };
      report.notChecked.push('Natural hidden polling and focus-return freshness: the validated native Chromium setup did not produce attributable same-window hidden state in this run.');
    } else {
      await nativeVisible.network.waitQuiet();
      const hiddenStart = networkRows.length;
      const hiddenAt = performance.now();
      const hiddenPush = await externalPush(ready.remote, datasetPath, 2);
      await nativeVisible.page.waitForTimeout(idleMs);
      const hiddenRows = networkRows.slice(hiddenStart);
      const hiddenEnd = performance.now();
      const hiddenObservationCount = matchingRows(hiddenRows, '/observation').length;

      await nativeVisible.page.bringToFront();
      const focusReturnedAt = performance.now();
      await nativeVisible.page.waitForFunction(() => document.visibilityState === 'visible', null, { timeout: 5000 });
      await nativeVisible.page.waitForFunction(head => document.body.innerText.includes(head.slice(0, 12)), hiddenPush.head,
        { timeout: Math.max(idleMs + 5000, 25000) });
      const freshAt = performance.now();
      const afterReturnRows = networkRows.slice(hiddenStart + hiddenRows.length);
      report.polling.hiddenAndFocus = {
        status: 'checked',
        requestedHiddenMs: idleMs,
        hiddenElapsedMs: hiddenEnd - hiddenAt,
        visibilityDuringHidden: 'hidden',
        originalWindowId,
        foregroundWindowId,
        requestsWhileHidden: hiddenRows.length,
        observationCountWhileHidden: hiddenObservationCount,
        observationRequestsWhileHidden: matchingRows(hiddenRows, '/observation'),
        hiddenPush: {
          type: 'synthetic local bare-remote push; no GitHub access',
          head: hiddenPush.head,
          branch: hiddenPush.branch,
          workerRemoteHeadAfterPush: git(workerRemote, 'rev-parse', `refs/heads/${hiddenPush.branch}`),
          detectedAfterReturn: true,
          detectionMsFromPush: freshAt - hiddenPush.pushedAt,
          focusToFreshMs: freshAt - focusReturnedAt,
          observationRequestsAfterReturn: matchingRows(afterReturnRows, '/observation'),
          projectEventFrames: projectHintStream.events.length,
          authority: 'remote observation after visibility return; project SSE remains a local sync hint',
        },
        setupCommit: nativeVisibility.facts.validatedHarnessCommit,
      };
    }
    await foreground.close().catch(() => undefined);
    await nativeVisibility.close();
    nativeVisibility = undefined;
    currentContext = undefined;
    }
    await stopDirectStream(projectHintStream);
    await writeProgress();
  } else {
    report.polling.hiddenAndFocus = {
      status: 'NOT_CHECKED',
      reason: 'SCRIPTORIUM_E2E_NATIVE_VISIBILITY=1, DISPLAY=:97, and SCRIPTORIUM_E2E_CHROMIUM were not all provided.',
    };
    report.notChecked.push('Natural hidden polling and focus-return freshness: the validated native headful Chromium environment was not requested.');
    await stopDirectStream(projectHintStream);
  }

  const added = await openExistingProject('added-rtt', addedRttMs);
  await added.context.close();
  currentContext = undefined;
  } else {
    const added = await openExistingProject('added-rtt', addedRttMs);
    ownerCookie = cookieHeader(await added.context.cookies(base));
    await added.context.close();
    currentContext = undefined;
    if (!ownerCookie) throw new Error('Owner session cookie was unavailable after the added-RTT startup measurement');
  }

  const scopeAndReconnect = await sseScopeAndReconnect(ownerCookie, projectId);
  report.streams.scopeAndReconnect = scopeAndReconnect;
  await writeProgress();

  report.streams.windows = [];
  report.streams.windows.push(await measureStreamWindow('no-stream-baseline', [], streamWindowMs));
  const jobOnly = await openDirectStream('jobs', ownerCookie);
  if (!jobOnly.response.ok) throw new Error(`Owner job SSE failed (${jobOnly.response.status})`);
  report.streams.windows.push(await measureStreamWindow('job-only', ['jobs'], streamWindowMs));
  await stopDirectStream(jobOnly);

  const projectOnly = await openDirectStream('projects', ownerCookie);
  if (!projectOnly.response.ok) throw new Error(`Owner project SSE failed (${projectOnly.response.status})`);
  report.streams.windows.push(await measureStreamWindow('project-only', ['projects'], streamWindowMs));
  await stopDirectStream(projectOnly);

  const both = await Promise.all([openDirectStream('jobs', ownerCookie), openDirectStream('projects', ownerCookie)]);
  if (both.some(stream => !stream.response.ok)) throw new Error('A combined owner job/project SSE connection failed');
  report.streams.windows.push(await measureStreamWindow('job-and-project', ['jobs', 'projects'], streamWindowMs));
  report.streams.activeBeforeShutdown = {
    count: activeDirectStreams.size,
    names: [...activeDirectStreams].map(stream => stream.name),
  };
  const beforeShutdown = await serverStats();
  const shutdownStartedAt = performance.now();
  const serverExit = once(server, 'exit');
  server.send('stop');
  const [exitCode] = await Promise.race([
    serverExit,
    delay(15000).then(() => { throw new Error('API server did not shut down while event streams were open'); }),
  ]);
  await Promise.race([Promise.all(both.map(stream => stream.readTask)), delay(5000)]);
  report.streams.shutdown = {
    durationMs: performance.now() - shutdownStartedAt,
    exitCode,
    activeDirectStreamsAfterShutdown: { count: activeDirectStreams.size, names: [...activeDirectStreams].map(stream => stream.name) },
    streamClosedAt: both.map(stream => ({ name: stream.name, closed: stream.closedAt !== null, readError: stream.readError ?? null })),
    serverBefore: serverSnapshot(beforeShutdown),
  };
  report.status = 'complete';
} catch (error) {
  report.status = 'failed';
  report.error = error.stack;
  process.exitCode = 1;
} finally {
  for (const stream of [...activeDirectStreams]) await stopDirectStream(stream);
  await nativeVisibility?.close().catch(() => undefined);
  if (currentContext) await currentContext.close().catch(() => undefined);
  if (browser) await browser.close();
  if (server?.connected) {
    const exit = once(server, 'exit');
    server.send('stop');
    await Promise.race([exit, delay(10000)]);
  }
  try {
    const sourceFixtureAfter = sourceFixtureState();
    const unchanged = JSON.stringify(sourceFixtureBefore) === JSON.stringify(sourceFixtureAfter);
    report.sourceFixture.after = sourceFixtureAfter;
    report.sourceFixture.unchanged = unchanged;
    if (!unchanged) {
      report.status = 'failed';
      report.error = `${report.error ? `${report.error}\n` : ''}G0 source seed or canonical bare remote changed during the network probe`;
      process.exitCode = 1;
    }
  } catch (error) {
    report.status = 'failed';
    report.error = `${report.error ? `${report.error}\n` : ''}Could not verify G0 source fixture after probe: ${error.message}`;
    process.exitCode = 1;
  }
  await writeProgress();
}
