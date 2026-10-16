import type { MigrationContribution, MigrationProducer } from "@scriptorium/migration";
import { stableMigrationId } from "@scriptorium/migration";

const NLP_FILES = [
  { source: "meta/synonyms.yaml", target: "meta/scriptorium/modules/nlp/synonyms.yaml" },
  { source: "meta/candidate-ignore-list.yaml", target: "meta/scriptorium/modules/nlp/candidate-ignore-list.yaml" },
  { source: ".arcadia/nlp-feature-settings.json", target: "meta/scriptorium/modules/nlp/feature-settings.json" },
] as const;

function emptyContribution(): MigrationContribution {
  return { entries: [], operations: [], recovery: [] };
}

/**
 * Rehydrates NLP state that the generic filesystem producer previously kept opaque
 * while NLP was disabled. The ordinary enabled import remains owned by P04.
 */
export function createNlpMigrationProducer(): MigrationProducer {
  return {
    id: "nlp-reactivation-v1",
    moduleId: "nlp",
    async inspect(context) {
      if (!context.enabledModules.has("nlp")) return emptyContribution();
      const contribution = emptyContribution();
      for (const file of NLP_FILES) {
        // If the legacy source is still available, P04's exact-byte producer owns it.
        if (await context.source.readProjectFile(file.source)) continue;
        const legacyPath = `meta/scriptorium/modules/nlp/legacy/files/${file.source}`;
        const legacy = await context.target.read(legacyPath);
        if (!legacy) continue;

        const existing = await context.target.read(file.target);
        if (existing) {
          contribution.entries.push({
            producerId: "nlp-reactivation-v1",
            source: legacyPath,
            target: file.target,
            category: "authoritative",
            disposition: existing.content === legacy.content ? "unchanged" : "conflict",
            detail: existing.content === legacy.content
              ? "NLP state already matches the preserved legacy file."
              : "Canonical NLP state differs from the preserved legacy file; neither version was overwritten.",
          });
          continue;
        }

        contribution.entries.push({
          producerId: "nlp-reactivation-v1",
          source: legacyPath,
          target: file.target,
          category: "authoritative",
          disposition: "planned",
          detail: "Restore preserved NLP author settings byte-for-byte after the module is enabled.",
        });
        contribution.operations.push({
          id: stableMigrationId(`${context.repository.repositoryId}\0nlp-reactivation-v1\0${legacyPath}\0${legacy.content}`),
          generation: 0,
          repository: context.repository,
          baseRemoteCommit: context.snapshot.remoteCommit,
          effect: "migration",
          reads: [{ path: file.target, revision: null }],
          writes: [{ path: file.target, revision: null, content: legacy.content }],
          message: "Restore preserved NLP settings",
        });
      }
      return contribution;
    },
  };
}
