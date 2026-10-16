import path from "node:path";
import type { ChangeOperation } from "@scriptorium/contracts";
import type {
  MigrationContext,
  MigrationContribution,
  MigrationProducer,
  SqliteRow,
  SqliteTableInfo,
} from "../types.js";
import { planExactFileImport } from "../operations.js";

const PROJECT_DATABASE = ".arcadia/index.sqlite";
const PROJECT_LEGACY_ID = "project-arcadia";
const WORKSPACE_DATABASE_ID = "workspace-index";

const DERIVED_TABLES = new Set([
  "index_meta",
  "entities",
  "links",
  "entity_fts",
  "sentence_embeddings",
  "style_fingerprints",
  "scene_state_events",
  "reader_knowledge_events",
  "contradiction_candidates",
]);

const STORY_RECORD_TABLES = new Set(["state_proposals", "zukan_suggestions"]);

interface DatabaseLocation {
  id: string;
  path: string;
  workspace: boolean;
  tables: SqliteTableInfo[];
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(stableJson).join(",") + "]";
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return "{" + Object.keys(object).sort()
      .map((key) => JSON.stringify(key) + ":" + stableJson(object[key])).join(",") + "}";
  }
  return JSON.stringify(value) ?? "null";
}

function rowIdentity(row: SqliteRow): string {
  const value = row.id;
  if (typeof value === "string" || typeof value === "number") return String(value);
  return stableJson(row);
}

function isSecretColumn(name: string): boolean {
  return /secret|password|credential|token|private.?key/i.test(name);
}

function hasSecretColumn(columns: string[]): boolean {
  return columns.some(isSecretColumn);
}

function rowsForLocation(context: MigrationContext, location: DatabaseLocation, table: string): Promise<SqliteRow[]> {
  return location.workspace
    ? context.source.readWorkspaceSqliteTable(location.path, table)
    : context.source.readSqliteTable(location.path, table);
}

async function inspectLocations(context: MigrationContext): Promise<DatabaseLocation[]> {
  const paths: Array<{ id: string; path: string; workspace: boolean }> = [
    { id: PROJECT_LEGACY_ID, path: PROJECT_DATABASE, workspace: false },
  ];
  if (context.source.workspaceDataRoot) {
    paths.push({
      id: WORKSPACE_DATABASE_ID,
      path: path.posix.join("index", path.basename(context.source.projectRoot), "index.sqlite"),
      workspace: true,
    });
  }
  const locations: DatabaseLocation[] = [];
  for (const item of paths) {
    const tables = item.workspace
      ? await context.source.inspectWorkspaceSqlite(item.path)
      : await context.source.inspectSqlite(item.path);
    if (tables.length > 0) locations.push({ ...item, tables });
  }
  return locations;
}

async function planOpaqueRows(
  context: MigrationContext,
  table: string,
  location: DatabaseLocation,
  rows: SqliteRow[],
): Promise<{ entry: MigrationContribution["entries"][number]; operation?: ChangeOperation }> {
  const target = "meta/scriptorium/modules/story/legacy/sqlite/" + location.id + "/" + table + ".jsonl";
  const source = location.path + "#" + table;
  const content = rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length > 0 ? "\n" : "");
  const moduleEnabled = context.enabledModules.has("story");
  const planned = await planExactFileImport({
    context,
    producerId: "sqlite-opaque",
    source,
    target,
    category: "provisional",
    bytes: Buffer.from(content, "utf8"),
    detail: moduleEnabled
      ? "Preserve " + rows.length + " complete non-secret SQLite row(s), including every workflow status, as opaque Story legacy data. Semantic conversion remains pending for the Story migration producer."
      : "Preserve " + rows.length + " complete non-secret SQLite row(s), including every workflow status, as opaque versioned data. The Story module remains unreadable until enabled.",
    message: "Preserve opaque legacy Story SQLite rows",
  });
  if (!moduleEnabled && (planned.entry.disposition === "planned" || planned.entry.disposition === "unchanged")) {
    planned.entry.disposition = "preserved-unreadable";
    planned.entry.detail = "Preserve " + rows.length + " complete non-secret SQLite row(s), including every workflow status, as opaque versioned data. The Story module remains unreadable until enabled.";
  }
  return planned;
}

function makeEntry(input: {
  source: string;
  category: "derived" | "secret" | "relocated";
  disposition: "rebuild" | "excluded" | "unclassified";
  detail: string;
  recordCount?: number;
}) {
  return { producerId: "sqlite", ...input };
}

export function createSqliteProducer(): MigrationProducer {
  return {
    id: "sqlite",
    async inspect(context): Promise<MigrationContribution> {
      const result: MigrationContribution = { entries: [], operations: [], recovery: [] };
      let locations: DatabaseLocation[];
      try {
        locations = await inspectLocations(context);
      } catch (error) {
        result.entries.push({
          producerId: "sqlite",
          source: PROJECT_DATABASE,
          category: "relocated",
          disposition: "blocked",
          detail: "Read-only SQLite inspection failed: " + (error instanceof Error ? error.message : String(error)),
        });
        return result;
      }
      if (locations.length === 0) return result;

      const allTableNames = [...new Set(locations.flatMap(({ tables }) => tables.map(({ name }) => name)))].sort();
      for (const tableName of allTableNames) {
        const locationsWithTable = locations.filter(({ tables }) => tables.some(({ name }) => name === tableName));
        if (DERIVED_TABLES.has(tableName)) {
          for (const location of locationsWithTable) {
            result.entries.push(makeEntry({
              source: location.path + "#" + tableName,
              category: "derived",
              disposition: "rebuild",
              detail: "Rebuilt from retained manuscript, entity, correction, and model inputs; this index table is not an authoritative source.",
            }));
          }
          continue;
        }
        if (!STORY_RECORD_TABLES.has(tableName)) {
          for (const location of locationsWithTable) {
            const table = location.tables.find(({ name }) => name === tableName)!;
            const columns = table.columns.map(({ name }) => name);
            const secret = /secret|credential|token|password/i.test(tableName) || hasSecretColumn(columns);
            result.entries.push(makeEntry({
              source: location.path + "#" + tableName,
              category: secret ? "secret" : "relocated",
              disposition: secret ? "excluded" : "unclassified",
              detail: secret
                ? "Excluded table with credential-like name or fields (" + columns.join(", ") + "); rows were not read."
                : "Unclassified table with fields (" + columns.join(", ") + "); rows were not read and both legacy databases remain untouched.",
            }));
          }
          continue;
        }

        for (const location of locationsWithTable) {
          const table = location.tables.find(({ name }) => name === tableName)!;
          const secretColumns = table.columns.filter(({ name }) => isSecretColumn(name)).map(({ name }) => name);
          if (secretColumns.length > 0) {
            result.entries.push({
              producerId: "sqlite",
              source: location.path + "#" + tableName,
              category: "secret",
              disposition: "excluded",
              detail: "Credential-like SQLite fields (" + secretColumns.join(", ") + ") are omitted from imported rows; their values were not added to operations.",
            });
          }

          const secretColumnNames = new Set(secretColumns);
          const rows = await rowsForLocation(context, location, tableName);
          const safeRows = rows
            .map((row) => Object.fromEntries(Object.entries(row).filter(([name]) => !secretColumnNames.has(name))) as SqliteRow)
            .sort((a, b) => rowIdentity(a).localeCompare(rowIdentity(b)) || stableJson(a).localeCompare(stableJson(b)));
          const source = location.path + "#" + tableName;
          const target = "meta/scriptorium/modules/story/legacy/sqlite/" + location.id + "/" + tableName + ".jsonl";
          if (safeRows.length === 0) {
            result.entries.push({
              producerId: "sqlite-opaque",
              source,
              target,
              category: "provisional",
              disposition: "unchanged",
              recordCount: 0,
              detail: "The recognized Story table contains no rows; no opaque snapshot file was needed.",
            });
            continue;
          }

          const planned = await planOpaqueRows(context, tableName, location, safeRows);
          planned.entry.recordCount = safeRows.length;
          result.entries.push(planned.entry);
          if (planned.operation) result.operations.push(planned.operation);
          if (context.enabledModules.has("story")) {
            result.entries.push({
              producerId: "sqlite-story-semantic-conversion",
              source,
              category: "provisional",
              disposition: "deferred",
              recordCount: safeRows.length,
              detail: "Canonical semantic conversion remains pending in the registered Story migration producer. The opaque snapshot disposition is reported separately above; this generic producer does not reinterpret workflow statuses or merge divergent rows.",
            });
          }
        }
      }

      for (const location of locations) {
        result.entries.push({
          producerId: "sqlite",
          source: location.path,
          category: "derived",
          disposition: "rebuild",
          recordCount: location.tables.length,
          detail: "Read-only inventory of " + location.id + " database; each table is classified separately and both source database files remain untouched.",
        });
      }
      return result;
    },
  };
}
