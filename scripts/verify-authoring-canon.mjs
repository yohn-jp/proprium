import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const sourceFlag = args.indexOf('--sources');
const sourceRoot = sourceFlag < 0 ? null : resolve(args[sourceFlag + 1] ?? '');
const errors = [];
const check = (value, message) => { if (!value) errors.push(message); };
const config = JSON.parse(readFileSync(join(root, 'docs/canon/traceability.json'), 'utf8'));
const read = path => readFileSync(join(root, path), 'utf8');
const slug = title => title.toLowerCase().replace(/<[^>]+>/gu, '').replace(/[^\p{L}\p{N}_\-\s]/gu, '').trim().replace(/\s/gu, '-');
function anchors(content) {
  const found = new Set(); const count = new Map();
  for (const match of content.matchAll(/^#{1,6}\s+(.+)$/gmu)) {
    const base = slug(match[1]); const n = count.get(base) ?? 0;
    count.set(base, n + 1); found.add(base + (n ? `-${n}` : ''));
  }
  for (const match of content.matchAll(/\bid=["']([^"']+)["']/gu)) found.add(match[1]);
  return found;
}
const docs = ['CONTRIBUTING.md', 'docs/README.md', 'docs/architecture/WASM-PLUGIN-ABI.md', 'docs/canon/README.md', 'docs/canon/ARCHITECTURE.md', 'docs/canon/HOST-PLUGIN-CONTRACT.md', 'docs/canon/RECOVERY-INVENTORY.md', 'docs/canon/ACCEPTANCE.md', 'docs/canon/plugins/README.md', ...config.plugins.map(p => p.canon)];
const content = new Map(docs.map(path => [path, read(path)]));
const inventory = content.get('docs/canon/RECOVERY-INVENTORY.md');
let featureCount = 0; let linkCount = 0; let sourceLinks = 0; let checkedSourcePaths = 0;
const actionRows = config.source_actions;
const uiRows = config.source_ui_contributions ?? [];
check(uiRows.length > 0, 'Missing UI registration inventory');
check(new Set(uiRows.map(u => u.id)).size === uiRows.length, 'Duplicate legacy UI ID');
for (const ui of uiRows) {
  const owner = config.plugins.find(p => p.id === ui.owner);
  check(!!owner, 'UI owner missing: ' + ui.id);
  check(ui.source.startsWith('modules/' + ui.module + '/'), 'UI source module mismatch: ' + ui.id);
  check(!!ui.slot && !!ui.action && !!ui.title, 'Incomplete UI metadata: ' + ui.id);
  if (owner) {
    const canon = content.get(owner.canon);
    check(canon.includes('<a id="feature-' + ui.feature_id.toLowerCase() + '">'), 'Missing UI target feature: ' + ui.id);
    check(canon.includes('`' + ui.id + '`'), 'Canon missing legacy UI: ' + ui.id);
  }
  check(inventory.includes('`' + ui.id + '`'), 'Inventory missing legacy UI: ' + ui.id);
}
for (const action of actionRows) {
  check(action.owners.length > 0 && action.owners.every(id => config.plugins.some(p => p.id === id)), `Invalid owner for ${action.id}`);
  check(action.owners.length === 1 || !!action.partition, `Missing ownership partition for ${action.id}`);
}
for (const tool of config.source_tools) check(inventory.includes('`' + tool.id + '`'), `Inventory lacks legacy MCP tool ${tool.id}`);
check(new Set(actionRows.map(a => a.id)).size === actionRows.length, 'Duplicate source action ownership record');
for (const plugin of config.plugins) {
  const body = content.get(plugin.canon);
  check(body.includes(plugin.id), `${plugin.canon}: missing immutable ID`);
  const rows = [...body.matchAll(new RegExp(`^\\|\\s*(${plugin.prefix}-[0-9]+)\\b[^\\n]*`, 'gm'))];
  check(rows.length > 0, `${plugin.canon}: empty feature ledger`);
  const features = new Set();
  for (const [row, id] of rows) {
    check(!features.has(id), `${plugin.canon}: duplicate ${id}`); features.add(id); featureCount++;
    const gateColumns = row.slice(row.indexOf('|', 1) + 1);
    const gates = [...gateColumns.matchAll(new RegExp(plugin.acceptance_pattern ?? `${plugin.prefix}-A[0-9]+`, 'g'))].map(x => x[0]);
    check(gates.length > 0, `${plugin.canon}: ${id} has no acceptance`);
    for (const gate of gates) {
      const outside = body.replace(row, '');
      check(outside.includes(gate), `${plugin.canon}: ${id} acceptance ${gate} undefined`);
    }
    check(inventory.includes(`[${id}]`), `Inventory lacks feature ${id}`);
  }
  for (const action of actionRows.filter(a => a.owners.includes(plugin.id))) {
    const target = action.targets?.find(t => t.plugin_id === plugin.id);
    check(!!target && features.has(target.feature_id), `${action.id}: missing ${plugin.id} feature target`);
    check(body.includes(action.id), `${plugin.canon}: source action ${action.id} untraced`);
    check(inventory.includes('`' + action.id + '`'), `Inventory lacks source action ${action.id}`);
  }
  for (const dep of plugin.requires) check(config.plugins.some(p => p.id === dep), `${plugin.id}: unknown dependency ${dep}`);
}
const visiting = new Set(), visited = new Set();
function visit(id) {
  check(!visiting.has(id), `Required dependency cycle at ${id}`);
  if (visiting.has(id) || visited.has(id)) return;
  const plugin = config.plugins.find(p => p.id === id);
  if (!plugin) return;
  visiting.add(id); for (const dep of plugin.requires) visit(dep);
  visiting.delete(id); visited.add(id);
}
config.plugins.forEach(p => visit(p.id));
for (const [path, body] of content) {
  let tableWidth = null;
  for (const line of body.split('\n')) {
    if (!line.startsWith('|')) { tableWidth = null; continue; }
    const width = line.split(/(?<!\\)\|/u).length;
    if (tableWidth === null) tableWidth = width;
    check(width === tableWidth, `${path}: inconsistent Markdown table columns`);
  }
  const explicit = [...body.matchAll(/\bid=["']([^"']+)["']/gu)].map(m => m[1]);
  check(new Set(explicit).size === explicit.length, `${path}: duplicate explicit anchor`);
  for (const match of body.matchAll(/(?<!!)\[[^\]\n]+\]\(([^\s)]+)(?:\s+"[^"]*")?\)/gu)) {
    const href = match[1]; linkCount++;
    if (/^https?:/u.test(href)) {
      const source = href.match(/^https:\/\/github\.com\/yohn-jp\/(scriptorium|arcadia-loom)\/blob\/([0-9a-f]{40})\/(.*)$/u);
      if (source && sourceRoot) {
        try { execFileSync('git', ['cat-file', '-e', `${source[2]}:${decodeURIComponent(source[3].split('#')[0])}`], { cwd: join(sourceRoot, source[1]), stdio: 'pipe' }); sourceLinks++; }
        catch { errors.push(`${path}: missing pinned source ${href}`); }
      }
      continue;
    }
    if (/^[a-z]+:/iu.test(href)) continue;
    const [target, fragment] = href.split('#');
    const file = target ? resolve(root, dirname(path), decodeURIComponent(target)) : join(root, path);
    if (!existsSync(file)) { errors.push(`${path}: broken link ${href}`); continue; }
    if (fragment && file.endsWith('.md')) check(anchors(readFileSync(file, 'utf8')).has(decodeURIComponent(fragment)), `${path}: broken anchor ${href}`);
  }
}
if (sourceRoot) {
  const toolSource = execFileSync('git', ['show', `${config.sources[0].revision}:modules/mcp/src/tools.ts`], { cwd: join(sourceRoot, 'scriptorium'), encoding: 'utf8', stdio: 'pipe' });
  const registeredTools = [...toolSource.matchAll(/server\.tool\(\s*["']([^"']+)["']/gu)].map(x => x[1]);
  check(new Set(config.source_tools.map(t => t.id)).size === config.source_tools.length, 'Duplicate source MCP tool record');
  for (const id of registeredTools) check(config.source_tools.some(t => t.id === id), `Unmapped legacy MCP tool ${id}`);
  for (const tool of config.source_tools) {
    check(registeredTools.includes(tool.id), `Fabricated legacy MCP tool ${tool.id}`);
    check(inventory.includes('`' + tool.id + '`'), `Inventory lacks legacy MCP tool ${tool.id}`);
  }
  const uiSources = [...new Set(uiRows.map(ui => ui.source))];
  for (const path of uiSources) {
    let body;
    try {
      body = execFileSync('git', ['show', config.sources[0].revision + ':' + path], {
        cwd: join(sourceRoot, 'scriptorium'), encoding: 'utf8', stdio: 'pipe',
      });
    } catch { errors.push('Missing original source UI registration: ' + path); continue; }
    const registered = [...body.matchAll(/\{\s*id:\s*["']([^"']+)["']\s*,\s*module:\s*["']([^"']+)["']\s*,\s*slot:\s*["']([^"']+)["']\s*,\s*title:\s*["']([^"']+)["']\s*,\s*action:\s*["']([^"']+)["']/gu)]
      .map(m => ({id:m[1],module:m[2],slot:m[3],title:m[4],action:m[5]}));
    const mapped = uiRows.filter(ui => ui.source === path);
    for (const entry of registered) {
      const target = mapped.find(ui => ui.id === entry.id);
      check(!!target, 'Unmapped original UI contribution: ' + path + ':' + entry.id);
      if (target) for (const field of ['module','slot','title','action']) {
        check(target[field] === entry[field], 'UI registration metadata mismatch: ' + path + ':' + entry.id + '.' + field);
      }
    }
    for (const ui of mapped) check(registered.some(entry => entry.id === ui.id), 'Fabricated UI contribution: ' + path + ':' + ui.id);
  }
  const sourceCache = new Map();
  const sourceTrees = [['scriptorium', config.sources[0].revision], ['arcadia-loom', 'edc033c2c9466274a334299dadfa426661d957d9']].map(([repo, revision]) => {
    try { return new Set(execFileSync('git', ['ls-tree', '-r', '--name-only', revision], { cwd: join(sourceRoot, repo), encoding: 'utf8', stdio: 'pipe' }).trim().split('\n')); }
    catch { errors.push(`Cannot enumerate pinned ${repo} source`); return new Set(); }
  });
  function expand(path) {
    const group = path.match(/\{([^{}]+)\}/u);
    if (!group) return [path];
    return group[1].split(',').flatMap(item => expand(path.replace(group[0], item)));
  }
  for (const [path, body] of content) {
    for (const match of body.matchAll(/(?<![A-Za-z0-9_/-])(?:modules|packages|app|tests|docs)\/[A-Za-z0-9_./{},*-]+/gu)) {
      for (const raw of expand(match[0])) {
        const candidate = raw.replace(/[.,]+$/u, '');
        if (candidate.includes('*') || !/\.(?:ts|tsx|mjs|md|wit)$/u.test(candidate)) continue;
        if (sourceCache.has(candidate)) continue;
        const valid = existsSync(join(root, candidate)) || sourceTrees.some(tree => tree.has(candidate));
        check(valid, `${path}: source path does not exist in Host or either pinned source: ${candidate}`);
        sourceCache.set(candidate, valid);
      }
    }
  }
  checkedSourcePaths = sourceCache.size;
  for (const source of config.sources) {
    let body;
    try { body = execFileSync('git', ['show', `${source.revision}:${source.path}`], { cwd: join(sourceRoot, source.repo), encoding: 'utf8', stdio: 'pipe' }); }
    catch { errors.push(`Unavailable source ${source.repo}@${source.revision}:${source.path}`); continue; }
    // Literal public action registrations; helpers and references are not registrations.
    const expected = [...body.matchAll(/\baction\(\s*["']([\w.-]+)["']\s*,/gu)].map(x => x[1]);
    if (source.repo === 'scriptorium' && source.path.includes('/publishing/')) {
      expected.push(...[...body.matchAll(/defineAction\([^\n]+?["'](publishing\.[\w.-]+)["']\s*,/gu)].map(x => x[1]));
    }
    for (const id of new Set(expected)) check(actionRows.some(a => a.id === id && a.source === source.path), `${source.path}: unregistered source action ${id}`);
    for (const action of actionRows.filter(a => a.source === source.path)) check(expected.includes(action.id), `${source.path}: fabricated source action ${action.id}`);
  }
}
if (errors.length) { process.stderr.write(errors.join('\n') + '\n'); process.exitCode = 1; }
else process.stdout.write(`Authoring canon verified: ${config.plugins.length} plugins, ${featureCount} features, ${actionRows.length} source actions, ${config.source_tools.length} legacy MCP tools, ${uiRows.length} UI contributions, acyclic required dependencies, ${linkCount} links (${sourceLinks} pinned source links checked${sourceRoot ? `; source registrations and ${checkedSourcePaths} source paths checked` : '; external source verification omitted: pass --sources'}).\n`);
