import {
  decodeLegacyBytes,
  planExactFileImport,
  planGeneratedFileImport,
  recoveryRecord,
  type MigrationContext,
  type MigrationContribution,
  type MigrationProducer,
} from "@scriptorium/migration";
import type { RepositoryIdentity } from "@scriptorium/contracts";
import { planStorySqliteWorkflow } from "./workflowRows.js";

const STORY_SOURCE_ROOTS = [
  { prefix: "bible", extension: ".yaml" },
  { prefix: "plot", extension: ".yaml" },
  { prefix: "meta", extension: ".yaml" },
  { prefix: "manuscript", extension: ".md" },
] as const;

const LEGACY_STORY_PREFIX = "meta/scriptorium/modules/story/legacy/files/";
const STORY_CHANGE_SETS = "meta/scriptorium/modules/story/change-sets/";
const STORY_LOCAL_SNAPSHOTS = "meta/scriptorium/modules/story/local-snapshots/";
const STORY_SERIES_SETTINGS = "meta/scriptorium/modules/story/v1/series.json";
const SERIES_SOURCE_PATHS = ["app-state/series.json", "series.json"] as const;
const MAX_RESTORABLE_TEXT_BYTES = 8 * 1024 * 1024;
const MODULE_OWNED_META_FILES = new Set([
  "meta/synonyms.yaml",
  "meta/candidate-ignore-list.yaml",
  "meta/publish-episodes.yaml",
  "meta/lint-rules.yaml",
  "meta/tone-lexicon.yaml",
  "meta/plot-lexicon.yaml",
]);

function isStorySourceFile(file: string): boolean {
  if (file.startsWith("meta/scriptorium/modules/") || MODULE_OWNED_META_FILES.has(file)) return false;
  if (file.startsWith("meta/scratch/")) return true;
  if (file === "app-state/series.json" || file === "series.json") return true;
  return STORY_SOURCE_ROOTS.some(
    ({ prefix, extension }) => file.startsWith(`${prefix}/`) && file.endsWith(extension),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function changeSetStableId(record: Record<string, unknown>): string | null {
  const nestedId = isRecord(record.changeSet) ? record.changeSet.id : undefined;
  for (const candidate of [nestedId, record.id]) {
    if (typeof candidate === "string" && candidate.trim()) return candidate;
  }
  return null;
}

type StoryMigrationContext = MigrationContext & {
  legacyRepositoryMappings?: Readonly<Record<string, RepositoryIdentity>>;
};

function mappedRepositoryId(context: MigrationContext, legacyProjectId: unknown): string | undefined {
  if (typeof legacyProjectId !== "string") return undefined;
  const mapping = (context as StoryMigrationContext).legacyRepositoryMappings?.[legacyProjectId];
  return typeof mapping?.repositoryId === "string" && mapping.repositoryId.length > 0
    ? mapping.repositoryId
    : undefined;
}

function convertSeriesSettings(context: MigrationContext, text: string): { content: string; review: string[] } {
  const parsed: unknown = JSON.parse(text);
  if (!isRecord(parsed) || !Array.isArray(parsed.series) || !Array.isArray(parsed.bindings)) {
    throw new TypeError("Legacy series.json must contain series and bindings arrays");
  }
  const review: string[] = [];
  const series = parsed.series.map((value, index) => {
    if (!isRecord(value)) { review.push(`series[${index}]`); return value; }
    const result: Record<string, unknown> = { ...value };
    const bibleProjectId = value.bibleProjectId;
    const bibleRepositoryId = mappedRepositoryId(context, bibleProjectId);
    if (bibleRepositoryId) result.bibleRepositoryId = bibleRepositoryId;
    else if (typeof bibleProjectId === "string" && !value.bibleRepositoryId) review.push(`series[${index}].bibleProjectId=${bibleProjectId}`);
    if (Array.isArray(value.memberProjectIds)) {
      const mapped = value.memberProjectIds.flatMap((projectId) => {
        const repositoryId = mappedRepositoryId(context, projectId);
        if (repositoryId) return [repositoryId];
        if (typeof projectId === "string") review.push(`series[${index}].memberProjectIds=${projectId}`);
        return [];
      });
      result.memberRepositoryIds = [...new Set([...(Array.isArray(value.memberRepositoryIds) ? value.memberRepositoryIds.filter((id): id is string => typeof id === "string") : []), ...mapped])];
    }
    if (review.some((item) => item.startsWith(`series[${index}]`))) result.requiresAuthorReview = true;
    return result;
  });
  const bindings = parsed.bindings.map((value, index) => {
    if (!isRecord(value)) { review.push(`bindings[${index}]`); return value; }
    const result: Record<string, unknown> = { ...value };
    const repositoryId = mappedRepositoryId(context, value.projectId);
    if (repositoryId) result.repositoryId = repositoryId;
    else if (typeof value.projectId === "string" && !value.repositoryId) {
      review.push(`bindings[${index}].projectId=${value.projectId}`);
      result.requiresAuthorReview = true;
    }
    return result;
  });
  const existingMigration = isRecord(parsed.migration) ? parsed.migration : {};
  const settings = {
    ...parsed,
    version: 1,
    series,
    bindings,
    ...(review.length ? { migration: { ...existingMigration, storySeriesReview: [...new Set(review)] } } : {}),
  };
  return { content: `${JSON.stringify(settings, null, 2)}\n`, review };
}

async function planSeriesSettings(
  context: MigrationContext,
  source: string,
  bytes: Buffer,
  enabled: boolean,
): Promise<{ entry: MigrationContribution["entries"][number]; operation?: MigrationContribution["operations"][number] }> {
  if (!enabled) {
    const planned = await planExactFileImport({
      context,
      producerId: "story-v1",
      source,
      target: legacyPath(source),
      category: "authoritative",
      bytes,
      detail: "Preserve the complete workspace series registry opaquely while Story is disabled; legacy project IDs and all unknown fields remain reviewable.",
      message: "Preserve disabled Story series settings",
    });
    if (planned.entry.disposition === "planned" || planned.entry.disposition === "unchanged") planned.entry.disposition = "preserved-unreadable";
    return planned;
  }

  try {
    const converted = convertSeriesSettings(context, bytes.toString("utf8"));
    const planned = await planExactFileImport({
      context,
      producerId: "story-v1",
      source,
      target: STORY_SERIES_SETTINGS,
      category: "authoritative",
      bytes: Buffer.from(converted.content, "utf8"),
      detail: converted.review.length
        ? `Convert mapped legacy series project IDs to stable repository IDs, preserve original values and unknown fields, and retain unresolved bindings for author review: ${converted.review.join("; ")}.`
        : "Convert legacy series project IDs through explicit host-verified repository mappings and preserve unknown fields in Story-owned versioned settings.",
      message: "Import Story series settings",
    });
    if (converted.review.length && planned.entry.disposition === "planned") {
      planned.entry.detail = `${planned.entry.detail} Author review remains required for unresolved legacy project bindings.`;
    }
    return planned;
  } catch (error) {
    return {
      entry: semanticEntry({
        source,
        target: STORY_SERIES_SETTINGS,
        disposition: "blocked",
        detail: `The series registry could not be semantically converted and remains unchanged for explicit review: ${error instanceof Error ? error.message : String(error)}`,
      }),
    };
  }
}

function legacyPath(source: string): string {
  return LEGACY_STORY_PREFIX + source;
}

function semanticEntry(input: {
  source: string;
  target: string;
  disposition: MigrationContribution["entries"][number]["disposition"];
  detail: string;
}): MigrationContribution["entries"][number] {
  return {
    producerId: "story-v1",
    source: input.source,
    target: input.target,
    category: "authoritative",
    disposition: input.disposition,
    detail: input.detail,
  };
}

type StoryFileEncoding = "utf8" | "base64";

function storyFileEncoding(path: string): StoryFileEncoding {
  if (path.startsWith("meta/scratch/")) return /\.md$/iu.test(path) ? "utf8" : "base64";
  if (path.startsWith(".arcadia/snapshots/")) {
    const snapshotText = /\.(?:md|json)$/iu.test(path) && !path.includes("/files/");
    return snapshotText ? "utf8" : "base64";
  }
  if (path.startsWith(".arcadia/change-sets/")) return "utf8";
  if (/\.(?:md|markdown|ya?ml|json|txt)$/iu.test(path)) return "utf8";
  return "base64";
}

function encodeStoryFile(bytes: Buffer, path: string): { content: string; encoding: StoryFileEncoding } {
  if (storyFileEncoding(path) === "base64") return { content: bytes.toString("base64"), encoding: "base64" };
  return decodeLegacyBytes(bytes);
}

function decodeOpaqueBytes(content: string): Buffer | null {
  const bytes = Buffer.from(content, "base64");
  return bytes.toString("base64") === content ? bytes : null;
}

async function planStoryFileImport(input: {
  context: MigrationContext;
  source: string;
  target: string;
  encodingPath: string;
  category: MigrationContribution["entries"][number]["category"];
  bytes: Buffer;
  detail: string;
  message: string;
  sourceRead?: { path: string; revision: string };
}): Promise<{ entry: MigrationContribution["entries"][number]; operation?: MigrationContribution["operations"][number] }> {
  const encoded = encodeStoryFile(input.bytes, input.encodingPath);
  if (encoded.content.length > MAX_RESTORABLE_TEXT_BYTES) {
    return {
      entry: {
        producerId: "story-v1",
        source: input.source,
        target: input.target,
        category: input.category,
        disposition: "blocked",
        detail: "File exceeds the bounded Story migration payload and remains unchanged for recovery.",
      },
    };
  }
  const existing = await input.context.target.read(input.target, encoded.encoding);
  if (existing?.content === encoded.content) {
    return {
      entry: {
        producerId: "story-v1",
        source: input.source,
        target: input.target,
        category: input.category,
        disposition: "unchanged",
        detail: "Target already contains the exact source bytes.",
      },
    };
  }
  if (existing) {
    return {
      entry: {
        producerId: "story-v1",
        source: input.source,
        target: input.target,
        category: input.category,
        disposition: "conflict",
        detail: "Target already contains different bytes; neither version is overwritten.",
      },
    };
  }
  const planned = await planGeneratedFileImport({
    context: input.context,
    producerId: "story-v1",
    source: input.source,
    target: input.target,
    category: input.category,
    content: encoded.content,
    encoding: encoded.encoding,
    detail: input.detail,
    message: input.message,
    existing: null,
  });
  if (planned.operation && input.sourceRead) {
    planned.operation.reads.push({ path: input.sourceRead.path, revision: input.sourceRead.revision });
  }
  return planned;
}

async function planCanonicalFile(
  context: MigrationContext,
  source: string,
  bytes: Buffer,
  enabled: boolean,
): Promise<{
  entry: MigrationContribution["entries"][number];
  operation?: MigrationContribution["operations"][number];
}> {
  const target = enabled ? source : legacyPath(source);
  if (source.startsWith("meta/scratch/")) {
    const planned = await planStoryFileImport({
      context,
      source,
      target,
      encodingPath: source,
      category: "authoritative",
      bytes,
      detail: enabled
        ? "Preserve committed Story scratch notes and attachments at their original paths, using base64 for non-Markdown assets."
        : "Preserve committed Story scratch notes and attachments byte-for-byte in the opaque Story namespace while Story is disabled.",
      message: enabled ? "Import Story author scratch file" : "Preserve disabled Story author scratch file",
    });
    if (!enabled && (planned.entry.disposition === "planned" || planned.entry.disposition === "unchanged")) {
      planned.entry.disposition = "preserved-unreadable";
    }
    return planned;
  }
  const planned = await planExactFileImport({
    context,
    producerId: "story-v1",
    source,
    target,
    category: "authoritative",
    bytes,
    detail: enabled
      ? "Preserve the canonical Story document byte-for-byte, including stable IDs and unknown YAML/frontmatter fields."
      : "Preserve the canonical Story document byte-for-byte in the versioned opaque namespace while Story is disabled.",
    message: enabled ? "Import legacy Story document" : "Preserve disabled Story document",
  });
  if (!enabled && (planned.entry.disposition === "planned" || planned.entry.disposition === "unchanged")) {
    planned.entry.disposition = "preserved-unreadable";
  }
  return planned;
}

async function inspectLegacyStoryFiles(
  context: MigrationContext,
  sourceFiles: ReadonlyMap<string, Buffer>,
): Promise<MigrationContribution> {
  const result: MigrationContribution = { entries: [], operations: [], recovery: [] };
  const legacyFiles = await context.target.list(LEGACY_STORY_PREFIX.slice(0, -1));

  for (const source of [...new Set(legacyFiles)].sort((a, b) => a.localeCompare(b))) {
    if (!source.startsWith(LEGACY_STORY_PREFIX)) continue;
    const canonicalPath = source.slice(LEGACY_STORY_PREFIX.length);
    const changeSet = canonicalPath.startsWith(".arcadia/change-sets/");
    const localSnapshot = canonicalPath.startsWith(".arcadia/snapshots/");
    const restorableHistory = changeSet || localSnapshot;
    if (!isStorySourceFile(canonicalPath) && !restorableHistory) {
      result.entries.push(
        semanticEntry({
          source,
          target: canonicalPath,
          disposition: "blocked",
          detail: "The opaque path is outside the source Story YAML/Markdown layout; it remains untouched for explicit review.",
        }),
      );
      continue;
    }

    const opaque = await context.target.read(source, "base64");
    if (!opaque) {
      result.entries.push(
        semanticEntry({
          source,
          target: canonicalPath,
          disposition: "blocked",
          detail: "The opaque Story path was listed but could not be read from the selected target snapshot.",
        }),
      );
      continue;
    }

    const bytes = decodeOpaqueBytes(opaque.content);
    if (!bytes) {
      result.entries.push(semanticEntry({
        source,
        target: restorableHistory
          ? (changeSet ? `${STORY_CHANGE_SETS}${canonicalPath.slice(".arcadia/change-sets/".length)}` : `${STORY_LOCAL_SNAPSHOTS}${canonicalPath.slice(".arcadia/snapshots/".length)}`)
          : canonicalPath,
        disposition: "blocked",
        detail: "The opaque Story source is not available as canonical base64 bytes; it remains unchanged for explicit recovery.",
      }));
      continue;
    }

    const currentSource = sourceFiles.get(canonicalPath) ?? await context.source.readProjectFile(canonicalPath);

    if (changeSet) {
      const target = `${STORY_CHANGE_SETS}${canonicalPath.slice(".arcadia/change-sets/".length)}`;
      let record: unknown;
      try {
        const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
        record = JSON.parse(text);
      } catch {
        result.entries.push(semanticEntry({ source, target, disposition: "blocked", detail: "The opaque change-set record is not valid UTF-8 JSON; its exact bytes remain available in recovery." }));
        continue;
      }
      if (!isRecord(record)) {
        result.entries.push(semanticEntry({ source, target, disposition: "blocked", detail: "The opaque change-set record has no stable source ID; it remains unchanged for explicit review." }));
        continue;
      }
      const stableId = changeSetStableId(record);
      if (!stableId) {
        result.entries.push(semanticEntry({ source, target, disposition: "blocked", detail: "The opaque change-set record has no stable source ID; it remains unchanged for explicit review." }));
        continue;
      }
      const status = record.status;
      const applied = status === "applied" || status === "partially-applied" || status === "rejected";
      if (!applied) {
        if (currentSource) {
          const unchanged = currentSource.equals(bytes);
          result.entries.push({
            producerId: "story-v1",
            source,
            target,
            category: "provisional",
            disposition: unchanged ? "unchanged" : "conflict",
            detail: unchanged
              ? "The current pending ChangeSet matches the retained copy; the filesystem importer owns its private recovery record."
              : "The current and retained pending ChangeSet records differ; both remain private recovery data for author review.",
          });
          if (!unchanged) {
            result.recovery.push(recoveryRecord({
              producerId: "story-v1-pending-change-set",
              source: canonicalPath,
              content: bytes.toString("base64"),
              encoding: "base64",
              stableId,
              detail: "Unaccepted change-set metadata is preserved for explicit recovery; no approval or publication state was inferred.",
            }));
          }
          continue;
        }
        result.entries.push({
          producerId: "story-v1",
          source,
          target,
          category: "provisional",
          disposition: "deferred",
          detail: "Pending or unaccepted legacy change-set metadata remains local recovery data and is never imported as approved Story state.",
        });
        result.recovery.push(recoveryRecord({
          producerId: "story-v1-pending-change-set",
          source: canonicalPath,
          content: bytes.toString("base64"),
          encoding: "base64",
          stableId,
          detail: "Unaccepted change-set metadata is preserved for explicit recovery; no approval or publication state was inferred.",
        }));
        continue;
      }
      if (currentSource) {
        const unchanged = currentSource.equals(bytes);
        result.entries.push(semanticEntry({
          source,
          target,
          disposition: unchanged ? "unchanged" : "conflict",
          detail: unchanged
            ? "The current ChangeSet matches the retained copy; the filesystem importer owns the canonical history write."
            : "The retained ChangeSet differs from the current source record; neither version is selected for automatic migration.",
        }));
        continue;
      }
      const planned = await planStoryFileImport({
        context,
        source,
        target,
        encodingPath: canonicalPath,
        category: "authoritative",
        bytes,
        detail: "Restore the exact committed applied, partially applied, or rejected ChangeSetRecord bytes as Story-owned history without replaying its operation payload.",
        message: "Restore committed Story change-set history",
        sourceRead: { path: source, revision: opaque.revision },
      });
      result.entries.push(planned.entry);
      if (planned.operation) result.operations.push(planned.operation);
      continue;
    }

    if (localSnapshot) {
      const target = `${STORY_LOCAL_SNAPSHOTS}${canonicalPath.slice(".arcadia/snapshots/".length)}`;
      if (currentSource) {
        const unchanged = currentSource.equals(bytes);
        result.entries.push({
          producerId: "story-v1",
          source,
          target,
          category: "relocated",
          disposition: unchanged ? "unchanged" : "conflict",
          detail: unchanged
            ? "The current local snapshot matches the retained copy; the filesystem importer owns the canonical snapshot write."
            : "The retained local snapshot differs from the current source snapshot; neither version is selected for automatic restoration.",
        });
        continue;
      }
      const planned = await planStoryFileImport({
        context,
        source,
        target,
        encodingPath: canonicalPath,
        category: "relocated",
        bytes,
        detail: "Restore the local snapshot and its attachments byte-for-byte into Story-owned recovery storage; this does not publish author history.",
        message: "Restore Story local snapshot",
        sourceRead: { path: source, revision: opaque.revision },
      });
      result.entries.push(planned.entry);
      if (planned.operation) result.operations.push(planned.operation);
      continue;
    }

    if (currentSource) {
      const unchanged = currentSource.equals(bytes);
      result.entries.push(
        semanticEntry({
          source,
          target: canonicalPath,
          disposition: unchanged ? "unchanged" : "conflict",
          detail:
            unchanged
              ? "The source and opaque copy contain the same bytes; the canonical source import already owns this path."
              : "The source and opaque copy differ; neither version is selected for an automatic canonical write.",
        }),
      );
      continue;
    }

    if (
      !canonicalPath.startsWith("meta/scratch/") &&
      storyFileEncoding(canonicalPath) === "utf8" &&
      (bytes.includes(0) || !isValidUtf8(bytes))
    ) {
      result.entries.push(
        semanticEntry({
          source,
          target: canonicalPath,
          disposition: "blocked",
          detail: "The opaque snapshot cannot be decoded as exact YAML/Markdown text; it remains unchanged for explicit recovery.",
        }),
      );
      continue;
    }

    if (canonicalPath === "app-state/series.json" || canonicalPath === "series.json") {
      const planned = await planSeriesSettings(context, source, bytes, true);
      result.entries.push(planned.entry);
      if (planned.operation) result.operations.push(planned.operation);
      continue;
    }

    const planned = await planStoryFileImport({
      context,
      source,
      target: canonicalPath,
      encodingPath: canonicalPath,
      category: "authoritative",
      bytes,
      detail: "Restore the exact UTF-8 YAML/Markdown text from the opaque Story namespace after re-enabling Story.",
      message: "Restore legacy Story document",
      sourceRead: { path: source, revision: opaque.revision },
    });
    result.entries.push(planned.entry);
    if (planned.operation) result.operations.push(planned.operation);
  }

  return result;
}

function isValidUtf8(bytes: Buffer): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

/** Migrate canonical Story documents and restore opaque Story documents when re-enabled. */
export function createStoryMigrationProducer(): MigrationProducer {
  return {
    id: "story-v1",
    moduleId: "story",
    async inspect(context: MigrationContext): Promise<MigrationContribution> {
      const enabled = context.enabledModules.has("story");
      const listed = await Promise.all(
        STORY_SOURCE_ROOTS.map(({ prefix }) => context.source.listProjectFiles(prefix)),
      );
      const files = [...new Set(listed.flat().filter(isStorySourceFile))].sort((a, b) =>
        a.localeCompare(b),
      );
      const result: MigrationContribution = { entries: [], operations: [], recovery: [] };
      const sourceFiles = new Map<string, Buffer>();

      for (const source of files) {
        const bytes = await context.source.readProjectFile(source);
        if (!bytes) {
          result.entries.push(
            semanticEntry({
              source,
              target: enabled ? source : legacyPath(source),
              disposition: "blocked",
              detail: "The source file was listed but could not be read; no partial target file was planned.",
            }),
          );
          continue;
        }
        sourceFiles.set(source, bytes);
        const planned = await planCanonicalFile(context, source, bytes, enabled);
        result.entries.push(planned.entry);
        if (planned.operation) result.operations.push(planned.operation);
      }

      const seriesPaths = await Promise.all(SERIES_SOURCE_PATHS.map(async (path) => ({ path, bytes: await context.source.readWorkspaceFile(path) })));
      const existingSeries = seriesPaths.filter((item): item is { path: typeof SERIES_SOURCE_PATHS[number]; bytes: Buffer } => item.bytes !== null);
      if (existingSeries.length > 1) {
        const [first, ...rest] = existingSeries;
        for (const duplicate of rest) {
          if (!first || !duplicate) continue;
          result.entries.push(semanticEntry({
            source: duplicate.path,
            target: STORY_SERIES_SETTINGS,
            disposition: first.bytes.equals(duplicate.bytes) ? "unchanged" : "conflict",
            detail: first.bytes.equals(duplicate.bytes)
              ? `This legacy series alias duplicates ${first.path}; the selected canonical registry owns the Story import.`
              : `This legacy series alias differs from ${first.path}; neither registry is selected for an automatic Story settings write.`,
          }));
        }
        if (rest.some((item) => !first?.bytes.equals(item.bytes))) {
          result.entries.push(semanticEntry({ source: first!.path, target: STORY_SERIES_SETTINGS, disposition: "conflict", detail: "The canonical and legacy series registries differ; neither is automatically selected." }));
        } else if (first) {
          const planned = await planSeriesSettings(context, first.path, first.bytes, enabled);
          result.entries.push(planned.entry);
          if (planned.operation) result.operations.push(planned.operation);
        }
      } else if (existingSeries[0]) {
        const planned = await planSeriesSettings(context, existingSeries[0].path, existingSeries[0].bytes, enabled);
        result.entries.push(planned.entry);
        if (planned.operation) result.operations.push(planned.operation);
      }

      if (enabled) {
        const restored = await inspectLegacyStoryFiles(context, sourceFiles);
        result.entries.push(...restored.entries);
        result.operations.push(...restored.operations);
        result.recovery.push(...restored.recovery);

        const workflows = await planStorySqliteWorkflow(context);
        result.entries.push(...workflows.entries);
        result.operations.push(...workflows.operations);
        result.recovery.push(...workflows.recovery);
      }

      return result;
    },
  };
}
