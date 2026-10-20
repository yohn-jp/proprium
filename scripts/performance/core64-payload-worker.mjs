import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';

const [datasetRootValue, workerRootValue, runtimeRootValue] = process.argv.slice(2);
if (!datasetRootValue || !workerRootValue || !runtimeRootValue) {
  throw new Error('Usage: core64-payload-worker.mjs <dataset-root> <worker-root> <frozen-runtime-root>');
}

const datasetRoot = resolve(datasetRootValue);
const workerRoot = resolve(workerRootValue);
const runtimeRoot = resolve(runtimeRootValue);
const remote = join(datasetRoot, 'origin.git');
const dataDir = join(workerRoot, 'core-data');
const usageDirectory = join(workerRoot, 'usage');
const staticDir = join(workerRoot, 'static');
const authToken = 'core64-synthetic-payload-probe-token';
await mkdir(workerRoot, { recursive: true });
await mkdir(staticDir, { recursive: true });

const { CoreStore } = await import(pathToFileURL(join(runtimeRoot, 'packages/core/dist/index.js')));
const { createServer } = await import(pathToFileURL(join(runtimeRoot, 'packages/api/dist/server.js')));
const store = new CoreStore({ dataDir, allowLocalRemotes: true });
const coreCalls = { propose: 0, approve: 0, checkpoint: 0 };
for (const method of Object.keys(coreCalls)) {
  const original = store[method].bind(store);
  store[method] = async (...args) => {
    coreCalls[method] += 1;
    return original(...args);
  };
}

const project = await store.registerProject({ url: remote });
await store.observe(project.id);
const server = createServer({
  store,
  authToken,
  staticDir,
  profile: 'core',
  usageDirectory,
  runtimeOptions: { manifests: [], enabled: [], cacheDirectory: join(workerRoot, 'module-cache') },
});

function memorySample() {
  const memory = process.memoryUsage();
  const usage = process.resourceUsage();
  return {
    rssBytes: memory.rss,
    heapUsedBytes: memory.heapUsed,
    peakRssKiB: usage.maxRSS,
  };
}

let probeSent = false;
server.prependListener('request', (request, response) => {
  const expectedPath = `/api/projects/${project.id}/scratch`;
  if (request.method !== 'POST' || request.url?.split('?', 1)[0] !== expectedPath) return;
  const startedAt = performance.now();
  const before = memorySample();
  const cpuBefore = process.cpuUsage();
  let sent = false;
  const sendProbe = (termination) => {
    if (sent) return;
    sent = true;
    probeSent = true;
    const cpu = process.cpuUsage(cpuBefore);
    if (typeof process.send === 'function') {
      process.send({
        type: 'probe',
        termination,
        status: response.headersSent ? response.statusCode : null,
        requestContentLength: Number(request.headers['content-length'] ?? 0),
        elapsedMs: performance.now() - startedAt,
        cpuUs: cpu,
        before,
        after: memorySample(),
      });
    }
  };
  request.once('aborted', () => sendProbe('request-aborted'));
  response.once('finish', () => sendProbe('response-finished'));
  response.once('close', () => sendProbe(response.writableEnded ? 'response-finished' : 'response-closed'));
});

async function inspect(paths = []) {
  const proposals = await store.listProposals(project.id);
  const census = await store.localDurabilityCensus(project.id);
  const remoteReader = await store.reader(project.id, 'remote');
  const checkpointReader = await store.reader(project.id, 'checkpoint');
  const remoteScratchFiles = await remoteReader.list('meta/scratch');
  const checkpointScratchFiles = await checkpointReader.list('meta/scratch');
  const files = {};
  for (const path of paths) {
    const [remoteFile, checkpointFile] = await Promise.all([
      remoteReader.read(path, path.endsWith('.bin') ? 'base64' : 'utf8'),
      checkpointReader.read(path, path.endsWith('.bin') ? 'base64' : 'utf8'),
    ]);
    const summarize = (file) => {
      if (!file) return null;
      if (path.endsWith('.bin')) {
        const bytes = Buffer.from(file.content, 'base64');
        return { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), revision: file.revision };
      }
      return { bytes: Buffer.byteLength(file.content), sha256: createHash('sha256').update(file.content).digest('hex'), revision: file.revision };
    };
    files[path] = { remote: summarize(remoteFile), checkpoint: summarize(checkpointFile) };
  }
  return {
    proposalCount: proposals.length,
    proposals: proposals.map(({ proposal, state, checkpoints, approvedOperationIds }) => ({
      id: proposal.id,
      operationIds: proposal.operations.map(({ id }) => id),
      state,
      approvedOperationIds,
      checkpoints,
    })),
    pendingCheckpointCount: census.pendingCheckpoints.length,
    pendingCheckpoints: census.pendingCheckpoints,
    remoteScratchFiles,
    checkpointScratchFiles,
    files,
    coreCalls: { ...coreCalls },
  };
}

function send(message) {
  if (typeof process.send === 'function' && process.connected) process.send(message);
}

function sendAndDisconnect(message, exitCode = 0) {
  process.exitCode = exitCode;
  if (typeof process.send === 'function' && process.connected) {
    process.send(message, (error) => {
      if (error) process.exitCode = 1;
      process.disconnect();
    });
  } else process.disconnect();
}

try {
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('API did not bind an ephemeral TCP port');
  const base = `http://127.0.0.1:${address.port}`;
  const login = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify({ token: authToken }),
  });
  if (login.status !== 200) throw new Error(`Synthetic owner login failed: ${login.status}`);
  const setCookie = login.headers.get('set-cookie');
  if (!setCookie) throw new Error('Synthetic owner login omitted its session cookie');
  const cookie = setCookie.split(';', 1)[0];
  const initial = await inspect();
  send({
    type: 'ready',
    base,
    cookie,
    projectId: project.id,
    initial,
    memory: memorySample(),
    coreCalls: { ...coreCalls },
    source: 'real CoreStore plus real API createScratch route',
  });

  process.on('message', (message) => {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'inspect') {
      void inspect(Array.isArray(message.paths) ? message.paths : []).then((state) => {
        send({ type: 'inspect-result', requestId: message.requestId, state });
      }, (error) => send({ type: 'fatal', message: error instanceof Error ? error.stack : String(error) }));
    }
    if (message.type === 'stop') {
      void new Promise((resolveClose, rejectClose) => {
        server.close((error) => error ? rejectClose(error) : resolveClose());
      }).then(() => {
        sendAndDisconnect({ type: 'stopped', probeSent });
      }, (error) => {
        sendAndDisconnect({ type: 'fatal', message: error instanceof Error ? error.stack : String(error) }, 1);
      });
    }
  });
} catch (error) {
  send({ type: 'fatal', message: error instanceof Error ? error.stack : String(error) });
  process.exitCode = 1;
}
