import { planExactFileImport } from "@scriptorium/migration";
import type { MigrationContribution, MigrationProducer } from "@scriptorium/migration";

const SPEAKER_FILES = [
  {
    source: "meta/speaker-corrections.jsonl",
    target: "meta/scriptorium/modules/speaker/corrections.jsonl",
    label: "speaker correction decisions",
  },
  {
    source: "meta/speaker-model.json",
    target: "meta/scriptorium/modules/speaker/adopted-model.json",
    label: "adopted speaker model parameters",
  },
] as const;

function emptyContribution(): MigrationContribution {
  return { entries: [], operations: [], recovery: [] };
}

/** Restore speaker author state preserved by the filesystem producer when the module is reactivated. */
export function createSpeakerMigrationProducer(): MigrationProducer {
  return {
    id: "speaker-reactivation-v1",
    moduleId: "speaker",
    async inspect(context) {
      if (!context.enabledModules.has("speaker")) return emptyContribution();

      const contribution = emptyContribution();
      for (const file of SPEAKER_FILES) {
        // The generic filesystem producer owns a still-present source file.
        if (await context.source.readProjectFile(file.source)) continue;

        const legacyPath = `meta/scriptorium/modules/speaker/legacy/files/${file.source}`;
        const legacy = await context.target.read(legacyPath);
        if (!legacy) continue;

        const planned = await planExactFileImport({
          context,
          producerId: "speaker-reactivation-v1",
          source: legacyPath,
          target: file.target,
          category: "authoritative",
          bytes: Buffer.from(legacy.content, "utf8"),
          detail: `Restore preserved ${file.label} byte-for-byte after the speaker module is enabled.`,
          message: `Restore preserved ${file.label}`,
        });
        contribution.entries.push(planned.entry);
        if (planned.operation) contribution.operations.push(planned.operation);
      }
      return contribution;
    },
  };
}
