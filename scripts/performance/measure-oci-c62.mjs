#!/usr/bin/env node

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';

const [profile, image, sourceSha, outputPath] = process.argv.slice(2);
if (!['core', 'full'].includes(profile) || !image || !/^[a-f0-9]{40}$/u.test(sourceSha ?? '') || !outputPath) {
  console.error('Usage: measure-oci-c62.mjs <core|full> <image> <40-char-source-sha> <output.json>');
  process.exit(2);
}

const root = process.cwd();
const engine = path.join(root, 'scripts/performance/oci-c62-podman.sh');
const sampleCount = 5;
const idleWindowMs = 30_000;
const idleWarmupMs = 5_000;
const startupTimeoutMs = 30_000;

function runEngine(args, { allowFailure = false } = {}) {
  const result = spawnSync(engine, args, { cwd: root, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (!allowFailure && result.status !== 0) {
    throw new Error(`Podman ${args[0]} failed (${result.status}):\n${result.stdout}\n${result.stderr}`);
  }
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function percentile(values, percentileValue) {
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil(percentileValue * sorted.length));
  return sorted[rank - 1];
}

function parseImageInfo() {
  const format = '{{.Id}}|{{.Digest}}|{{.Size}}|{{.Os}}|{{.Architecture}}';
  const fields = runEngine(['image', 'inspect', '--format', format, image]).stdout.trim().split('|');
  assert.equal(fields.length, 5, 'Podman image inspection returned all identity fields');
  const [id, digest, sizeText, osName, architecture] = fields;
  assert.ok(id && digest, 'image ID and manifest digest are present');
  const sizeBytes = Number(sizeText);
  assert.ok(Number.isSafeInteger(sizeBytes) && sizeBytes > 0, 'image size is a positive byte count');
  assert.equal(osName, 'linux');
  assert.equal(architecture, 'amd64');
  return { reference: image, id, digest, sizeBytes, os: osName, architecture };
}

async function waitUntilReady(baseUrl) {
  const deadline = performance.now() + startupTimeoutMs;
  while (performance.now() < deadline) {
    try {
      const response = await fetch(new URL('/api/ready', baseUrl), {
        redirect: 'error',
        signal: AbortSignal.timeout(1_000),
      });
      if (response.status === 200) {
        const body = await response.json();
        if (body.ok === true) return;
      }
    } catch {
      // The server is still starting or the short probe timed out.
    }
    await delay(100);
  }
  throw new Error(`Image did not become ready within ${startupTimeoutMs} ms at ${baseUrl}`);
}

const idleSampler = String.raw`
const fs = require('node:fs');
const { setTimeout: delay } = require('node:timers/promises');
const ownPid = process.pid;
const windowMs = 30000;
const intervalMs = 1000;
function processRssKiB() {
  let total = 0;
  for (const entry of fs.readdirSync('/proc')) {
    if (!/^\d+$/u.test(entry) || Number(entry) === ownPid) continue;
    try {
      const status = fs.readFileSync('/proc/' + entry + '/status', 'utf8');
      total += Number(status.match(/^VmRSS:\s+(\d+)\s+kB$/mu)?.[1] ?? 0);
    } catch {}
  }
  return total;
}
function cpuUsageUsec() {
  const data = fs.readFileSync('/sys/fs/cgroup/cpu.stat', 'utf8');
  const value = data.match(/^usage_usec\s+(\d+)$/mu)?.[1];
  if (!value) throw new Error('cgroup cpu.stat has no usage_usec field');
  return Number(value);
}
async function main() {
const samples = [];
let previous = { timeNs: process.hrtime.bigint(), rssKiB: processRssKiB(), cpuUsec: cpuUsageUsec() };
samples.push({ elapsedMs: 0, rssKiB: previous.rssKiB, cpuPercentOneCore: null });
const started = process.hrtime.bigint();
for (let i = 0; i < windowMs / intervalMs; i += 1) {
  await delay(intervalMs);
  const current = { timeNs: process.hrtime.bigint(), rssKiB: processRssKiB(), cpuUsec: cpuUsageUsec() };
  const elapsedSeconds = Number(current.timeNs - previous.timeNs) / 1e9;
  const cpuPercentOneCore = ((current.cpuUsec - previous.cpuUsec) / (elapsedSeconds * 1e6)) * 100;
  samples.push({
    elapsedMs: Number(current.timeNs - started) / 1e6,
    rssKiB: current.rssKiB,
    cpuPercentOneCore,
  });
  previous = current;
}
const totalElapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
console.log(JSON.stringify({ windowTargetMs: windowMs, totalElapsedMs, samples }));
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
`;

function summarizeIdle(raw) {
  const samples = raw.samples;
  assert.equal(samples.length, 31, 'idle sample contains start plus 30 one-second observations');
  assert.ok(raw.totalElapsedMs >= idleWindowMs - 1_500, 'idle window spans at least 28.5 seconds');
  const rss = samples.map((sample) => sample.rssKiB);
  const cpu = samples.slice(1).map((sample) => sample.cpuPercentOneCore);
  return {
    windowTargetMs: idleWindowMs,
    windowActualMs: Math.round(raw.totalElapsedMs),
    intervalMs: 1_000,
    sampleCount: samples.length,
    rssKiB: {
      p50: percentile(rss, 0.50),
      p95: percentile(rss, 0.95),
      max: Math.max(...rss),
      samples,
    },
    cpuPercentOfOneCore: {
      mean: Number((cpu.reduce((sum, value) => sum + value, 0) / cpu.length).toFixed(4)),
      max: Number(Math.max(...cpu).toFixed(4)),
      source: '/sys/fs/cgroup/cpu.stat usage_usec',
      samples: cpu,
    },
  };
}

async function executeContainer(index, idle) {
  const suffix = `${process.pid}-${index}-${randomBytes(4).toString('hex')}`;
  const name = `c64-oci-${profile}-${suffix}`;
  const token = randomBytes(24).toString('hex');
  let started = false;
  let assertions = { index, name, assets: 'NOT_CHECKED', dataWritable: false, historyWritable: false, uid: null, sigtermDrain: 'NOT_CHECKED' };
  try {
    const startAt = performance.now();
    runEngine([
      'run', '--detach', '--name', name, '--stop-timeout', '30',
      '--publish', '127.0.0.1::3000/tcp',
      '--env', `SCRIPTORIUM_AUTH_TOKEN=${token}`,
      '--env', 'SCRIPTORIUM_DATA_DIR=/data',
      '--env', 'SCRIPTORIUM_USAGE_DIR=/history',
      image,
    ]);
    started = true;
    const portText = runEngine(['port', name, '3000/tcp']).stdout.trim();
    const portMatch = portText.match(/(?:127\.0\.0\.1|0\.0\.0\.0|\[::1\]|\[::\]):(\d+)$/mu);
    assert.ok(portMatch, `Podman returned a loopback published port: ${portText}`);
    const baseUrl = `http://127.0.0.1:${portMatch[1]}`;
    await waitUntilReady(baseUrl);
    const startToReadyMs = Number((performance.now() - startAt).toFixed(3));

    const assets = spawnSync(process.execPath, ['scripts/verify-oci-http.mjs', baseUrl, profile], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
    });
    if (assets.error) throw assets.error;
    assert.equal(assets.status, 0, `HTTP/profile/assets verification passed:\n${assets.stdout}\n${assets.stderr}`);
    assertions.assets = 'PASS';
    assertions.assetSummary = (assets.stdout + assets.stderr).trim();

    const uid = runEngine(['exec', name, 'node', '-p', 'process.getuid()']).stdout.trim();
    assert.equal(uid, '1000', 'container application process uses UID 1000');
    assertions.uid = Number(uid);
    const marker = `.oci-c62-${suffix}`;
    const writeProbe = String.raw`const fs=require('node:fs');for(const dir of ['/data','/history']){const p=dir+'/${marker}';fs.writeFileSync(p,'c62');if(fs.readFileSync(p,'utf8')!=='c62')process.exit(3);fs.unlinkSync(p);}`;
    runEngine(['exec', name, 'node', '-e', writeProbe]);
    assertions.dataWritable = true;
    assertions.historyWritable = true;

    if (idle) {
      await delay(idleWarmupMs);
      const sample = runEngine(['exec', name, 'node', '-e', idleSampler]);
      assertions.idle = summarizeIdle(JSON.parse(sample.stdout.trim()));
    }

    runEngine(['kill', '--signal', 'TERM', name]);
    const exitCodeText = runEngine(['wait', name]).stdout.trim();
    const logResult = runEngine(['logs', name]);
    const logs = logResult.stdout + logResult.stderr;
    assert.equal(exitCodeText, '0', `SIGTERM exits cleanly (exit ${exitCodeText})`);
    assert.ok(logs.includes('Scriptorium shutdown complete'), 'SIGTERM completed the API drain callback');
    assertions.sigtermDrain = 'PASS';
    assertions.sigtermExitCode = Number(exitCodeText);

    return { ...assertions, startToReadyMs };
  } finally {
    if (started) runEngine(['rm', '--volumes', '--force', name], { allowFailure: true });
  }
}

const imageInfo = parseImageInfo();
const runs = [];
for (let index = 1; index <= sampleCount; index += 1) {
  runs.push(await executeContainer(index, index === sampleCount));
}
const startupTimes = runs.map((run) => run.startToReadyMs);
const startup = {
  sampleCount,
  unit: 'ms',
  percentileMethod: 'nearest-rank; p95 at n=5 equals the maximum observation',
  samples: startupTimes,
  p50: percentile(startupTimes, 0.50),
  p95: percentile(startupTimes, 0.95),
};

const engineVersion = runEngine(['version', '--format', '{{.Version}}']).stdout.trim();
const result = {
  schemaVersion: 1,
  sourceSha,
  runtimeReferenceSha: 'a1587e784788fa87d86c0eb7ab175d7a28a3209f',
  profile,
  engine: {
    name: 'Podman',
    version: engineVersion,
    rootless: true,
    graphroot: '/data/scriptorium-c64-oci/storage',
    runroot: '/data/scriptorium-c64-oci/runroot',
    tmpdir: '/data/scriptorium-c64-oci/tmp',
    cgroupManager: 'cgroupfs',
  },
  image: imageInfo,
  startToReady: startup,
  idleResourceSample: runs.at(-1).idle,
  runs,
  assertions: {
    profileAssetsAndMetadata: runs.every((run) => run.assets === 'PASS'),
    uid1000: runs.every((run) => run.uid === 1000),
    dataWritable: runs.every((run) => run.dataWritable),
    historyWritable: runs.every((run) => run.historyWritable),
    gracefulSigtermDrain: runs.every((run) => run.sigtermDrain === 'PASS'),
  },
  measurement: {
    readinessPath: '/api/ready',
    startTimingBoundary: 'Podman run command start through first 200 {ok:true} readiness response',
    idleWarmupMs,
    idleWindowMs,
  },
};

assert.ok(Object.values(result.assertions).every(Boolean), 'all C62 assertions passed');
assert.ok(result.idleResourceSample, 'fixed idle RSS/CPU sample was recorded');
await mkdir(path.dirname(path.resolve(outputPath)), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
console.log(JSON.stringify({ profile, image: imageInfo, startToReady: startup, idleResourceSample: result.idleResourceSample, assertions: result.assertions }, null, 2));
