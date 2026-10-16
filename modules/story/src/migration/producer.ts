import {
  decodeLegacyBytes,
  planExactFileImport,
  type MigrationContext,
  type MigrationContribution,
  type MigrationProducer,
} from "@scriptorium/migration";
import type { RepositoryIdentity } from "@scriptorium/contracts";

const STORY_SOURCE_ROOTS = [
  { prefix: "bible", extension: ".yaml" },
  { prefix: "plot", extension: ".yaml" },
  { prefix: "meta", extension: ".yaml" },
  { prefix: "manuscript", extension: ".md" },
] as const;

const LEGACY_STORY_PREFIX = "meta/scriptorium/modules/story/legacy/files/";
const STORY_SERIES_SETTINGS = "meta/scriptorium/modules/story/v1/series.json";
const SERIES_SOURCE_PATHS = ["app-state/series.json", "series.json"] as const;
const MAX_RESTORABLE_TEXT_BYTES = 8 * 1024 * 1024;

function isStorySourceFile(file: string): boolean {
  if (file === "app-state/series.json" || file === "series.json") return true;
  return STORY_SOURCE_ROOTS.some(
    ({ prefix, extension }) => file.startsWith(`${prefix}/`) && file.endsWith(extension),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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
    if (!isStorySourceFile(canonicalPath)) {
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

    const opaque = await context.target.read(source);
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

    const currentSource = sourceFiles.get(canonicalPath);
    if (currentSource) {
      const sourceContent = decodeLegacyBytes(currentSource).content;
      result.entries.push(
        semanticEntry({
          source,
          target: canonicalPath,
          disposition: sourceContent === opaque.content ? "unchanged" : "conflict",
          detail:
            sourceContent === opaque.content
              ? "The source and opaque copy contain the same bytes; the canonical source import already owns this path."
              : "The source and opaque copy differ; neither version is selected for an automatic canonical write.",
        }),
      );
      continue;
    }

    if (opaque.content.includes("\u0000") || opaque.content.includes("\uFFFD")) {
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

    const bytes = Buffer.from(opaque.content, "utf8");
    if (bytes.byteLength > MAX_RESTORABLE_TEXT_BYTES) {
      result.entries.push(
        semanticEntry({
          source,
          target: canonicalPath,
          disposition: "blocked",
          detail: "The opaque Story document exceeds the ChangeOperation payload bound and remains unchanged.",
        }),
      );
      continue;
    }

    if (canonicalPath === "app-state/series.json" || canonicalPath === "series.json") {
      const planned = await planSeriesSettings(context, source, Buffer.from(opaque.content, "utf8"), true);
      result.entries.push(planned.entry);
      if (planned.operation) result.operations.push(planned.operation);
      continue;
    }

    const planned = await planExactFileImport({
      context,
      producerId: "story-v1",
      source,
      target: canonicalPath,
      category: "authoritative",
      bytes,
      detail: "Restore the exact UTF-8 YAML/Markdown text from the opaque Story namespace after re-enabling Story.",
      message: "Restore legacy Story document",
    });
    result.entries.push(planned.entry);
    if (planned.operation) result.operations.push(planned.operation);
  }

  return result;
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
      }

      return result;
    },
  };
}
