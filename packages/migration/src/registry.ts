import type { MigrationProducer, MigrationProducerRegistryLike } from "./types.js";
import { createFilesystemProducer } from "./producers/filesystem.js";
import { createSqliteProducer } from "./producers/sqlite.js";
import { createWorkspaceProducer } from "./producers/workspace.js";
import { createPendingGitProducer } from "./producers/git.js";

export class MigrationProducerRegistry implements MigrationProducerRegistryLike {
  private readonly registered = new Map<string, MigrationProducer>();

  register(producer: MigrationProducer): void {
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(producer.id)) {
      throw new Error(`Invalid migration producer ID: ${producer.id}`);
    }
    if (this.registered.has(producer.id)) {
      throw new Error(`Migration producer already registered: ${producer.id}`);
    }
    this.registered.set(producer.id, producer);
  }

  list(): readonly MigrationProducer[] {
    return [...this.registered.values()];
  }
}

/** Build the generic legacy registry; module owners add their producers at composition time. */
export function createMigrationProducerRegistry(): MigrationProducerRegistry {
  const registry = new MigrationProducerRegistry();
  registry.register(createFilesystemProducer());
  registry.register(createSqliteProducer());
  registry.register(createWorkspaceProducer());
  registry.register(createPendingGitProducer());
  return registry;
}

export function registerMigrationProducer(
  registry: MigrationProducerRegistry,
  producer: MigrationProducer,
): void {
  registry.register(producer);
}
