import { readFile, writeFile, access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(import.meta.dirname, '..');
const lanes = ['narrative', 'knowledge-research', 'diagnostics-speaker', 'semantic', 'publishing', 'paired-writing'];
const statuses = new Set(['IMPLEMENTED', 'PARTIAL', 'MISSING', 'UNVERIFIED', 'FROZEN']);
const text = value => typeof value === 'string' && value.trim().length > 0;

/** Require one attributable assessment for every canonical feature, without conflating it with acceptance. */
export function validateFeatureAudits(audits, requirements) {
  const expected = new Map(requirements.map(row => [row.feature_id, row]));
  const seen = new Set();
  const errors = [];
  const features = [];
  for (const audit of audits) {
    if (audit.schema !== 'proprium.authoring.feature-audit/v1') errors.push('Invalid feature audit schema');
    if (!/^[a-f0-9]{40}$/u.test(audit.base_sha ?? '')) errors.push('Audit requires full base_sha');
    if (!Array.isArray(audit.features)) { errors.push('Audit requires features array'); continue; }
    for (const row of audit.features) {
      const id = row.feature_id;
      const requirement = expected.get(id);
      if (!requirement) errors.push(`${id}: not a canonical feature`);
      else if (row.plugin_id !== requirement.plugin_id) errors.push(`${id}: incorrect plugin owner`);
      if (seen.has(id)) errors.push(`${id}: duplicate assessment`);
      seen.add(id);
      if (!statuses.has(row.status)) errors.push(`${id}: invalid implementation status`);
      for (const key of ['requirement', 'host_path', 'ui_path']) if (!text(row[key])) errors.push(`${id}: requires ${key}`);
      for (const key of ['implementation_files', 'existing_tests', 'gaps', 'required_fixes', 'dependencies', 'verification']) {
        if (!Array.isArray(row[key])) errors.push(`${id}: requires ${key} array`);
      }
      if (!(text(row.priority) || Number.isInteger(row.priority))) errors.push(`${id}: requires priority`);
      if (row.status === 'IMPLEMENTED' && (!row.implementation_files?.length || !row.verification?.length)) {
        errors.push(`${id}: IMPLEMENTED requires implementation and behavior verification`);
      }
      if (['PARTIAL', 'MISSING', 'UNVERIFIED'].includes(row.status) && (!row.gaps?.length || !row.required_fixes?.length)) {
        errors.push(`${id}: unfinished feature requires gaps and remaining work`);
      }
      if (row.status === 'FROZEN' && requirement?.plugin_id !== 'proprium.paired-writing' && id !== 'NAR-10') {
        errors.push(`${id}: shared or active feature cannot be frozen`);
      }
      if (requirement?.plugin_id === 'proprium.paired-writing' && row.status !== 'FROZEN') errors.push(`${id}: Paired Writing must be FROZEN`);
      features.push({ ...row, audit_base_sha: audit.base_sha });
    }
  }
  for (const id of expected.keys()) if (!seen.has(id)) errors.push(`${id}: missing assessment`);
  return { errors, features: features.sort((a, b) => a.feature_id.localeCompare(b.feature_id)) };
}

async function run() {
  const ledger = JSON.parse(await readFile(resolve(root, 'evidence/authoring/implementation.json'), 'utf8'));
  const requirements = [];
  for (const plugin of ledger.plugins) {
    const document = await readFile(resolve(root, plugin.canon), 'utf8');
    for (const match of document.matchAll(/^\|\s*([A-Z]+-\d{2,3})\b[^\n]*<a id="feature-[^"]+"><\/a>/gmu)) {
      requirements.push({ feature_id: match[1], plugin_id: plugin.plugin_id });
    }
  }
  if (!requirements.length || requirements.length !== ledger.plugins.reduce((sum, plugin) => sum + plugin.features.length, 0)) {
    throw new Error('Canonical feature count differs from implementation ledger; update canonical evidence first');
  }
  const audits = await Promise.all(lanes.map(async lane => JSON.parse(await readFile(resolve(root, `evidence/authoring/audit-${lane}.json`), 'utf8'))));
  const result = validateFeatureAudits(audits, requirements);
  for (const row of result.features) for (const path of row.implementation_files ?? []) {
    if (!text(path) || path.startsWith('/') || path.split('/').includes('..')) { result.errors.push(`${row.feature_id}: invalid source path ${path}`); continue; }
    try { await access(resolve(root, path)); } catch { result.errors.push(`${row.feature_id}: missing implementation file ${path}`); }
  }
  if (result.errors.length) throw new Error(result.errors.join('\n'));
  const counts = Object.fromEntries([...statuses].map(status => [status, result.features.filter(row => row.status === status).length]));
  const report = { schema: 'proprium.authoring.feature-status/v1',
    note: 'Implementation assessment is separate from PASS/FAIL acceptance. Verification is limited to the recorded commands and source revisions; historical evidence is not current-source certification.',
    counts, features: result.features };
  const output = resolve(root, 'evidence/authoring/feature-status.json');
  if (process.argv.includes('--check')) {
    if (JSON.stringify(JSON.parse(await readFile(output, 'utf8'))) !== JSON.stringify(report)) throw new Error('Consolidated feature status is stale; regenerate');
  } else {
    await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
    const unfinished = result.features.filter(row => ['MISSING', 'PARTIAL', 'UNVERIFIED'].includes(row.status));
    const lines = ['# Remaining authoring work', '', report.note, '', '| Feature | Plugin | Status | Priority | Required work | Dependencies |', '| --- | --- | --- | --- | --- | --- |'];
    const cell = value => String(value).replaceAll('|', '\\|').replaceAll('\n', ' ');
    for (const row of unfinished) lines.push(`| ${[row.feature_id, row.plugin_id, row.status, row.priority, row.required_fixes.join('; '), row.dependencies.join('; ')].map(cell).join(' | ')} |`);
    await writeFile(resolve(root, 'evidence/authoring/remaining-work.md'), `${lines.join('\n')}\n`);
  }
  console.log(`Validated ${result.features.length} canonical feature assessments: ${JSON.stringify(counts)}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await run();
