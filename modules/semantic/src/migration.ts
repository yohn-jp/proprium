import type { MigrationContribution, MigrationProducer } from "@scriptorium/migration";
import { stableMigrationId } from "@scriptorium/migration";

const SOURCE_PATH = "meta/contradiction-dismissals.jsonl";
const LEGACY_PATH = "meta/scriptorium/modules/semantic/legacy/files/meta/contradiction-dismissals.jsonl";
const TARGET_PATH = "meta/scriptorium/modules/semantic/contradiction-dismissals.jsonl";

function emptyContribution(): MigrationContribution { return { entries: [], operations: [], recovery: [] }; }

/** Restore source author dismissals byte-for-byte when a module is reactivated. */
export function createSemanticMigrationProducer(): MigrationProducer {
  return {
    id: "semantic-reactivation-v1",
    moduleId: "semantic",
    async inspect(context) {
      if (!context.enabledModules.has("semantic")) return emptyContribution();
      if (await context.source.readProjectFile(SOURCE_PATH)) return emptyContribution();
      const legacy = await context.target.read(LEGACY_PATH);
      if (!legacy) return emptyContribution();
      const contribution = emptyContribution();
      const existing = await context.target.read(TARGET_PATH);
      if (existing) {
        contribution.entries.push({
          producerId: "semantic-reactivation-v1", source: LEGACY_PATH, target: TARGET_PATH,
          category: "authoritative", disposition: existing.content === legacy.content ? "unchanged" : "conflict",
          detail: existing.content === legacy.content
            ? "Semantic dismissal decisions already match the preserved legacy file."
            : "Canonical semantic dismissal decisions differ from the preserved legacy file; neither version was overwritten.",
        });
        return contribution;
      }
      contribution.entries.push({
        producerId: "semantic-reactivation-v1", source: LEGACY_PATH, target: TARGET_PATH,
        category: "authoritative", disposition: "planned",
        detail: "Restore preserved semantic author dismissal decisions byte-for-byte after the module is enabled.",
      });
      contribution.operations.push({
        id: stableMigrationId(`${context.repository.repositoryId}\0semantic-reactivation-v1\0${LEGACY_PATH}\0${legacy.content}`),
        generation: 0,
        repository: context.repository,
        baseRemoteCommit: context.snapshot.remoteCommit,
        effect: "migration",
        reads: [{ path: TARGET_PATH, revision: null }],
        writes: [{ path: TARGET_PATH, revision: null, content: legacy.content }],
        message: "Restore preserved semantic dismissal decisions",
      });
      return contribution;
    },
  };
}
