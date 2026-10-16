import { assertChangeOperation, snapshotKey } from "@scriptorium/contracts";
import type { ChangeOperation, ModuleId } from "@scriptorium/contracts";
import { createLegacySourceReader } from "./source.js";
import { createMigrationProducerRegistry } from "./registry.js";
import { stableMigrationId } from "./operations.js";
import type {
  InspectLegacyOptions,
  MigrationContext,
  MigrationContribution,
  MigrationEntry,
  MigrationInspection,
  MigrationProposalCoordinator,
} from "./types.js";

export * from "./types.js";
export { createLegacySourceReader } from "./source.js";
export { isSecretLegacyPath } from "./classification.js";
export { MigrationProducerRegistry, createMigrationProducerRegistry, registerMigrationProducer } from "./registry.js";
export { decodeLegacyBytes, planExactFileImport, planGeneratedFileImport, recoveryRecord, stableMigrationId } from "./operations.js";
export { createFilesystemProducer } from "./producers/filesystem.js";
export { createSqliteProducer } from "./producers/sqlite.js";
export { createWorkspaceProducer } from "./producers/workspace.js";
export { createPendingGitProducer } from "./producers/git.js";

const MODULE_IDS: readonly ModuleId[] = [
  "story",
  "diagnostics",
  "nlp",
  "semantic",
  "speaker",
  "assistant",
  "publishing",
  "mcp",
];

function emptyContribution(): MigrationContribution {
  return { entries: [], operations: [], recovery: [] };
}

function compareText(a: string, b: string): number {
  return a.localeCompare(b);
}

/**
 * Inspect only the explicitly supplied legacy roots and return a deterministic,
 * read-only migration report. No filesystem or Git writes are performed.
 */
export async function inspectLegacyProject(options: InspectLegacyOptions): Promise<MigrationInspection> {
  const source = createLegacySourceReader(options.sourceRoot, options.workspaceDataRoot);
  const target = options.target;
  const context: MigrationContext = {
    source,
    target,
    repository: target.snapshot.repository,
    snapshot: target.snapshot,
    enabledModules: new Set(options.enabledModules ?? MODULE_IDS),
    ...(options.legacyRepositoryMappings
      ? {
          legacyRepositoryMappings: Object.fromEntries(
            Object.entries(options.legacyRepositoryMappings).map(([legacyId, repository]) => [legacyId, { ...repository }]),
          ),
        }
      : {}),
    ...(options.workspaceProjectId ? { workspaceProjectId: options.workspaceProjectId } : {}),
  };
  const registry = options.registry ?? createMigrationProducerRegistry();
  const producers = [...registry.list()].sort((a, b) => compareText(a.id, b.id));
  const contributions = await Promise.all(producers.map(async (producer): Promise<MigrationContribution> => {
    try {
      return await producer.inspect(context);
    } catch (error) {
      return {
        ...emptyContribution(),
        entries: [{
          producerId: producer.id,
          source: options.sourceRoot,
          category: "relocated",
          disposition: "blocked",
          detail: `Producer inspection failed without changing the source: ${error instanceof Error ? error.message : String(error)}`,
        }],
      };
    }
  }));

  const entries: MigrationEntry[] = contributions.flatMap((item) => item.entries);
  const operations: ChangeOperation[] = [];
  const duplicatePaths = new Map<string, ChangeOperation[]>();
  for (const operation of contributions.flatMap((item) => item.operations)) {
    assertChangeOperation(operation);
    for (const write of operation.writes) {
      const owners = duplicatePaths.get(write.path) ?? [];
      owners.push(operation);
      duplicatePaths.set(write.path, owners);
    }
    operations.push(operation);
  }
  const conflicts = new Set([...duplicatePaths].filter(([, owners]) => owners.length > 1).map(([path]) => path));
  if (conflicts.size > 0) {
    for (const path of [...conflicts].sort(compareText)) {
      entries.push({
        producerId: "registry",
        source: path,
        target: path,
        category: "relocated",
        disposition: "blocked",
        detail: "More than one registered producer plans a write to this target; all conflicting operations were withheld.",
      });
    }
  }
  const safeOperations = operations.filter((operation) => !operation.writes.some((write) => conflicts.has(write.path)));
  const recovery = contributions.flatMap((item) => item.recovery);
  const pendingWorkspace = await source.inspectGit();

  entries.sort((a, b) => compareText(a.producerId, b.producerId)
    || compareText(a.source, b.source)
    || compareText(a.disposition, b.disposition));
  safeOperations.sort((a, b) => compareText(a.id, b.id));
  recovery.sort((a, b) => compareText(a.id, b.id));
  return {
    snapshot: target.snapshot,
    entries,
    operations: safeOperations,
    recovery,
    pendingWorkspace,
  };
}

/**
 * Submit the dry-run operations to Core as a proposal. Approval and checkpoint
 * remain separate authenticated author actions owned by MutationCoordinator.
 */
export async function proposeMigrationImport(
  coordinator: MigrationProposalCoordinator,
  projectId: string,
  inspection: MigrationInspection,
) {
  if (inspection.operations.length === 0) throw new Error("Migration inspection has no planned operations to propose");
  for (const operation of inspection.operations) assertChangeOperation(operation);
  const ids = inspection.operations.map(({ id }) => id).sort(compareText);
  const proposal = {
    id: stableMigrationId(`migration-proposal\0${snapshotKey(inspection.snapshot)}\0${ids.join("\0")}`),
    snapshot: inspection.snapshot,
    operations: inspection.operations,
    source: "author" as const,
  };
  return coordinator.propose(projectId, proposal);
}
