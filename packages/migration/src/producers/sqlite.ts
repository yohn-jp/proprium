import path from "node:path";
import { createHash } from "node:crypto";
import type { ChangeOperation, ModuleId } from "@scriptorium/contracts";
import type {
  MigrationContext,
  MigrationContribution,
  MigrationProducer,
  SqliteRow,
  SqliteTableInfo,
} from "../types.js";
import { planExactFileImport, planGeneratedFileImport, recoveryRecord } from "../operations.js";

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

const PROPOSAL_TABLES = new Map<string, { target: string; moduleId: ModuleId }>([
  ["state_proposals", { target: "meta/scriptorium/modules/story/state-proposals.jsonl", moduleId: "story" }],
  ["zukan_suggestions", { target: "meta/scriptorium/modules/story/zukan-suggestions.jsonl", moduleId: "story" }],
]);

interface DatabaseLocation {
  id: string;
  path: string;
  workspace: boolean;
  tables: SqliteTableInfo[];
}

interface LocatedRow {
  location: DatabaseLocation;
  row: SqliteRow;
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
  return createHash("sha256").update(stableJson(row)).digest("hex");
}

function isDecisionRecord(row: SqliteRow): boolean {
  return row.status === "approved" || row.status === "rejected";
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

function mergeLocatedRows(records: LocatedRow[]): { rows: SqliteRow[]; conflicts: LocatedRow[][] } {
  const byId = new Map<string, LocatedRow>();
  const conflicts = new Map<string, LocatedRow[]>();
  const sorted = [...records].sort((a, b) =>
    a.location.id.localeCompare(b.location.id) || rowIdentity(a.row).localeCompare(rowIdentity(b.row)));
  for (const record of sorted) {
    const id = rowIdentity(record.row);
    const conflictRecords = conflicts.get(id);
    if (conflictRecords) {
      conflictRecords.push(record);
      continue;
    }
    const prior = byId.get(id);
    if (!prior) byId.set(id, record);
    else if (stableJson(prior.row) !== stableJson(record.row)) {
      byId.delete(id);
      conflicts.set(id, [prior, record]);
    }
  }
  return {
    rows: [...byId.values()].map(({ row }) => row).sort((a, b) => rowIdentity(a).localeCompare(rowIdentity(b))),
    conflicts: [...conflicts.values()],
  };
}

function conflictTarget(table: string, record: LocatedRow): string {
  const hashedId = createHash("sha256").update(rowIdentity(record.row)).digest("hex").slice(0, 24);
  return "meta/scriptorium/modules/story/legacy/sqlite-conflicts/" + table + "/" + hashedId + "." + record.location.id + ".json";
}

async function preserveConflictingRows(
  context: MigrationContext,
  table: string,
  groups: LocatedRow[][],
): Promise<ChangeOperation[]> {
  const operations: ChangeOperation[] = [];
  for (const group of groups) {
    for (const record of group) {
      const content = JSON.stringify({ sourceDatabase: record.location.id, sourceTable: table, record: record.row }) + "\n";
      const planned = await planGeneratedFileImport({
        context,
        producerId: "sqlite-conflict",
        source: record.location.path + "#" + table + ":" + rowIdentity(record.row),
        target: conflictTarget(table, record),
        category: "authoritative",
        content,
        detail: "Preserve one divergent source row for explicit author comparison; it was withheld from automatic canonical merge.",
        message: "Preserve divergent legacy database record",
      });
      if (planned.operation) operations.push(planned.operation);
    }
  }
  return operations;
}

async function planCanonicalRows(
  context: MigrationContext,
  table: string,
  target: string,
  rows: SqliteRow[],
): Promise<{ entry: MigrationContribution["entries"][number]; operation?: ChangeOperation }> {
  const existing = await context.target.read(target);
  const originalLines = existing?.content.split("\n").filter((line) => line.trim().length > 0) ?? [];
  const byId = new Map<string, string>();
  try {
    for (const line of originalLines) {
      const value: unknown = JSON.parse(line);
      if (!value || typeof value !== "object") throw new Error("invalid JSONL row");
      const record = value as Record<string, unknown>;
      if (typeof record.id !== "string" && typeof record.id !== "number") throw new Error("missing ID");
      byId.set(String(record.id), stableJson(record));
    }
  } catch {
    return {
      entry: {
        producerId: "sqlite",
        source: table,
        target,
        category: "authoritative",
        disposition: "conflict",
        recordCount: rows.length,
        detail: "Existing target JSONL is malformed or has no stable IDs; no target content was overwritten.",
      },
    };
  }

  const additions: SqliteRow[] = [];
  for (const row of rows) {
    const id = rowIdentity(row);
    const canonical = stableJson(row);
    const prior = byId.get(id);
    if (prior !== undefined && prior !== canonical) {
      return {
        entry: {
          producerId: "sqlite",
          source: table + ":" + id,
          target,
          category: "authoritative",
          disposition: "conflict",
          recordCount: rows.length,
          detail: "Target record " + id + " differs from the source row; the producer withheld all writes for this table.",
        },
      };
    }
    if (prior === undefined) {
      additions.push(row);
      byId.set(id, canonical);
    }
  }
  if (additions.length === 0) {
    return {
      entry: {
        producerId: "sqlite",
        source: table,
        target,
        category: "authoritative",
        disposition: "unchanged",
        recordCount: rows.length,
        detail: "Every stable record ID already exists with matching complete SQLite row data.",
      },
    };
  }
  const content = (existing?.content ?? "") + (existing?.content && !existing.content.endsWith("\n") ? "\n" : "")
    + additions.map((row) => JSON.stringify(row)).join("\n") + "\n";
  return planGeneratedFileImport({
    context,
    producerId: "sqlite",
    source: table,
    target,
    category: "authoritative",
    content,
    detail: "Preserve " + additions.length + " approved decision record(s) with stable IDs and all original SQLite columns.",
    message: "Import legacy " + table + " decisions",
    existing,
  });
}

async function planOpaqueRows(
  context: MigrationContext,
  table: string,
  moduleId: ModuleId,
  location: DatabaseLocation,
  rows: SqliteRow[],
  category: "authoritative" | "provisional",
): Promise<{ entry: MigrationContribution["entries"][number]; operation?: ChangeOperation }> {
  const target = "meta/scriptorium/modules/" + moduleId + "/legacy/sqlite/" + location.id + "/" + table + "." + category + ".jsonl";
  const source = location.path + "#" + table;
  const content = rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length > 0 ? "\n" : "");
  const planned = await planExactFileImport({
    context,
    producerId: "sqlite-disabled",
    source,
    target,
    category,
    bytes: Buffer.from(content, "utf8"),
    detail: "Preserve " + rows.length + " complete SQLite row(s) as versioned opaque data. The " + moduleId + " module remains unreadable until enabled.",
    message: "Preserve disabled " + moduleId + " legacy database records",
  });
  if (planned.entry.disposition === "planned" || planned.entry.disposition === "unchanged") {
    planned.entry.disposition = "preserved-unreadable";
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
      const rowCache = new Map<string, SqliteRow[]>();
      const allLocatedRows = async (table: string): Promise<LocatedRow[]> => {
        const found: LocatedRow[] = [];
        for (const location of locations) {
          if (!location.tables.some(({ name }) => name === table)) continue;
          const key = location.id + "\0" + table;
          let rows = rowCache.get(key);
          if (!rows) {
            rows = await rowsForLocation(context, location, table);
            const tableInfo = location.tables.find(({ name }) => name === table)!;
            const secretColumns = new Set(tableInfo.columns.filter(({ name }) => isSecretColumn(name)).map(({ name }) => name));
            if (secretColumns.size > 0) {
              rows = rows.map((row) => Object.fromEntries(Object.entries(row).filter(([name]) => !secretColumns.has(name))));
            }
            rows.sort((a, b) => rowIdentity(a).localeCompare(rowIdentity(b)));
            rowCache.set(key, rows);
          }
          found.push(...rows.map((row) => ({ location, row })));
        }
        return found;
      };

      for (const tableName of allTableNames) {
        const proposal = PROPOSAL_TABLES.get(tableName);
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
        if (!proposal) {
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
        }

        const locatedRows = await allLocatedRows(tableName);
        const merged = mergeLocatedRows(locatedRows);
        if (!context.enabledModules.has(proposal.moduleId)) {
          for (const location of locationsWithTable) {
            const sourceRows = locatedRows.filter(({ location: owner }) => owner.id === location.id).map(({ row }) => row);
            const decisions = sourceRows.filter(isDecisionRecord);
            const pending = sourceRows.filter((row) => !isDecisionRecord(row));
            for (const [rows, category] of [[decisions, "authoritative"], [pending, "provisional"]] as const) {
              if (rows.length === 0) continue;
              const opaque = await planOpaqueRows(context, tableName, proposal.moduleId, location, rows, category);
              if (opaque.entry.disposition === "preserved-unreadable" && rows.every(isDecisionRecord)) {
                opaque.entry.detail = "Preserve " + rows.length + " approved SQLite row(s) as opaque versioned data; " + proposal.moduleId + " remains unreadable until enabled.";
              }
              result.entries.push(opaque.entry);
              if (opaque.operation) result.operations.push(opaque.operation);
            }
            if (sourceRows.length === 0) {
              result.entries.push({
                producerId: "sqlite",
                source: location.path + "#" + tableName,
                target: "meta/scriptorium/modules/" + proposal.moduleId + "/legacy/sqlite/" + location.id + "/" + tableName,
                category: "provisional",
                disposition: "unchanged",
                recordCount: 0,
                detail: "Proposal table exists but contains no records.",
              });
            }
          }
          for (const conflict of merged.conflicts) {
            result.entries.push({
              producerId: "sqlite",
              source: locationsWithTable.map((location) => location.path).join(",") + "#" + tableName + ":" + rowIdentity(conflict[0]!.row),
              category: "authoritative",
              disposition: "conflict",
              recordCount: conflict.length,
              detail: "Same stable record ID has divergent rows across legacy databases. Both database-specific opaque copies were retained; author review is required before module conversion.",
            });
          }
          continue;
        }

        const decisions = merged.rows.filter(isDecisionRecord);
        const pending = locatedRows.filter(({ row }) => !isDecisionRecord(row));
        const source = locationsWithTable.map((location) => location.path).join(",") + "#" + tableName;
        if (decisions.length > 0) {
          const planned = await planCanonicalRows(context, tableName, proposal.target, decisions);
          planned.entry.source = source;
          result.entries.push(planned.entry);
          if (planned.operation) result.operations.push(planned.operation);
        }
        if (pending.length > 0) {
          result.entries.push({
            producerId: "sqlite",
            source,
            target: proposal.target,
            category: "provisional",
            disposition: "deferred",
            recordCount: pending.length,
            detail: "Unaccepted proposal rows are returned as local recovery records and remain outside canonical author decisions until resolved.",
          });
          for (const { location, row } of pending.sort((a, b) =>
            a.location.id.localeCompare(b.location.id) || rowIdentity(a.row).localeCompare(rowIdentity(b.row)))) {
            const id = rowIdentity(row);
            result.recovery.push(recoveryRecord({
              producerId: "sqlite-" + tableName,
              source: location.path + "#" + tableName + ":" + id,
              content: JSON.stringify({ sourceDatabase: location.id, sourceTable: tableName, record: row }),
              encoding: "utf8",
              stableId: location.id + ":" + id,
              detail: "Unaccepted proposal retained for same-origin author review.",
            }));
          }
        }
        for (const conflict of merged.conflicts) {
          result.entries.push({
            producerId: "sqlite",
            source: locationsWithTable.map((location) => location.path).join(",") + "#" + tableName + ":" + rowIdentity(conflict[0]!.row),
            category: "authoritative",
            disposition: "conflict",
            recordCount: conflict.length,
            detail: "Same stable record ID has divergent rows across legacy databases. Divergent records were preserved in database-specific review files; no version was automatically selected.",
          });
          const preserved = await preserveConflictingRows(context, tableName, [conflict]);
          result.operations.push(...preserved);
        }
        if (locatedRows.length === 0) {
          result.entries.push({
            producerId: "sqlite",
            source,
            target: proposal.target,
            category: "provisional",
            disposition: "unchanged",
            recordCount: 0,
            detail: "Proposal table exists but contains no records.",
          });
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
