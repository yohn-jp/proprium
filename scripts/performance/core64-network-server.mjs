import { createHash, randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { counts, gitCommands } from './instrument-node.mjs';
import { git } from './dataset.mjs';
import { io } from './common.mjs';

const [datasetArg, runtimeRootArg, manifestArg, expectedSource, expectedManifestHash] = process.argv.slice(2);
if (!datasetArg || !runtimeRootArg || !manifestArg || !expectedSource || !expectedManifestHash) {
  throw new Error('Network probe server requires dataset, runtime root, manifest, source SHA, and manifest SHA');
}
const datasetPath = resolve(datasetArg);
const runtimeRoot = resolve(runtimeRootArg);
const manifestPath = resolve(manifestArg);
const manifestBytes = await readFile(manifestPath);
const manifestHash = createHash('sha256').update(manifestBytes).digest('hex');
const manifest = JSON.parse(manifestBytes.toString('utf8'));
if (manifestHash !== expectedManifestHash || manifest.sourceCommit !== expectedSource ||
    git(runtimeRoot, 'rev-parse', 'HEAD') !== expectedSource) {
  throw new Error('Runtime identity changed after the parent probe verified the artifact manifest');
}

const start = performance.now();
const { CoreStore } = await import(pathToFileURL(join(runtimeRoot, 'packages/core/dist/index.js')).href);
const { createServer } = await import(pathToFileURL(join(runtimeRoot, 'packages/api/dist/server.js')).href);
const dataDir = join(datasetPath, `browser-state-${randomUUID()}`);
const remote = join(datasetPath, `browser-remote-${randomUUID()}.git`);
git(datasetPath, 'clone', '--bare', join(datasetPath, 'origin.git'), remote);
const store = new CoreStore({ dataDir, allowLocalRemotes: true });
const staticDir = resolve(runtimeRoot, 'app/dist');
const server = createServer({
  store,
  authToken: 'synthetic-benchmark-local-token-000000',
  profile: 'core',
  staticDir,
  usageDirectory: join(dataDir, 'usage'),
});
const requests = [];
server.prependListener('request', (request, response) => {
  const at = performance.now();
  response.once('finish', () => requests.push({ method: request.method, path: request.url.split('?')[0],
    startMs: at, ms: performance.now() - at, status: response.statusCode,
    contentLength: Number(response.getHeader('content-length') ?? 0) }));
});
server.listen(0, '127.0.0.1', () => process.send({
  ready: true,
  remote,
  port: server.address().port,
  startupMs: performance.now() - start,
  runtimeSource: expectedSource,
  runtimeManifestSha256: manifestHash,
  staticDir,
  stateDir: dataDir,
}));
let stopping = false;
async function stopServer() {
  if (stopping) return;
  stopping = true;
  server.close(async () => {
    await Promise.all([
      rm(dataDir, { recursive: true, force: true }),
      rm(remote, { recursive: true, force: true }),
    ]);
    process.exit(0);
  });
}
process.on('message', async message => {
  if (message === 'stats') process.send({ requests, counts, gitCommands, cpu: process.cpuUsage(),
    memory: process.memoryUsage(), usage: process.resourceUsage(), io: await io() });
  if (message === 'stop') stopServer();
});
process.on('disconnect', stopServer);
