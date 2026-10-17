import { lstat, readFile, readdir, realpath, rm } from 'node:fs/promises';
import path from 'node:path';

/**
 * Resolve a dependency exactly as Node does from an installed package: walk
 * package ancestors and follow pnpm's package-local links.
 */
export async function resolveDependency(directory, name) {
  let current = directory;
  while (true) {
    const candidate = path.join(current, 'node_modules', name);
    const resolved = await realpath(candidate).catch(() => null);
    if (resolved) return resolved;
    const parent = path.dirname(current);
    if (parent === current) throw new Error(`missing runtime dependency ${name} from ${directory}`);
    current = parent;
  }
}

/** Returns actual package roots reachable through production dependencies. */
export async function productionClosure(roots) {
  const closure = new Map();
  const visited = new Set();
  async function visit(directory) {
    const resolved = await realpath(directory);
    if (visited.has(resolved)) return;
    visited.add(resolved);
    const manifest = JSON.parse(await readFile(path.join(resolved, 'package.json'), 'utf8'));
    if (typeof manifest.name !== 'string' || typeof manifest.version !== 'string') {
      throw new Error(`invalid runtime package manifest: ${resolved}`);
    }
    closure.set(resolved, { name: manifest.name, version: manifest.version, directory: resolved, manifest });
    for (const dependency of Object.keys(manifest.dependencies ?? {})) {
      await visit(await resolveDependency(resolved, dependency));
    }
    for (const dependency of Object.keys(manifest.peerDependencies ?? {})) {
      const optional = manifest.peerDependenciesMeta?.[dependency]?.optional === true;
      const location = await resolveDependency(resolved, dependency).catch((error) => {
        if (!optional) throw error;
        return null;
      });
      if (location) await visit(location);
    }
    for (const dependency of Object.keys(manifest.optionalDependencies ?? {})) {
      const location = await resolveDependency(resolved, dependency).catch(() => null);
      if (location) await visit(location);
    }
  }
  for (const root of roots) await visit(root);
  return closure;
}

/** Lists package directories directly installed in pnpm's virtual store. */
export async function listPnpmPackageRoots(nodeModulesDirectory) {
  const virtualStore = path.join(nodeModulesDirectory, '.pnpm');
  const storeStat = await lstat(virtualStore).catch(() => undefined);
  if (!storeStat?.isDirectory() || storeStat.isSymbolicLink()) {
    throw new Error(`pnpm virtual store not found: ${virtualStore}`);
  }
  const result = [];
  for (const entry of await readdir(virtualStore, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const storeDirectory = path.join(virtualStore, entry.name);
    const packageNodeModules = path.join(storeDirectory, 'node_modules');
    const moduleStat = await lstat(packageNodeModules).catch(() => undefined);
    if (!moduleStat?.isDirectory() || moduleStat.isSymbolicLink()) continue;
    for (const packageDirectory of await packageDirectories(packageNodeModules)) {
      const manifestPath = path.join(packageDirectory, 'package.json');
      const manifestStat = await lstat(manifestPath).catch(() => undefined);
      if (!manifestStat?.isFile() || manifestStat.isSymbolicLink()) continue;
      const resolved = await realpath(packageDirectory);
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
      if (typeof manifest.name !== 'string' || typeof manifest.version !== 'string') continue;
      result.push({
        name: manifest.name,
        version: manifest.version,
        directory: resolved,
        storeDirectory,
      });
    }
  }
  return result;
}

/**
 * Remove every unreferenced package from a pnpm deploy tree and its links.
 * The graph is calculated before pruning, from the actual selected runtime roots.
 */
export async function pruneToProductionClosure(nodeModulesDirectory, closure) {
  const keep = new Set(closure.keys());
  const packageRoots = await listPnpmPackageRoots(nodeModulesDirectory);
  const storePackages = new Map();
  for (const item of packageRoots) {
    const items = storePackages.get(item.storeDirectory) ?? [];
    items.push(item);
    storePackages.set(item.storeDirectory, items);
  }

  for (const [storeDirectory, packages] of storePackages) {
    for (const item of packages) {
      if (!keep.has(item.directory)) await rm(item.directory, { recursive: true, force: true });
    }
    if (!packages.some(({ directory }) => keep.has(directory))) {
      await rm(storeDirectory, { recursive: true, force: true });
    }
  }

  const allNodeModules = new Set([path.resolve(nodeModulesDirectory)]);
  for (const directory of keep) {
    const nested = path.join(directory, 'node_modules');
    const info = await lstat(nested).catch(() => undefined);
    if (info?.isDirectory() && !info.isSymbolicLink()) allNodeModules.add(nested);
  }
  const pnpmIndex = path.join(nodeModulesDirectory, '.pnpm', 'node_modules');
  const pnpmIndexStat = await lstat(pnpmIndex).catch(() => undefined);
  if (pnpmIndexStat?.isDirectory() && !pnpmIndexStat.isSymbolicLink()) allNodeModules.add(pnpmIndex);

  for (const directory of allNodeModules) await removeUnreachableLinks(directory, keep);

  const remaining = await listPnpmPackageRoots(nodeModulesDirectory);
  const unexpected = remaining.filter(({ directory }) => !keep.has(directory));
  const missing = [...keep].filter((directory) => !remaining.some((entry) => entry.directory === directory));
  if (unexpected.length || missing.length) {
    throw new Error(`runtime package pruning did not match the production closure (unexpected ${unexpected.length}, missing ${missing.length})`);
  }
  return closure;
}

async function packageDirectories(nodeModulesDirectory) {
  const result = [];
  for (const entry of await readdir(nodeModulesDirectory, { withFileTypes: true }).catch(() => [])) {
    if (entry.isSymbolicLink()) continue;
    const entryPath = path.join(nodeModulesDirectory, entry.name);
    if (entry.name.startsWith('@') && entry.isDirectory()) {
      for (const child of await readdir(entryPath, { withFileTypes: true })) {
        if (child.isDirectory() && !child.isSymbolicLink()) result.push(path.join(entryPath, child.name));
      }
    } else if (entry.isDirectory()) {
      result.push(entryPath);
    }
  }
  return result;
}

async function removeUnreachableLinks(nodeModulesDirectory, keep) {
  for (const entry of await readdir(nodeModulesDirectory, { withFileTypes: true }).catch(() => [])) {
    const itemPath = path.join(nodeModulesDirectory, entry.name);
    if (entry.isSymbolicLink()) {
      const target = await realpath(itemPath).catch(() => null);
      if (!target || !isPackagePathRetained(target, keep)) await rm(itemPath, { force: true });
      continue;
    }
    if (!entry.isDirectory()) continue;
    if (entry.name === '.pnpm') {
      await removeVirtualStoreLinks(itemPath, keep);
    } else if (entry.name.startsWith('@')) {
      for (const child of await readdir(itemPath, { withFileTypes: true }).catch(() => [])) {
        const childPath = path.join(itemPath, child.name);
        if (child.isSymbolicLink()) {
          const target = await realpath(childPath).catch(() => null);
          if (!target || !isPackagePathRetained(target, keep)) await rm(childPath, { force: true });
        } else if (child.isDirectory()) {
          await removeNestedPackageLinks(childPath, keep);
        }
      }
    } else if (entry.name === '.bin') {
      for (const child of await readdir(itemPath, { withFileTypes: true }).catch(() => [])) {
        if (!child.isSymbolicLink()) continue;
        const childPath = path.join(itemPath, child.name);
        const target = await realpath(childPath).catch(() => null);
        if (!target || !isPackagePathRetained(target, keep)) await rm(childPath, { force: true });
      }
    } else {
      await removeNestedPackageLinks(itemPath, keep);
    }
  }
}

async function removeVirtualStoreLinks(virtualStore, keep) {
  for (const entry of await readdir(virtualStore, { withFileTypes: true }).catch(() => [])) {
    if (entry.name === 'node_modules' && entry.isDirectory()) {
      await removeUnreachableLinks(path.join(virtualStore, entry.name), keep);
      continue;
    }
    if (!entry.isDirectory()) continue;
    const storeNodeModules = path.join(virtualStore, entry.name, 'node_modules');
    for (const packageDirectory of await packageDirectories(storeNodeModules)) {
      const packageRoot = await realpath(packageDirectory).catch(() => null);
      if (!packageRoot || !keep.has(packageRoot)) continue;
      const nested = path.join(packageRoot, 'node_modules');
      const info = await lstat(nested).catch(() => undefined);
      if (info?.isDirectory() && !info.isSymbolicLink()) await removeUnreachableLinks(nested, keep);
    }
  }
}

async function removeNestedPackageLinks(packageDirectory, keep) {
  const nested = path.join(packageDirectory, 'node_modules');
  const info = await lstat(nested).catch(() => undefined);
  if (info?.isDirectory() && !info.isSymbolicLink()) await removeUnreachableLinks(nested, keep);
}

function isPackagePathRetained(target, keep) {
  let current = target;
  while (true) {
    if (keep.has(current)) return true;
    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}
