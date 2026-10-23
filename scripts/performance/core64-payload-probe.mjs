import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { arch, platform, release, tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { generate, git } from './dataset.mjs';
import { save } from './common.mjs';

const MiB = 1024 * 1024;
const workerScript = fileURLToPath(new URL('./core64-payload-worker.mjs', import.meta.url));
const sourceRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const workerTimeoutMs = 120_000;
const expectedRuntimeCommit = 'ffd02739ab095dfda2854a3ff487434c84f6b536';
const expectedRuntimeManifestSha256 = 'f16e9db3d4e99c39985044ef44fa677dde62678be54f0d36f53693bf095a9031';
const expectedArtifactRoots = [
  'packages/contracts/dist',
  'packages/module-runtime/dist',
  'packages/core/dist',
  'packages/api/dist',
  'app/dist',
  'profiles/core/generated',
];
const candidateArtifactRoots = expectedArtifactRoots.slice(0, 4);

async function filesUnder(directory) {
  const files = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(path));
    else if (entry.isFile()) files.push(path);
    else throw new Error(`Unexpected candidate runtime artifact: ${path}`);
  }
  return files;
}

async function bindCandidateRuntime(runtimeRoot, runtimeCommit) {
  const sourceCommit = git(sourceRoot, 'rev-parse', 'HEAD');
  if (runtimeRoot !== sourceRoot || runtimeCommit !== sourceCommit) {
    throw new Error('Candidate runtime must be the current probe worktree at its committed source revision.');
  }
  const sourcePaths = ['packages/api/src', 'packages/contracts/src', 'packages/core/src', 'packages/module-runtime/src'];
  const sourceDirty = git(sourceRoot, 'status', '--porcelain', '--untracked-files=all', '--', ...sourcePaths);
  if (sourceDirty) throw new Error(`Candidate runtime source paths are dirty: ${sourceDirty}`);
  const sourceTrees = Object.fromEntries(sourcePaths.map((path) => [path, git(sourceRoot, 'rev-parse', `${runtimeCommit}:${path}`)]));
  const artifacts = [];
  let totalBytes = 0;
  for (const artifactRoot of candidateArtifactRoots) {
    const absoluteRoot = join(runtimeRoot, artifactRoot);
    const files = await filesUnder(absoluteRoot);
    if (files.length === 0) throw new Error(`Candidate runtime artifact root is empty: ${artifactRoot}`);
    for (const file of files) {
      const bytes = await readFile(file);
      const artifact = {
        path: relative(runtimeRoot, file).split(sep).join('/'),
        bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      };
      artifacts.push(artifact);
      totalBytes += bytes.length;
    }
  }
  const artifactManifestSha256 = createHash('sha256').update(JSON.stringify(artifacts)).digest('hex');
  return {
    kind: 'candidate-own-source-build',
    root: runtimeRoot,
    commit: runtimeCommit,
    lockfileTree: git(runtimeRoot, 'rev-parse', `${runtimeCommit}:pnpm-lock.yaml`),
    sourceTrees,
    buildCommand: 'pnpm --filter @scriptorium/api... build (contracts, module-runtime, core, api)',
    installCommand: 'pnpm install --offline --frozen-lockfile',
    node: process.version,
    packageManager: 'pnpm@12.10.1',
    artifactRoots: candidateArtifactRoots,
    artifactFiles: artifacts.length,
    artifactBytes: totalBytes,
    artifactManifestSha256,
    artifacts,
  };
}

async function bindRuntime() {
  const requestedRoot = process.env.SCRIPTORIUM_PERF_RUNTIME_ROOT;
  if (!requestedRoot) throw new Error('Set SCRIPTORIUM_PERF_RUNTIME_ROOT to the frozen C09 or committed candidate runtime root.');
  const runtimeRoot = resolve(requestedRoot);
  const runtimeCommit = git(runtimeRoot, 'rev-parse', 'HEAD');
  if (runtimeRoot === sourceRoot) return await bindCandidateRuntime(runtimeRoot, runtimeCommit);
  return await bindFrozenRuntime(runtimeRoot, runtimeCommit);
}

async function bindFrozenRuntime(runtimeRoot, runtimeCommit) {
  const manifestPath = resolve(process.env.SCRIPTORIUM_PERF_RUNTIME_MANIFEST ??
    join(sourceRoot, 'evidence/performance/resize-runtime-manifest.json'));
  if (runtimeCommit !== expectedRuntimeCommit) {
    throw new Error(`Expected frozen C09 runtime ${expectedRuntimeCommit}, found ${runtimeCommit} in ${runtimeRoot}`);
  }

  const manifestBytes = await readFile(manifestPath);
  const manifestSha256 = createHash('sha256').update(manifestBytes).digest('hex');
  if (manifestSha256 !== expectedRuntimeManifestSha256) throw new Error('Frozen C09 runtime manifest SHA-256 mismatch.');
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  if (manifest.sourceCommit !== expectedRuntimeCommit || resolve(manifest.runtimeRoot) !== runtimeRoot ||
      manifest.productionIdentity?.identical !== true || manifest.dirtyProductionPaths?.length !== 0 ||
      JSON.stringify(manifest.artifactRoots) !== JSON.stringify(expectedArtifactRoots)) {
    throw new Error('Frozen C09 runtime manifest does not bind the expected source and six artifact roots.');
  }

  const runtimeSourceTrees = {};
  const sourceTrees = {};
  const sourceDirty = git(sourceRoot, 'status', '--porcelain', '--untracked-files=all', '--', 'packages/api/src', 'packages/contracts/src');
  if (sourceDirty) throw new Error(`Probe API/contracts source paths are dirty: ${sourceDirty}`);
  for (const path of ['packages/api/src', 'packages/contracts/src']) {
    runtimeSourceTrees[path] = git(runtimeRoot, 'rev-parse', `${runtimeCommit}:${path}`);
    sourceTrees[path] = git(sourceRoot, 'rev-parse', `HEAD:${path}`);
    if (runtimeSourceTrees[path] !== sourceTrees[path]) {
      throw new Error(`Frozen runtime ${path} source differs from the probe checkout.`);
    }
  }

  const listedRoots = new Set(expectedArtifactRoots);
  const listedPaths = new Set();
  let artifactBytes = 0;
  for (const artifact of manifest.files ?? []) {
    if (typeof artifact.path !== 'string' || isAbsolute(artifact.path) || artifact.path.split(/[\\/]/).includes('..') ||
        ![...listedRoots].some((root) => artifact.path.startsWith(`${root}/`)) || listedPaths.has(artifact.path)) {
      throw new Error(`Invalid or duplicate frozen runtime artifact path: ${artifact.path}`);
    }
    listedPaths.add(artifact.path);
    const filePath = resolve(runtimeRoot, artifact.path);
    const relativePath = relative(runtimeRoot, filePath);
    if (relativePath.startsWith(`..${sep}`) || relativePath === '..') {
      throw new Error(`Frozen runtime artifact escapes its root: ${artifact.path}`);
    }
    const bytes = await readFile(filePath);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (bytes.length !== artifact.bytes || sha256 !== artifact.sha256) {
      throw new Error(`Frozen runtime artifact hash/size mismatch: ${artifact.path}`);
    }
    artifactBytes += bytes.length;
  }
  if (listedPaths.size !== manifest.totals?.fileCount || artifactBytes !== manifest.totals?.bytes ||
      [...listedRoots].some((root) => ![...listedPaths].some((path) => path.startsWith(`${root}/`)))) {
    throw new Error('Frozen runtime artifact inventory is incomplete.');
  }

  return {
    root: runtimeRoot,
    commit: runtimeCommit,
    manifest: manifestPath,
    manifestSha256,
    artifactFiles: listedPaths.size,
    artifactBytes,
    apiAndContractsSourceTrees: runtimeSourceTrees,
  };
}

function messageChannel(child) {
  const queued = [];
  const waiters = [];
  let exitValue;
  child.on('message', (message) => {
    if (message?.type === 'fatal') {
      const error = new Error(message.message ?? 'Payload worker failed');
      for (const waiter of waiters.splice(0)) {
        clearTimeout(waiter.timer);
        waiter.reject(error);
      }
      return;
    }
    const index = waiters.findIndex((waiter) => waiter.predicate(message));
    if (index >= 0) {
      const [waiter] = waiters.splice(index, 1);
      clearTimeout(waiter.timer);
      waiter.resolve(message);
    } else queued.push(message);
  });
  child.once('exit', (code, signal) => {
    exitValue = { code, signal };
    for (const waiter of waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(`Payload worker exited before its response: ${JSON.stringify(exitValue)}`));
    }
  });
  child.once('error', (error) => {
    for (const waiter of waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  });
  return {
    waitFor(type, extra = {}, timeoutMs = workerTimeoutMs) {
      const predicate = (message) => message?.type === type &&
        Object.entries(extra).every(([key, value]) => message[key] === value);
      const index = queued.findIndex(predicate);
      if (index >= 0) return Promise.resolve(queued.splice(index, 1)[0]);
      if (exitValue) return Promise.reject(new Error(`Payload worker already exited: ${JSON.stringify(exitValue)}`));
      return new Promise((resolveMessage, rejectMessage) => {
        const waiter = { predicate, resolve: resolveMessage, reject: rejectMessage, timer: undefined };
        waiter.timer = setTimeout(() => {
          const waiterIndex = waiters.indexOf(waiter);
          if (waiterIndex >= 0) waiters.splice(waiterIndex, 1);
          rejectMessage(new Error(`Timed out waiting for payload worker message ${type}`));
        }, timeoutMs);
        waiters.push(waiter);
      });
    },
  };
}

function expectedCases(mode) {
  if (mode === '--small-only') return [{ name: 'small-accepted', rawBytes: 4, kind: 'accepted' }];
  if (mode === '--with-heavy') {
    return [
      { name: 'small-accepted', rawBytes: 4, kind: 'accepted' },
      { name: 'operation-6MiB', rawBytes: 6 * MiB, kind: 'operation-limit' },
      { name: 'operation-8MiB', rawBytes: 8 * MiB, kind: 'operation-limit' },
      { name: 'json-10MiB', rawBytes: 10 * MiB, kind: 'json-limit' },
      { name: 'json-32MiB', rawBytes: 32 * MiB, kind: 'json-limit' },
      { name: 'abort-partial-6MiB', rawBytes: 6 * MiB, kind: 'abort' },
    ];
  }
  return null;
}

function binaryFor(rawBytes) {
  return rawBytes === 4 ? Buffer.from([0, 1, 2, 250]) : Buffer.alloc(rawBytes, 0x5a);
}

function payloadFor(rawBytes) {
  const binary = binaryFor(rawBytes);
  const dataBase64 = binary.toString('base64');
  const body = JSON.stringify({
    text: 'Synthetic C64 payload boundary note.',
    source: 'camera',
    attachments: [{ filename: 'probe.bin', mimeType: 'application/octet-stream', dataBase64 }],
  });
  return {
    body,
    rawBytes,
    base64Characters: dataBase64.length,
    jsonBytes: Buffer.byteLength(body),
    expectedSha256: rawBytes === 4 ? createHash('sha256').update(binary).digest('hex') : undefined,
  };
}

async function fullRequest(base, cookie, projectId, body) {
  const response = await fetch(`${base}/api/projects/${projectId}/scratch`, {
    method: 'POST',
    headers: { Cookie: cookie, Origin: base, 'Content-Type': 'application/json' },
    body,
    signal: AbortSignal.timeout(workerTimeoutMs),
  });
  let responseBody;
  try { responseBody = await response.json(); }
  catch { responseBody = { unparsedBody: true }; }
  return {
    status: response.status,
    code: typeof responseBody?.code === 'string' ? responseBody.code : undefined,
    body: responseBody,
  };
}

async function abortPartialRequest(base, cookie, projectId, rawBytes) {
  const prefix = '{"text":"Cancelled before upload completed.","attachments":[{"filename":"probe.bin","mimeType":"application/octet-stream","dataBase64":"';
  const suffix = '"}]}';
  const encodedBytes = 4 * Math.ceil(rawBytes / 3);
  const declaredLength = Buffer.byteLength(prefix) + encodedBytes + Buffer.byteLength(suffix);
  const partial = `${prefix}${'A'.repeat(4096)}`;
  const url = new URL(`${base}/api/projects/${projectId}/scratch`);
  const outcome = await new Promise((resolveOutcome) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolveOutcome(value);
    };
    const request = httpRequest({
      hostname: url.hostname,
      port: Number(url.port),
      path: url.pathname,
      method: 'POST',
      headers: {
        Cookie: cookie,
        Origin: base,
        'Content-Type': 'application/json',
        'Content-Length': String(declaredLength),
      },
    }, (response) => {
      response.resume();
      response.once('end', () => finish({ status: response.statusCode ?? null }));
    });
    request.once('error', (error) => finish({ status: null, transportError: error.code ?? error.message }));
    request.write(partial);
    setTimeout(() => request.destroy(new Error('intentional synthetic upload abort')), 75).unref();
  });
  return { ...outcome, declaredJsonBytes: declaredLength, sentBodyBytes: Buffer.byteLength(partial) };
}

function diff(before, after) {
  const setDelta = (left, right) => ({
    added: right.filter((item) => !left.includes(item)),
    removed: left.filter((item) => !right.includes(item)),
  });
  return {
    proposalCount: after.proposalCount - before.proposalCount,
    pendingCheckpointCount: after.pendingCheckpointCount - before.pendingCheckpointCount,
    remoteScratchFiles: setDelta(before.remoteScratchFiles, after.remoteScratchFiles),
    checkpointScratchFiles: setDelta(before.checkpointScratchFiles, after.checkpointScratchFiles),
    coreCalls: Object.fromEntries(Object.keys(after.coreCalls).map((key) => [key, after.coreCalls[key] - before.coreCalls[key]])),
  };
}

function validateSample(sample, sourceSeedCommit) {
  const checks = [];
  const check = (name, passed, evidence = undefined) => checks.push({ name, passed: Boolean(passed), ...(evidence === undefined ? {} : { evidence }) });
  const delta = sample.delta;
  check('generated-source-remote-head-unchanged',
    sample.sourceSeedCommitBefore === sourceSeedCommit && sample.sourceSeedCommitAfter === sourceSeedCommit,
    { before: sample.sourceSeedCommitBefore, after: sample.sourceSeedCommitAfter, expected: sourceSeedCommit });
  if (sample.kind === 'accepted') {
    const attachmentPath = sample.responseBody?.attachments?.[0]?.path;
    const markdownPath = sample.responseBody?.path;
    const operationId = sample.responseBody?.receipt?.operationId;
    const storedProposal = sample.after.proposals.find((proposal) => proposal.id === sample.responseBody?.proposal?.id);
    const storedReceipt = storedProposal?.checkpoints.find((receipt) => receipt.operationId === operationId);
    check('accepted-http-201', sample.response?.status === 201, sample.response?.status);
    check('core-propose-approve-checkpoint-each-once', JSON.stringify(delta.coreCalls) === JSON.stringify({ propose: 1, approve: 1, checkpoint: 1 }), delta.coreCalls);
    check('one-proposal-and-checkpoint-added', delta.proposalCount === 1 && delta.pendingCheckpointCount === 1, delta);
    check('two-files-only-in-checkpoint-view',
      delta.remoteScratchFiles.added.length === 0 && delta.remoteScratchFiles.removed.length === 0 &&
      delta.checkpointScratchFiles.added.length === 2 && delta.checkpointScratchFiles.removed.length === 0 &&
      delta.checkpointScratchFiles.added.includes(attachmentPath) && delta.checkpointScratchFiles.added.includes(markdownPath), delta);
    check('binary-bytes-and-hash-match',
      sample.after.files[attachmentPath]?.checkpoint?.bytes === sample.rawBytes &&
      sample.after.files[attachmentPath]?.checkpoint?.sha256 === sample.expectedSha256, sample.after.files[attachmentPath]?.checkpoint);
    check('checkpointed-proposal-has-matching-receipt',
      storedProposal?.state === 'checkpointed' && isDeepStrictEqual(storedReceipt, sample.responseBody.receipt), {
        state: storedProposal?.state,
        receiptMatches: isDeepStrictEqual(storedReceipt, sample.responseBody.receipt),
      });
  } else {
    if (sample.kind !== 'abort') {
      const expectedStatus = sample.kind === 'operation-limit' ? 400 : 413;
      const expectedCode = sample.kind === 'operation-limit' ? 'invalid_change_operation' : 'BODY_TOO_LARGE';
      check('expected-response-status', sample.response?.status === expectedStatus, sample.response?.status);
      check('expected-error-code', sample.response?.code === expectedCode, sample.response?.code);
    }
    if (sample.kind === 'operation-limit') {
      check('core-propose-reached-before-operation-rejection', delta.coreCalls.propose === 1 && delta.coreCalls.approve === 0 && delta.coreCalls.checkpoint === 0, delta.coreCalls);
    } else {
      check('rejected-before-Core-mutation-methods', delta.coreCalls.propose === 0 && delta.coreCalls.approve === 0 && delta.coreCalls.checkpoint === 0, delta.coreCalls);
    }
    check('no-proposal-checkpoint-or-file-change',
      delta.proposalCount === 0 && delta.pendingCheckpointCount === 0 &&
      delta.remoteScratchFiles.added.length === 0 && delta.remoteScratchFiles.removed.length === 0 &&
      delta.checkpointScratchFiles.added.length === 0 && delta.checkpointScratchFiles.removed.length === 0, delta);
    if (sample.kind === 'abort') {
      check('request-body-abort-observed', sample.serverProbe?.termination === 'request-aborted' || sample.serverProbe?.termination === 'response-closed', sample.serverProbe?.termination);
    }
  }
  sample.checks = checks;
  sample.status = checks.every(({ passed }) => passed) ? 'PASS' : 'FAIL';
  return sample;
}

async function inspectWorker(child, channel, requestId, paths) {
  child.send({ type: 'inspect', requestId, paths });
  return (await channel.waitFor('inspect-result', { requestId })).state;
}

async function executeCase(testCase, datasetRoot, runRoot, runtimeRoot, sourceSeedCommit) {
  const workerRoot = join(runRoot, testCase.name);
  const sourceSeedCommitBefore = git(join(datasetRoot, 'origin.git'), 'rev-parse', 'refs/heads/main');
  if (sourceSeedCommitBefore !== sourceSeedCommit) throw new Error('Generated source remote changed before this scenario.');
  const child = spawn(process.execPath, [workerScript, datasetRoot, workerRoot, runtimeRoot], {
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    env: { ...process.env, SCRIPTORIUM_PROFILE: 'core' },
  });
  const channel = messageChannel(child);
  let didExit = false;
  let exitDetails;
  const exitPromise = new Promise((resolveExit) => {
    child.once('exit', (code, signal) => {
      didExit = true;
      exitDetails = { code, signal };
      resolveExit(exitDetails);
    });
    child.once('error', (error) => {
      didExit = true;
      exitDetails = { error: error.message };
      resolveExit(exitDetails);
    });
  });
  try {
    const ready = await channel.waitFor('ready');
    const sample = {
      name: testCase.name,
      kind: testCase.kind,
      rawBytes: testCase.rawBytes,
      before: ready.initial,
      workerMemoryBeforeRequest: ready.memory,
      response: null,
      responseBody: null,
      payload: null,
      expectedSha256: undefined,
      delta: null,
      after: null,
      serverProbe: null,
    };
    let paths = [];
    if (testCase.kind === 'abort') {
      const outcome = await abortPartialRequest(ready.base, ready.cookie, ready.projectId, testCase.rawBytes);
      sample.payload = {
        rawBytes: testCase.rawBytes,
        base64Characters: 4 * Math.ceil(testCase.rawBytes / 3),
        jsonBytes: outcome.declaredJsonBytes,
        sentBodyBytes: outcome.sentBodyBytes,
      };
      sample.response = { status: outcome.status, transportError: outcome.transportError };
    } else {
      const payload = payloadFor(testCase.rawBytes);
      sample.payload = { rawBytes: payload.rawBytes, base64Characters: payload.base64Characters, jsonBytes: payload.jsonBytes };
      sample.expectedSha256 = payload.expectedSha256;
      const response = await fullRequest(ready.base, ready.cookie, ready.projectId, payload.body);
      sample.response = { status: response.status, code: response.code };
      sample.responseBody = response.body;
      if (testCase.kind === 'accepted' && response.status === 201) {
        paths = [response.body.path, response.body.attachments?.[0]?.path].filter((path) => typeof path === 'string');
      }
    }
    sample.serverProbe = await channel.waitFor('probe');
    if (testCase.kind === 'abort') await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    sample.after = await inspectWorker(child, channel, `${testCase.name}-after`, paths);
    sample.delta = diff(sample.before, sample.after);
    sample.nodeProcessRss = {
      beforeRequest: sample.serverProbe.before,
      afterRequest: sample.serverProbe.after,
      maxRssDeltaKiB: sample.serverProbe.after.peakRssKiB - sample.serverProbe.before.peakRssKiB,
      elapsedMs: sample.serverProbe.elapsedMs,
      requestContentLength: sample.serverProbe.requestContentLength,
      termination: sample.serverProbe.termination,
    };
    sample.sourceSeedCommitBefore = sourceSeedCommitBefore;
    sample.sourceSeedCommitAfter = git(join(datasetRoot, 'origin.git'), 'rev-parse', 'refs/heads/main');
    validateSample(sample, sourceSeedCommit);
    child.send({ type: 'stop' });
    await channel.waitFor('stopped', {}, 30_000);
    await exitPromise;
    if (exitDetails?.code !== 0) throw new Error(`Payload worker exited unsuccessfully: ${JSON.stringify(exitDetails)}`);
    return sample;
  } finally {
    if (!didExit) {
      child.kill('SIGTERM');
      const killTimer = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }, 3_000);
      killTimer.unref();
      await exitPromise;
      clearTimeout(killTimer);
    }
  }
}

async function main() {
  const mode = process.argv[2];
  const cases = expectedCases(mode);
  if (mode === '--verify-runtime') {
    console.log(JSON.stringify(await bindRuntime(), null, 2));
    return;
  }
  if (mode === '--plan') {
    console.log(JSON.stringify({
      smallOnly: expectedCases('--small-only'),
      afterG0Lease: expectedCases('--with-heavy'),
      heavyLeaseGuard: 'CORE64_G0_LEASE=released is required for --with-heavy',
      persistence: 'Each case uses a separate real CoreStore dataDir and real API createScratch route over the shared read-only synthetic bare remote.',
      runtime: 'SCRIPTORIUM_PERF_RUNTIME_ROOT must point to the pinned C09 baseline or the committed candidate worktree; relevant artifacts are verified before any request.',
    }, null, 2));
    return;
  }
  if (!cases) throw new Error('Usage: node scripts/performance/core64-payload-probe.mjs --plan|--verify-runtime|--small-only|--with-heavy');
  if (mode === '--with-heavy' && process.env.CORE64_G0_LEASE !== 'released') {
    throw new Error('Heavy payload/HTTP cases are gated: wait for G0 to release the measurement lease and set CORE64_G0_LEASE=released.');
  }
  const runtime = await bindRuntime();

  const runRoot = await mkdtemp(join(tmpdir(), 'scriptorium-core64-payload-'));
  const datasetRoot = join(runRoot, 'dataset');
  const outputDirectory = join(sourceRoot, 'artifacts/performance/payload');
  await mkdir(outputDirectory, { recursive: true });
  const runId = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-') + `-${process.pid}`;
  const outputFile = join(outputDirectory, `payload-${runId}.json`);
  const sourceCommit = git(sourceRoot, 'rev-parse', 'HEAD');
  const probeScripts = {};
  for (const path of ['scripts/performance/core64-payload-probe.mjs', 'scripts/performance/core64-payload-worker.mjs']) {
    probeScripts[path] = createHash('sha256').update(await readFile(join(sourceRoot, path))).digest('hex');
  }
  const report = {
    schemaVersion: 1,
    runId,
    sourceCommit,
    probeScripts,
    runtime,
    executionContext: {
      cpuAffinity: process.env.SCRIPTORIUM_PERF_CPUSET ?? 'unspecified',
      affinityEnforcer: process.env.SCRIPTORIUM_PERF_CPUSET ? 'taskset' : 'unspecified',
      hardTimeoutSeconds: Number(process.env.SCRIPTORIUM_PERF_HARD_TIMEOUT_SECONDS ?? 0) || null,
      concurrentLanes: (process.env.SCRIPTORIUM_PERF_CONCURRENT_LANES ?? '').split(';').filter(Boolean),
      latencyInterpretation: 'Concurrent measurement lanes make latency observational only; no adoption or comparative performance claim is supported.',
    },
    node: process.version,
    host: { platform: platform(), arch: arch(), release: release() },
    profile: 'core',
    mode,
    status: 'RUNNING',
    thresholds: {
      scratchRawAttachmentBytes: 8 * MiB,
      changeOperationWriteContentBytes: 8 * MiB,
      apiJsonBodyBytes: 12 * MiB,
      coreGitExecFileMaxBufferBytes: 32 * MiB,
      note: 'The 32 MiB Core Git execFile output cap is a separate C30/memory-worker boundary; this HTTP probe cannot establish it.',
    },
    generator: 'scripts/performance/dataset.mjs small short; synthetic bare remote only',
    lease: mode === '--with-heavy' ? 'G0 release asserted by CORE64_G0_LEASE=released' : 'tiny accepted-path probe only',
    dataset: null,
    sourceSeed: null,
    plannedCases: cases.map(({ name, rawBytes, kind }) => ({ name, rawBytes, kind })),
    samples: [],
    unattempted: [],
  };

  try {
    const generated = await generate(datasetRoot, 'small', 'short');
    const sourceSeedCommit = git(generated.remote, 'rev-parse', 'refs/heads/main');
    if (sourceSeedCommit !== generated.commit) throw new Error('Generated bare remote HEAD does not match its dataset seed commit.');
    report.dataset = { ...generated, remote: 'dataset/origin.git' };
    report.sourceSeed = { remote: 'dataset/origin.git', commitBefore: sourceSeedCommit, commitAfter: null, unchanged: null };
    for (const [caseIndex, testCase] of cases.entries()) {
      try {
        const sample = await executeCase(testCase, datasetRoot, runRoot, runtime.root, sourceSeedCommit);
        report.samples.push(sample);
        report.sourceSeed.commitAfter = sample.sourceSeedCommitAfter;
        report.sourceSeed.unchanged = sample.sourceSeedCommitAfter === sourceSeedCommit;
        await save(outputFile, report);
        if (!report.sourceSeed.unchanged) {
          report.status = 'FAIL';
          report.unattempted = cases.slice(caseIndex + 1).map(({ name }) => ({
            name,
            status: 'NOT_CHECKED',
            reason: 'Generated source remote changed during an earlier scenario.',
          }));
          await save(outputFile, report);
          process.exitCode = 1;
          return;
        }
      } catch (error) {
        report.sourceSeed.commitAfter = git(generated.remote, 'rev-parse', 'refs/heads/main');
        report.sourceSeed.unchanged = report.sourceSeed.commitAfter === sourceSeedCommit;
        report.status = 'NOT_CHECKED';
        report.failure = error instanceof Error ? error.stack : String(error);
        report.unattempted = cases.filter(({ name }) => !report.samples.some((sample) => sample.name === name) && name !== testCase.name)
          .map(({ name }) => ({ name, status: 'NOT_CHECKED', reason: 'Earlier probe worker failed.' }));
        report.samples.push({ name: testCase.name, status: 'NOT_CHECKED', reason: report.failure });
        await save(outputFile, report);
        process.exitCode = 1;
        return;
      }
    }
    report.sourceSeed.commitAfter = git(generated.remote, 'rev-parse', 'refs/heads/main');
    report.sourceSeed.unchanged = report.sourceSeed.commitAfter === sourceSeedCommit;
    report.status = report.samples.every((sample) => sample.status === 'PASS') ? 'PASS' : 'FAIL';
    await save(outputFile, report);
    console.log(JSON.stringify({ status: report.status, outputFile }, null, 2));
    if (report.status !== 'PASS') process.exitCode = 1;
  } finally {
    await rm(runRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
