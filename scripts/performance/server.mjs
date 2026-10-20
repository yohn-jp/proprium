import { counts, gitCommands } from './instrument-node.mjs';
import { performance } from 'node:perf_hooks';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { git } from './dataset.mjs';
import { io } from './common.mjs';
const start = performance.now();
const { CoreStore } = await import('../../packages/core/dist/index.js');
const { createServer } = await import('../../packages/api/dist/server.js');
const dataDir = join(process.argv[2], `browser-state-${randomUUID()}`);
const remote = join(process.argv[2], `browser-remote-${randomUUID()}.git`);
git(process.argv[2], 'clone', '--bare', join(process.argv[2], 'origin.git'), remote);
const store = new CoreStore({ dataDir, allowLocalRemotes: true });
const requests = [];
const server = createServer({ store, authToken: 'synthetic-benchmark-local-token-000000',
  profile: 'core', staticDir: resolve('app/dist'), usageDirectory: join(dataDir, 'usage') });
server.prependListener('request', (request, response) => {
  const at = performance.now();
  response.once('finish', () => requests.push({ method: request.method, path: request.url.split('?')[0],
    startMs: at, ms: performance.now() - at, status: response.statusCode,
    contentLength: Number(response.getHeader('content-length') ?? 0) }));
});
server.listen(0, '127.0.0.1', () => process.send({ ready: true, remote, port: server.address().port, startupMs: performance.now() - start }));
process.on('message', async message => {
  if (message === 'stats') process.send({ requests, counts, gitCommands, cpu: process.cpuUsage(),
    memory: process.memoryUsage(), usage: process.resourceUsage(), io: await io() });
  if (message === 'stop') server.close(() => process.exit(0));
});
process.on('disconnect', () => server.close(() => process.exit(0)));
