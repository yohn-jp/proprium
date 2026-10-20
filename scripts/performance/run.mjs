import { spawn, execFileSync } from 'node:child_process';
import { readFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import os from 'node:os';
import { generate, sizes } from './dataset.mjs';
import { save } from './common.mjs';

// A live child handle is authoritative. A timeout terminates the whole local worker
// process group (including Git/browser descendants); completed samples survive.
export async function runWorker(script, args, output, timeoutMs, env = {}) {
  const child = spawn(process.execPath, [script, ...args], { detached: true,
    env: { ...process.env, ...env }, stdio: ['ignore', 'ignore', 'inherit'] });
  let timeout = false;
  const timer = setTimeout(() => { timeout = true; try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }, timeoutMs);
  const terminal = await new Promise((resolveExit, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolveExit({ code, signal })); });
  clearTimeout(timer);
  let report;
  try { report = JSON.parse(await readFile(output, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; report = { samples: [] }; }
  report.execution = { ...terminal, timeout, timeoutMs };
  if (timeout || terminal.code !== 0) {
    report.status = 'NOT_CHECKED';
    report.reason = timeout ? 'Worker budget exhausted; completed samples retained, remaining operations unmeasured.' : 'Worker failed; see error and exit status.';
  }
  await save(output, report);
  return report;
}
async function main() {
  const root = resolve(process.argv[2] ?? '/tmp/scriptorium-wave0-run');
  const repeats = Number(process.env.BENCH_REPEATS ?? 20), timeoutMs = Number(process.env.BENCH_TIMEOUT_MS ?? 180000);
  if (!Number.isInteger(repeats) || repeats < 1 || !Number.isFinite(timeoutMs) || timeoutMs < 1000) throw new Error('Invalid repeat count or timeout');
  await mkdir(root); // fresh run only; never silently reuse mutated fixtures/results
  const results = join(root, 'results'); await mkdir(results);
  const command = (...args) => execFileSync(args[0], args.slice(1), { encoding: 'utf8' }).trim();
  const environment = { timestamp: new Date().toISOString(), source: command('git', 'rev-parse', 'HEAD'),
    sourceStatus: command('git', 'status', '--short'), node: process.version, pnpm: command('pnpm', '--version'),
    git: command('git', '--version'), os: { platform: os.platform(), release: os.release(), arch: os.arch() },
    cpus: os.cpus(), totalMemoryBytes: os.totalmem(), freeMemoryBytes: os.freemem(),
    loadAverage: os.loadavg(), profile: 'core', repeats, timeoutMs,
    chromiumExecutable: process.env.SCRIPTORIUM_E2E_CHROMIUM ?? 'Playwright default',
    instrumentation: 'opt-in process wrappers, proc IO, browser DevTools commit hook, IDB wrappers, Long Tasks, CDP CPU sampling; no production edits' };
  await save(join(results, 'environment.json'), environment);
  const selected = (process.env.BENCH_SIZES ?? Object.keys(sizes).join(',')).split(',');
  for (const size of selected) {
    console.log(`Generating ${size}`);
    const datasetPath = join(root, size);
    const manifest = await generate(datasetPath, size);
    await save(join(results, `dataset-${size}.json`), manifest);
    for (const workload of ['read', 'mutation', 'revisions', 'search', 'stats', 'browser']) {
      console.log(`Measuring ${size}/${workload}`);
      const output = join(results, `${workload}-${size}.json`);
      const script = workload === 'browser' ? 'scripts/performance/browser.mjs' : 'scripts/performance/core.mjs';
      const args = workload === 'browser'
        ? [datasetPath, output, String(repeats), process.env.BENCH_IDLE_MS ?? '35000']
        : [datasetPath, output, String(repeats), workload];
      const report = await runWorker(script, args, output, timeoutMs,
        { SCRIPTORIUM_PROFILE: 'core', GIT_TRACE2_EVENT: join(results, `${workload}-${size}.git-trace.jsonl`) });
      console.log(`${size}/${workload}: ${report.status}`);
    }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
