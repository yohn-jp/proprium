import path from "node:path";
import type { MigrationContext, MigrationContribution, MigrationProducer } from "../types.js";
import { decodeLegacyBytes, planExactFileImport, recoveryRecord } from "../operations.js";

interface FileMapping {
  source: string;
  target: string;
  category: "authoritative" | "relocated";
  moduleId: NonNullable<MigrationProducer["moduleId"]>;
  label: string;
}

const FILE_MAPPINGS: FileMapping[] = [
  {
    source: "meta/speaker-corrections.jsonl",
    target: "meta/scriptorium/modules/speaker/corrections.jsonl",
    category: "authoritative",
    moduleId: "speaker",
    label: "human speaker corrections",
  },
  {
    source: "meta/speaker-model.json",
    target: "meta/scriptorium/modules/speaker/adopted-model.json",
    category: "authoritative",
    moduleId: "speaker",
    label: "adopted small speaker model parameters",
  },
  {
    source: "meta/synonyms.yaml",
    target: "meta/scriptorium/modules/nlp/synonyms.yaml",
    category: "authoritative",
    moduleId: "nlp",
    label: "custom synonym dictionary",
  },
  {
    source: "meta/candidate-ignore-list.yaml",
    target: "meta/scriptorium/modules/nlp/candidate-ignore-list.yaml",
    category: "authoritative",
    moduleId: "nlp",
    label: "ignored candidate terms",
  },
  {
    source: "meta/contradiction-dismissals.jsonl",
    target: "meta/scriptorium/modules/semantic/contradiction-dismissals.jsonl",
    category: "authoritative",
    moduleId: "semantic",
    label: "author contradiction dismissals",
  },
  {
    source: "meta/publish-episodes.yaml",
    target: "meta/scriptorium/modules/publishing/episodes.yaml",
    category: "authoritative",
    moduleId: "publishing",
    label: "publication episode mapping",
  },
  {
    source: ".arcadia/llm-model-settings.json",
    target: "meta/scriptorium/modules/assistant/model-settings.json",
    category: "authoritative",
    moduleId: "assistant",
    label: "non-secret model routing and budget settings",
  },
  {
    source: ".arcadia/nlp-feature-settings.json",
    target: "meta/scriptorium/modules/nlp/feature-settings.json",
    category: "authoritative",
    moduleId: "nlp",
    label: "per-work feature privacy settings",
  },
  {
    source: ".arcadia/llm-usage.jsonl",
    target: "meta/scriptorium/modules/assistant/usage.jsonl",
    category: "authoritative",
    moduleId: "assistant",
    label: "historical model usage records",
  },
  {
    source: ".arcadia/cover.jpg",
    target: "meta/scriptorium/modules/publishing/assets/cover.jpg",
    category: "authoritative",
    moduleId: "publishing",
    label: "local publication cover asset",
  },
];

const DERIVED_FILES = new Map<string, string>([
  ["meta/speaker-rule-gates.json", "Computed from evaluation and correction evidence; rebuild from retained inputs."],
  [".arcadia/speaker-eval-latest.json", "Cached evaluation report; rebuild from retained corrections and manuscript."],
]);

function jsonRecordId(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const changeSet = record.changeSet;
  if (changeSet && typeof changeSet === "object" && typeof (changeSet as Record<string, unknown>).id === "string") {
    return (changeSet as Record<string, string>).id;
  }
  return null;
}

async function planDisabledFile(input: {
  context: MigrationContext;
  source: string;
  moduleId: NonNullable<MigrationProducer["moduleId"]>;
  category: "authoritative" | "provisional" | "relocated";
  bytes: Buffer;
  label: string;
}) {
  const target = "meta/scriptorium/modules/" + input.moduleId + "/legacy/files/" + input.source;
  const planned = await planExactFileImport({
    context: input.context,
    producerId: "filesystem-disabled",
    source: input.source,
    target,
    category: input.category,
    bytes: input.bytes,
    detail: "Preserve " + input.label + " byte-for-byte in module-owned legacy data; it remains unreadable until " + input.moduleId + " is enabled.",
    message: "Preserve disabled " + input.moduleId + " legacy file",
  });
  if (planned.entry.disposition === "planned" || planned.entry.disposition === "unchanged") {
    planned.entry.disposition = "preserved-unreadable";
  }
  return planned;
}

async function inspectChangeSets(context: MigrationContext): Promise<MigrationContribution> {
  const result: MigrationContribution = { entries: [], operations: [], recovery: [] };
  const files = await context.source.listProjectFiles(".arcadia/change-sets");
  for (const source of files.filter((file) => file.endsWith(".json"))) {
    const bytes = await context.source.readProjectFile(source);
    if (!bytes) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes.toString("utf8"));
    } catch {
      result.entries.push({
        producerId: "filesystem",
        source,
        category: "provisional",
        disposition: "blocked",
        detail: "Stored ChangeSet is not valid JSON; source was left untouched.",
      });
      continue;
    }
    if (!parsed || typeof parsed !== "object") {
      result.entries.push({
        producerId: "filesystem",
        source,
        category: "provisional",
        disposition: "blocked",
        detail: "Stored ChangeSet has no record object; source was left untouched.",
      });
      continue;
    }
    const id = jsonRecordId(parsed);
    if (!id) {
      result.entries.push({
        producerId: "filesystem",
        source,
        category: "provisional",
        disposition: "blocked",
        detail: "Stored ChangeSet has no stable ChangeSet ID; source was left untouched.",
      });
      continue;
    }
    const status = (parsed as Record<string, unknown>).status;
    if (status === "applied" || status === "partially-applied" || status === "rejected") {
      const suffix = source.slice(".arcadia/change-sets/".length);
      const target = `meta/scriptorium/modules/story/change-sets/${suffix}`;
      if (!context.enabledModules.has("story")) {
        const opaque = await planDisabledFile({
          context,
          source,
          moduleId: "story",
          category: "authoritative",
          bytes,
          label: "approved ChangeSet " + id + " and decision history",
        });
        result.entries.push({
          producerId: "filesystem",
          source,
          target: opaque.entry.target,
          category: "authoritative",
          disposition: opaque.entry.disposition,
          detail: "Story is disabled; stable ChangeSet " + id + " is preserved byte-for-byte and remains unreadable until re-enabled.",
        });
        if (opaque.operation) result.operations.push(opaque.operation);
        continue;
      }
      const planned = await planExactFileImport({
        context,
        producerId: "filesystem",
        moduleId: "story",
        source,
        target,
        category: "authoritative",
        bytes,
        detail: `Preserve stable ChangeSet ${id} and its ${String(status)} history as versioned story metadata.`,
        message: "Import legacy approved change history",
      });
      result.entries.push(planned.entry);
      if (planned.operation) result.operations.push(planned.operation);
    } else {
      const decoded = decodeLegacyBytes(bytes);
      if (!context.enabledModules.has("story")) {
        const opaque = await planDisabledFile({
          context,
          source,
          moduleId: "story",
          category: "provisional",
          bytes,
          label: "pending ChangeSet " + id,
        });
        result.entries.push({
          producerId: "filesystem",
          source,
          target: opaque.entry.target,
          category: "provisional",
          disposition: opaque.entry.disposition,
          detail: "Pending ChangeSet " + id + " is preserved as opaque data and remains unreadable until story is enabled.",
        });
        if (opaque.operation) result.operations.push(opaque.operation);
      } else {
        result.entries.push({
          producerId: "filesystem",
          source,
          category: "provisional",
          disposition: "deferred",
          detail: "Pending ChangeSet " + id + " remains a local recovery record until an author resolves it.",
        });
      }
      result.recovery.push(
        recoveryRecord({
          producerId: "filesystem-change-set",
          source,
          content: decoded.content,
          encoding: decoded.encoding,
          stableId: id,
          detail: "Unapplied ChangeSet; keep in the same-origin recovery journal for author review.",
        }),
      );
    }
  }
  return result;
}

async function inspectSnapshots(context: MigrationContext): Promise<MigrationContribution> {
  const result: MigrationContribution = { entries: [], operations: [], recovery: [] };
  const files = await context.source.listProjectFiles(".arcadia/snapshots");
  for (const source of files) {
    const bytes = await context.source.readProjectFile(source);
    if (!bytes) continue;
    const suffix = source.slice(".arcadia/snapshots/".length);
    const target = `meta/scriptorium/modules/story/local-snapshots/${suffix}`;
    if (!context.enabledModules.has("story")) {
      const opaque = await planDisabledFile({
        context,
        source,
        moduleId: "story",
        category: "relocated",
        bytes,
        label: "legacy snapshot and sidecar data",
      });
      result.entries.push({
        producerId: "filesystem",
        source,
        target: opaque.entry.target,
        category: "relocated",
        disposition: opaque.entry.disposition,
        detail: "Story is disabled; snapshot and sidecar bytes are versioned as opaque module data and remain unreadable until re-enabled.",
      });
      if (opaque.operation) result.operations.push(opaque.operation);
      continue;
    }
    const planned = await planExactFileImport({
      context,
      producerId: "filesystem",
      moduleId: "story",
      source,
      target,
      category: "relocated",
      bytes,
      detail: "Retain local manuscript snapshot content and its original filename and sidecar metadata.",
      message: "Import legacy manuscript snapshots",
    });
    result.entries.push(planned.entry);
    if (planned.operation) result.operations.push(planned.operation);
  }
  return result;
}

async function inspectArcadiaRemainder(context: MigrationContext): Promise<MigrationContribution> {
  const result: MigrationContribution = { entries: [], operations: [], recovery: [] };
  const files = await context.source.listProjectFiles(".arcadia");
  const mapped = new Set(FILE_MAPPINGS.map((mapping) => mapping.source));
  const handledPrefixes = [".arcadia/change-sets/", ".arcadia/snapshots/"];
  const handled = new Set<string>([
    ...mapped,
    ".arcadia/index.sqlite",
    ".arcadia/index.sqlite-wal",
    ".arcadia/index.sqlite-shm",
    ".arcadia/index.sqlite-journal",
    ".arcadia/speaker-eval-latest.json",
  ]);
  for (const file of files) {
    if (handled.has(file) || handledPrefixes.some((prefix) => file.startsWith(prefix))) continue;
    if (file.startsWith(".arcadia/llm-cache/")) {
      result.entries.push({
        producerId: "filesystem",
        source: file,
        category: "derived",
        disposition: "rebuild",
        detail: "LLM response and summary cache is snapshot/version keyed and can be regenerated.",
      });
      continue;
    }
    result.entries.push({
      producerId: "filesystem",
      source: file,
      category: "relocated",
      disposition: "unclassified",
      detail: "No generic importer owns this legacy file; leave it in place and add a module producer before removal.",
    });
  }
  return result;
}

export function createFilesystemProducer(): MigrationProducer {
  return {
    id: "filesystem",
    async inspect(context): Promise<MigrationContribution> {
      const result: MigrationContribution = { entries: [], operations: [], recovery: [] };
      for (const mapping of FILE_MAPPINGS) {
        const bytes = await context.source.readProjectFile(mapping.source);
        if (!bytes) continue;
        if (!context.enabledModules.has(mapping.moduleId)) {
          const opaque = await planDisabledFile({
            context,
            source: mapping.source,
            moduleId: mapping.moduleId,
            category: mapping.category,
            bytes,
            label: mapping.label,
          });
          result.entries.push({
            producerId: "filesystem",
            source: mapping.source,
            target: opaque.entry.target,
            category: mapping.category,
            disposition: opaque.entry.disposition,
            detail: "Module " + mapping.moduleId + " is disabled; complete bytes are versioned in its legacy namespace and remain unreadable until re-enabled.",
          });
          if (opaque.operation) result.operations.push(opaque.operation);
          continue;
        }
        const planned = await planExactFileImport({
          context,
          producerId: "filesystem",
          moduleId: mapping.moduleId,
          source: mapping.source,
          target: mapping.target,
          category: mapping.category,
          bytes,
          detail: `Preserve the complete legacy file byte-for-byte: ${mapping.label}.`,
          message: `Import legacy ${mapping.label}`,
        });
        result.entries.push(planned.entry);
        if (planned.operation) result.operations.push(planned.operation);
      }
      for (const [source, detail] of DERIVED_FILES) {
        if (!(await context.source.readProjectFile(source))) continue;
        result.entries.push({
          producerId: "filesystem",
          source,
          category: "derived",
          disposition: "rebuild",
          detail,
        });
      }
      const [changeSets, snapshots, rest] = await Promise.all([
        inspectChangeSets(context),
        inspectSnapshots(context),
        inspectArcadiaRemainder(context),
      ]);
      result.entries.push(...changeSets.entries, ...snapshots.entries, ...rest.entries);
      result.operations.push(...changeSets.operations, ...snapshots.operations);
      result.recovery.push(...changeSets.recovery);
      return result;
    },
  };
}

export function relativeSnapshotTarget(source: string): string {
  return path.posix.join(
    "meta/scriptorium/modules/story/local-snapshots",
    source.slice(".arcadia/snapshots/".length),
  );
}
