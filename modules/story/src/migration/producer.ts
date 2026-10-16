import {
  decodeLegacyBytes,
  planExactFileImport,
  type MigrationContext,
  type MigrationContribution,
  type MigrationProducer,
} from "@scriptorium/migration";

const STORY_SOURCE_ROOTS = [
  { prefix: "bible", extension: ".yaml" },
  { prefix: "plot", extension: ".yaml" },
  { prefix: "meta", extension: ".yaml" },
  { prefix: "manuscript", extension: ".md" },
] as const;

const LEGACY_STORY_PREFIX = "meta/scriptorium/modules/story/legacy/files/";
const MAX_RESTORABLE_TEXT_BYTES = 8 * 1024 * 1024;

function isStorySourceFile(file: string): boolean {
  return STORY_SOURCE_ROOTS.some(
    ({ prefix, extension }) => file.startsWith(`${prefix}/`) && file.endsWith(extension),
  );
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

      if (enabled) {
        const restored = await inspectLegacyStoryFiles(context, sourceFiles);
        result.entries.push(...restored.entries);
        result.operations.push(...restored.operations);
      }

      return result;
    },
  };
}
