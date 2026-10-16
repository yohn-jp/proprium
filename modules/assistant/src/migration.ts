import type { MigrationContribution, MigrationContext, MigrationProducer } from "@scriptorium/migration";
import { stableMigrationId } from "@scriptorium/migration";

const FILES = [
  {
    source: ".arcadia/llm-model-settings.json",
    legacy: "meta/scriptorium/modules/assistant/legacy/files/.arcadia/llm-model-settings.json",
    target: "meta/scriptorium/modules/assistant/model-settings.json",
    label: "non-secret model settings",
  },
  {
    source: ".arcadia/llm-usage.jsonl",
    legacy: "meta/scriptorium/modules/assistant/legacy/files/.arcadia/llm-usage.jsonl",
    target: "meta/scriptorium/modules/assistant/usage.jsonl",
    label: "historical model usage records",
  },
] as const;

function emptyContribution(): MigrationContribution {
  return { entries: [], operations: [], recovery: [] };
}

/** Restore preserved non-secret model preferences exactly when Assistant is reactivated. */
export function createAssistantMigrationProducer(): MigrationProducer {
  return {
    id: "assistant-reactivation-v1",
    moduleId: "assistant",
    async inspect(context: MigrationContext) {
      if (!context.enabledModules.has("assistant")) return emptyContribution();

      const contribution = emptyContribution();
      for (const file of FILES) {
        // The generic filesystem producer owns an available source file, including
        // the first import or preservation while Assistant is disabled.
        if (await context.source.readProjectFile(file.source)) continue;

        const legacy = await context.target.read(file.legacy);
        if (!legacy) continue;

        const existing = await context.target.read(file.target);
        if (existing) {
          const matches = existing.content === legacy.content;
          contribution.entries.push({
            producerId: "assistant-reactivation-v1",
            source: file.legacy,
            target: file.target,
            category: "authoritative",
            disposition: matches ? "unchanged" : "conflict",
            detail: matches
              ? `Assistant ${file.label} already match the preserved legacy file.`
              : `Canonical Assistant ${file.label} differ from the preserved legacy file; neither version was overwritten.`,
          });
          continue;
        }

        contribution.entries.push({
          producerId: "assistant-reactivation-v1",
          source: file.legacy,
          target: file.target,
          category: "authoritative",
          disposition: "planned",
          detail: `Restore preserved Assistant ${file.label} byte-for-byte after the module is enabled.`,
        });
        contribution.operations.push({
          id: stableMigrationId(`${context.repository.repositoryId}\0assistant-reactivation-v1\0${file.legacy}\0${legacy.content}`),
          generation: 0,
          repository: context.repository,
          baseRemoteCommit: context.snapshot.remoteCommit,
          effect: "migration",
          reads: [{ path: file.target, revision: null }],
          writes: [{ path: file.target, revision: null, content: legacy.content }],
          message: `Restore preserved Assistant ${file.label}`,
        });
      }
      return contribution;
    },
  };
}
