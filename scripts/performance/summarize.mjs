import { readFile, readdir, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { distribution, save } from './common.mjs';
const sum = values => values.reduce((a, b) => a + b, 0);
export function summarizeCore(report) {
  return { status: report.status, execution: report.execution, pending: report.pending, error: report.error,
    operations: Object.fromEntries([...new Set(report.samples.map(s => s.name))].map(name => {
      const rows = report.samples.filter(s => s.name === name);
      return [name, { ms: distribution(rows.map(s => s.ms)),
        nodeCpuMs: distribution(rows.map(s => (s.cpuUs.user + s.cpuUs.system) / 1000)),
        rssMaxBytes: Math.max(...rows.map(s => s.rssBytes)),
        processPeakRssKiB: Math.max(...rows.map(s => s.maxRssKiB)),
        gitProcesses: distribution(rows.map(s => s.counters.gitProcesses)),
        readFileCalls: distribution(rows.map(s => s.counters.readFileCalls)),
        io: Object.fromEntries(['rchar', 'wchar', 'syscr', 'syscw', 'read_bytes', 'write_bytes'].map(k =>
          [k, distribution(rows.filter(s => s.io).map(s => s.io[k]))])) }];
    })) };
}
export function summarizeBrowser(report) {
  const phases = report.phases ?? [], metrics = report.browserMetrics ?? phases.at(-1)?.browser;
  const inputs = phases.filter(p => p.name.startsWith('input.')).map(phase => {
    const inPhase = row => row.start >= phase.start && row.start <= phase.end;
    const data = phase.browser;
    const transactions = data.transactions.filter(inPhase);
    const reads = data.reads.filter(inPhase);
    return { name: phase.name, storageEstimate: phase.storageEstimate,
      typingFrameMs: distribution(data.inputs.filter(row => inPhase(row) && row.type === 'keydown' && row.key === 'a').map(row => row.frameMs).filter(Number.isFinite)),
      arrowFrameMs: distribution(data.inputs.filter(row => inPhase(row) && row.type === 'keydown' && row.key === 'ArrowLeft').map(row => row.frameMs).filter(Number.isFinite)),
      beforeInputFrameMs: distribution(data.inputs.filter(row => inPhase(row) && row.type === 'beforeinput').map(row => row.frameMs).filter(Number.isFinite)),
      reactCommits: data.reactCommits.filter(row => row.at >= phase.start && row.at <= phase.end).length,
      maxCommittedFibers: Math.max(0, ...data.reactCommits.filter(row => row.at >= phase.start && row.at <= phase.end).map(row => row.fibers)),
      longTasks: distribution(data.longTasks.filter(inPhase).map(row => row.ms)),
      strictWriteMs: distribution(transactions.filter(row => row.mode === 'readwrite' && row.durability === 'strict' && row.status === 'complete').map(row => row.ms)),
      transactions: { total: transactions.length, pending: transactions.filter(row => row.status === 'pending').length, aborted: transactions.filter(row => row.status === 'aborted').length },
      reads: { total: reads.length, getAll: reads.filter(row => row.method === 'getAll').length, returnedRecords: sum(reads.map(row => row.records ?? 0)) } };
  });
  const server = report.server ?? phases.filter(p => p.server).at(-1)?.server;
  const api = server?.requests ?? [];
  const operations = Object.fromEntries([...new Set((report.samples ?? []).map(s => s.name))].map(name => [name, distribution(report.samples.filter(s => s.name === name).map(s => s.ms))]));
  return { status: report.status, error: report.error, execution: report.execution, browser: report.browser,
    startupMs: report.serverStartupMs, operations, inputs,
    totals: metrics ? { reactCommits: metrics.reactCommits.length, longTasks: distribution(metrics.longTasks.map(row => row.ms)),
      idbTransactions: metrics.transactions.length, idbReads: metrics.reads.length,
      idbGetAll: metrics.reads.filter(row => row.method === 'getAll').length } : null,
    storageEstimate: report.storageEstimate, network: report.network,
    browserRuntime: report.browserRuntime, server: server && { counts: server.counts, cpu: server.cpu, memory: server.memory, usage: server.usage, io: server.io },
    requestCount: report.requests?.length,
    api: Object.fromEntries([...new Set(api.map(row => `${row.method} ${row.path}`))].map(key => {
      const rows = api.filter(row => `${row.method} ${row.path}` === key);
      return [key, { ms: distribution(rows.map(row => row.ms)), statusCounts: rows.reduce((counts, row) => { counts[row.status] = (counts[row.status] ?? 0) + 1; return counts; }, {}) }];
    })),
    idle: phases.filter(p => p.name.startsWith('idle.')).map(p => ({ name: p.name, elapsedMs: p.elapsedMs,
      visibility: p.visibility, requests: p.requests,
      nodeCpuMs: (p.after.cpu.user - p.before.cpu.user + p.after.cpu.system - p.before.cpu.system) / 1000,
      gitProcesses: p.after.counts.gitProcesses - p.before.counts.gitProcesses,
      nodeRssBytes: p.after.memory.rss,
      browserCpuSeconds: sum(p.runtimeAfter.map(row => Math.max(0, row.cpuTime - (p.runtimeBefore.find(before => before.id === row.id)?.cpuTime ?? row.cpuTime)))),
      browserRssSumBytes: sum(p.runtimeAfter.map(row => row.rssBytes ?? 0)),
      io: Object.fromEntries(Object.keys(p.after.io ?? {}).map(k => [k, p.after.io[k] - p.before.io[k]])) })),
    notChecked: report.notChecked };
}
async function summarize(directory) {
  const files = await readdir(directory), result = { environment: JSON.parse(await readFile(join(directory, 'environment.json'), 'utf8')), datasets: {}, core: {}, browser: {}, gitTrace: {} };
  for (const file of files.filter(f => f.endsWith('.json') && f !== 'environment.json' && f !== 'summary.json' && !f.startsWith('diagnostic-'))) {
    const report = JSON.parse(await readFile(join(directory, file), 'utf8'));
    if (file.startsWith('dataset-')) result.datasets[report.size] = report;
    else if (file.startsWith('browser-')) result.browser[file] = summarizeBrowser(report);
    else result.core[file] = summarizeCore(report);
  }
  for (const file of files.filter(f => f.endsWith('.git-trace.jsonl'))) {
    const trace = { startEvents: 0, exitEvents: 0, childStartEvents: 0, nonzeroExitEvents: 0 };
    for await (const line of createInterface({ input: createReadStream(join(directory, file)), crlfDelay: Infinity })) {
      let event; try { event = JSON.parse(line); } catch { continue; } // killed worker can leave a final partial line
      if (event.event === 'start') trace.startEvents++;
      if (event.event === 'child_start') trace.childStartEvents++;
      if (event.event === 'exit') { trace.exitEvents++; if (event.code !== 0) trace.nonzeroExitEvents++; }
    }
    result.gitTrace[file] = trace;
  }
  await save(join(directory, 'summary.json'), result);
  const fmt = value => value == null ? 'NOT_CHECKED' : value.toFixed(2);
  const lines = ['| Dataset / operation | Worker status | n | p50 ms | p95 ms | p99 ms | Node CPU p50 ms | RSS max MiB | Git p50 |', '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |'];
  for (const [file, report] of Object.entries(result.core)) for (const [operation, data] of Object.entries(report.operations)) {
    if (operation === 'register') continue;
    lines.push(`| ${file.replace('.json', '')} / ${operation} | ${report.status} | ${data.ms.n} | ${fmt(data.ms.p50)} | ${fmt(data.ms.p95)} | ${fmt(data.ms.p99)} | ${fmt(data.nodeCpuMs.p50)} | ${fmt(data.rssMaxBytes / 1048576)} | ${data.gitProcesses.p50} |`);
  }
  lines.push('', '| Dataset / document | Worker status | typing n | typing p50 / p95 / p99 ms | arrow p95 ms | React commits | Long Tasks n / p95 ms | strict IDB n / p95 ms | getAll calls |', '| --- | --- | ---: | --- | ---: | ---: | --- | --- | ---: |');
  for (const [file, report] of Object.entries(result.browser)) for (const input of report.inputs) {
    const t = input.typingFrameMs;
    lines.push(`| ${file.replace('.json', '')} / ${input.name} | ${report.status} | ${t.n} | ${fmt(t.p50)} / ${fmt(t.p95)} / ${fmt(t.p99)} | ${fmt(input.arrowFrameMs.p95)} | ${input.reactCommits} | ${input.longTasks.n} / ${fmt(input.longTasks.p95)} | ${input.strictWriteMs.n} / ${fmt(input.strictWriteMs.p95)} | ${input.reads.getAll} |`);
  }
  await writeFile(join(directory, 'tables.md'), lines.join('\n') + '\n');
  return result;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await summarize(resolve(process.argv[2]));
