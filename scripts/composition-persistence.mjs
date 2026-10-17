/** Shared pure declaration builder; consumed by the Build Kit and its trusted consumer bundle. */
const baseReadablePersistence = [
  { formatId: 'scriptorium.browser-recovery-indexeddb', version: 3 },
  { formatId: 'scriptorium.git-operations', version: 1 },
  { formatId: 'scriptorium.git-proposal-binding', version: 2 },
  { formatId: 'scriptorium.git-proposal-complete', version: 2 },
  { formatId: 'scriptorium.git-proposal-legacy', version: 1 },
  { formatId: 'scriptorium.git-publications', version: 1 },
];

const baseWritablePersistence = [
  { formatId: 'scriptorium.browser-recovery-indexeddb', version: 3 },
  { formatId: 'scriptorium.git-operations', version: 1 },
  { formatId: 'scriptorium.git-proposal-binding', version: 2 },
  { formatId: 'scriptorium.git-proposal-complete', version: 2 },
  { formatId: 'scriptorium.git-publications', version: 1 },
];

export function persistenceForModules(selectedModuleIds, moduleFormats) {
  const selected = new Set(selectedModuleIds);
  if (selected.size !== selectedModuleIds.length) throw new Error('Selected module IDs must be unique for persistence declarations');
  const readable = new Map(baseReadablePersistence.map(({ formatId, version }) => [formatId, new Set([version])]));
  const writable = new Map(baseWritablePersistence.map(({ formatId, version }) => [formatId, new Set([version])]));
  for (const descriptor of moduleFormats) {
    if (!selected.has(descriptor.moduleId)) continue;
    if (!Number.isSafeInteger(descriptor.version) || descriptor.version < 1 ||
        typeof descriptor.formatId !== 'string' || descriptor.formatId.length === 0 ||
        typeof descriptor.readable !== 'boolean' || typeof descriptor.writable !== 'boolean') {
      throw new Error(`Invalid persistence descriptor for selected module ${descriptor.moduleId}`);
    }
    if (descriptor.readable) {
      const versions = readable.get(descriptor.formatId) ?? new Set();
      versions.add(descriptor.version);
      readable.set(descriptor.formatId, versions);
    }
    if (descriptor.writable) {
      const versions = writable.get(descriptor.formatId) ?? new Set();
      versions.add(descriptor.version);
      writable.set(descriptor.formatId, versions);
    }
  }
  const readableDeclarations = [...readable]
    .map(([formatId, versions]) => ({ formatId, versions: [...versions].sort((left, right) => left - right) }))
    .sort((left, right) => left.formatId < right.formatId ? -1 : left.formatId > right.formatId ? 1 : 0);
  const writableDeclarations = [...writable]
    .flatMap(([formatId, versions]) => [...versions].map((version) => ({ formatId, version })))
    .sort((left, right) => left.formatId < right.formatId ? -1 : left.formatId > right.formatId ? 1 : left.version - right.version);
  return { contractVersion: 'scriptorium-persistence/v1', readable: readableDeclarations, writable: writableDeclarations };
}

