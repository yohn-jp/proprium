import { randomUUID } from 'node:crypto';
import { readFile, writeFile, rename, rm } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';

export function distribution(values) {
  if (!values.length) return { n: 0, p50: null, p95: null, p99: null };
  const sorted = [...values].sort((a, b) => a - b);
  const at = p => sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];
  return { n: sorted.length, p50: at(.5), p95: at(.95), p99: at(.99), max: sorted.at(-1) };
}
export async function io() {
  try {
    return Object.fromEntries((await readFile('/proc/self/io', 'utf8')).trim().split('\n').map(line => {
      const [key, value] = line.split(':'); return [key, Number(value.trim())];
    }));
  } catch { return null; }
}
export async function measure(name, action, counters = () => ({})) {
  const beforeIO = await io(), before = counters(), cpu = process.cpuUsage(), start = performance.now();
  const value = await action();
  const ms = performance.now() - start, cpuUs = process.cpuUsage(cpu), afterIO = await io(), after = counters();
  return { value, sample: { name, ms, cpuUs, rssBytes: process.memoryUsage().rss,
    maxRssKiB: process.resourceUsage().maxRSS,
    io: beforeIO && afterIO ? Object.fromEntries(Object.keys(afterIO).map(k => [k, afterIO[k] - beforeIO[k]])) : null,
    counters: Object.fromEntries(Object.keys(after).map(k => [k, after[k] - (before[k] ?? 0)])) } };
}
export async function save(file, data) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(data, null, 2) + '\n');
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}
