import { planExactFileImport } from "@scriptorium/migration";
import type { MigrationContribution, MigrationProducer } from "@scriptorium/migration";
import { stableMigrationId } from "@scriptorium/migration";

const DIAGNOSTICS_FILES = [
  { source: "meta/lint-rules.yaml", target: "meta/scriptorium/modules/diagnostics/lint-rules.yaml", label: "declarative lint rules" },
  { source: "meta/tone-lexicon.yaml", target: "meta/scriptorium/modules/diagnostics/tone-lexicon.yaml", label: "tone lexicon" },
  { source: "meta/plot-lexicon.yaml", target: "meta/scriptorium/modules/diagnostics/plot-lexicon.yaml", label: "plot lexicon" },
] as const;

function emptyContribution(): MigrationContribution {
  return { entries: [], operations: [], recovery: [] };
}

/**
 * Moves source diagnostics configuration into its module-owned namespace by
 * reviewable exact-byte operations. Disabled-module data remains opaque and can
 * be reactivated later without discarding unknown YAML fields.
 */
export function createDiagnosticsMigrationProducer(): MigrationProducer {
  return {
    id: "diagnostics-config-v1",
    moduleId: "diagnostics",
    async inspect(context) {
      const contribution = emptyContribution();
      const enabled = context.enabledModules.has("diagnostics");
      for (const file of DIAGNOSTICS_FILES) {
        const bytes = await context.source.readProjectFile(file.source);
        if (bytes) {
          const legacyTarget = `meta/scriptorium/modules/diagnostics/legacy/files/${file.source}`;
          const planned = await planExactFileImport({
            context,
            producerId: "diagnostics-config-v1",
            source: file.source,
            target: enabled ? file.target : legacyTarget,
            category: "authoritative",
            bytes,
            detail: enabled
              ? `Preserve ${file.label} in the diagnostics module namespace.`
              : `Diagnostics is disabled; preserve ${file.label} byte-for-byte until the module is enabled.`,
            message: enabled ? "Import diagnostics configuration" : "Preserve disabled diagnostics configuration",
          });
          if (!enabled && (planned.entry.disposition === "planned" || planned.entry.disposition === "unchanged")) {
            planned.entry.disposition = "preserved-unreadable";
          }
          contribution.entries.push(planned.entry);
          if (planned.operation) contribution.operations.push(planned.operation);
          continue;
        }

        if (!enabled) continue;
        const legacyPath = `meta/scriptorium/modules/diagnostics/legacy/files/${file.source}`;
        const legacy = await context.target.read(legacyPath);
        if (!legacy) continue;
        const existing = await context.target.read(file.target);
        if (existing) {
          contribution.entries.push({
            producerId: "diagnostics-config-v1",
            source: legacyPath,
            target: file.target,
            category: "authoritative",
            disposition: existing.content === legacy.content ? "unchanged" : "conflict",
            detail: existing.content === legacy.content
              ? "Diagnostics configuration already matches its preserved legacy value."
              : "Canonical diagnostics configuration differs from the preserved legacy value; neither version was overwritten.",
          });
          continue;
        }
        contribution.entries.push({
          producerId: "diagnostics-config-v1",
          source: legacyPath,
          target: file.target,
          category: "authoritative",
          disposition: "planned",
          detail: `Restore preserved ${file.label} byte-for-byte after the module is enabled.`,
        });
        contribution.operations.push({
          id: stableMigrationId(`${context.repository.repositoryId}\0diagnostics-config-v1\0${legacyPath}\0${legacy.content}`),
          generation: 0,
          repository: context.repository,
          baseRemoteCommit: context.snapshot.remoteCommit,
          effect: "migration",
          reads: [{ path: file.target, revision: null }],
          writes: [{ path: file.target, revision: null, content: legacy.content }],
          message: "Restore preserved diagnostics configuration",
        });
      }
      return contribution;
    },
  };
}
