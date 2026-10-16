import path from "node:path";
import {
  planGeneratedFileImport,
  recoveryRecord,
  type MigrationContext,
  type MigrationContribution,
  type MigrationEntry,
  type SqliteRow,
  type SqliteTableInfo,
} from "@scriptorium/migration";

const ROOT = "meta/scriptorium/modules/story";
const SQLITE_LEGACY = `${ROOT}/legacy/sqlite`;
const STATE_PROPOSALS_PATH = `${ROOT}/state-proposals.jsonl`;
const ZUKAN_SUGGESTIONS_PATH = `${ROOT}/zukan-suggestions.jsonl`;
const WORKFLOW_TABLES = ["state_proposals", "zukan_suggestions"] as const;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

type WorkflowTable = (typeof WORKFLOW_TABLES)[number];
type PlainRecord = Record<string, unknown>;
type RowOrigin = { databaseId: string; databasePath: string; row: PlainRecord };

function isRecord(value: unknown): value is PlainRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (isRecord(value)) return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonical(value[key])]),
  );
  return value;
}

function stableJson(value: unknown): string {
  return JSON.stringify(canonical(value));
}

function stripCredentialColumns(row: SqliteRow): PlainRecord {
  return Object.fromEntries(Object.entries(row).filter(([name]) =>
    !/secret|password|credential|token|private.?key/i.test(name),
  ));
}

function sourceLabel(databasePath: string, table: WorkflowTable): string {
  return `${databasePath}#${table}`;
}

function sourceLocations(context: MigrationContext): Array<{
  databaseId: string;
  databasePath: string;
  workspace: boolean;
}> {
  const locations = [{
    databaseId: "project-arcadia",
    databasePath: ".arcadia/index.sqlite",
    workspace: false,
  }];
  if (context.source.workspaceDataRoot) {
    locations.push({
      databaseId: "workspace-index",
      databasePath: path.posix.join("index", path.posix.basename(context.source.projectRoot), "index.sqlite"),
      workspace: true,
    });
  }
  return locations;
}

async function inspectTables(context: MigrationContext, location: ReturnType<typeof sourceLocations>[number]): Promise<SqliteTableInfo[]> {
  return location.workspace
    ? context.source.inspectWorkspaceSqlite(location.databasePath)
    : context.source.inspectSqlite(location.databasePath);
}

async function readTable(context: MigrationContext, location: ReturnType<typeof sourceLocations>[number], table: WorkflowTable): Promise<SqliteRow[]> {
  return location.workspace
    ? context.source.readWorkspaceSqliteTable(location.databasePath, table)
    : context.source.readSqliteTable(location.databasePath, table);
}

function sqliteRowId(row: PlainRecord, label: string): string {
  if (typeof row.id !== "string" || !row.id) throw new TypeError(`${label} row is missing a stable string ID`);
  return row.id;
}

function requiredString(row: PlainRecord, key: string, label: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new TypeError(`${label}.${key} must be a string`);
  return value;
}

function parseJson(value: unknown, label: string): unknown {
  if (typeof value !== "string") throw new TypeError(`${label} must be a JSON string`);
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new TypeError(`${label} is malformed JSON`);
  }
}

function migrationSource(origins: readonly RowOrigin[], table: WorkflowTable) {
  const bySource = new Map<string, { databaseId: string; databasePath: string; table: WorkflowTable }>();
  for (const origin of origins) {
    const key = `${origin.databaseId}:${origin.databasePath}:${table}`;
    bySource.set(key, { databaseId: origin.databaseId, databasePath: origin.databasePath, table });
  }
  return { databaseSources: [...bySource.values()].sort((a, b) =>
    a.databaseId.localeCompare(b.databaseId) || a.databasePath.localeCompare(b.databasePath),
  ) };
}

function convertStateProposal(origin: RowOrigin, all: readonly RowOrigin[]): PlainRecord {
  const row = origin.row;
  const label = `state_proposals:${sqliteRowId(row, "state_proposals")}`;
  requiredString(row, "scene_id", label);
  const event = parseJson(row.event_json, `${label}.event_json`);
  const conflicts = parseJson(row.conflict_event_ids_json, `${label}.conflict_event_ids_json`);
  const history = parseJson(row.history_json, `${label}.history_json`);
  if (!isRecord(event) || !Array.isArray(conflicts) || !conflicts.every((item) => typeof item === "string") || !Array.isArray(history) || !history.every(isRecord)) {
    throw new TypeError(`${label} has invalid event, conflict, or history data`);
  }
  requiredString(row, "manuscript_hash", label);
  if (!new Set(["proposed", "stale", "approved", "rejected"]).has(String(row.status))) throw new TypeError(`${label}.status is unsupported`);
  if (row.duplicate_of_proposal_id !== null && typeof row.duplicate_of_proposal_id !== "string") throw new TypeError(`${label}.duplicate_of_proposal_id is invalid`);
  requiredString(row, "created_at", label);
  requiredString(row, "updated_at", label);
  return { ...row, migrationSource: migrationSource(all, "state_proposals") };
}

function convertZukanSuggestion(origin: RowOrigin, all: readonly RowOrigin[]): PlainRecord {
  const row = origin.row;
  const label = `zukan_suggestions:${sqliteRowId(row, "zukan_suggestions")}`;
  const evidence = parseJson(row.evidence_json, `${label}.evidence_json`);
  const turnRange = row.source_turn_range_json === null
    ? null
    : parseJson(row.source_turn_range_json, `${label}.source_turn_range_json`);
  if (!Array.isArray(evidence) || !evidence.every((item) => isRecord(item) && typeof item.quote === "string" && item.quote.length > 0 && (item.sceneId === undefined || typeof item.sceneId === "string"))) {
    throw new TypeError(`${label}.evidence_json must contain source quotes`);
  }
  if (turnRange !== null && (!isRecord(turnRange) || !Number.isInteger(turnRange.start) || !Number.isInteger(turnRange.end) || Number(turnRange.start) < 0 || Number(turnRange.end) < Number(turnRange.start))) {
    throw new TypeError(`${label}.source_turn_range_json is invalid`);
  }
  const entityId = requiredString(row, "entity_id", label);
  const blockPath = requiredString(row, "block_path", label);
  const proposedText = requiredString(row, "proposed_text", label);
  const status = requiredString(row, "status", label);
  const source = requiredString(row, "source", label);
  const kind = row.kind;
  const sourceSessionId = row.source_session_id;
  const confidence = row.confidence;
  const createdAt = requiredString(row, "created_at", label);
  const updatedAt = requiredString(row, "updated_at", label);
  if (!new Set(["pending", "approved", "rejected", "stale"]).has(status)) throw new TypeError(`${label}.status is unsupported`);
  if (!new Set(["manuscript", "sandbox"]).has(source)) throw new TypeError(`${label}.source is unsupported`);
  if (kind !== null && !new Set(["fact", "dynamic", "habit"]).has(String(kind))) throw new TypeError(`${label}.kind is unsupported`);
  if (sourceSessionId !== null && typeof sourceSessionId !== "string") throw new TypeError(`${label}.source_session_id is invalid`);
  if (confidence !== null && !new Set(["high", "low", "none"]).has(String(confidence))) throw new TypeError(`${label}.confidence is unsupported`);
  return {
    ...row,
    entityId,
    blockPath,
    proposedText,
    evidence,
    sourceSessionId,
    sourceTurnRange: turnRange,
    createdAt,
    updatedAt,
    migrationSource: migrationSource(all, "zukan_suggestions"),
  };
}

function parseSnapshotRows(content: string, source: string): PlainRecord[] {
  return content.split(/\r?\n/).filter((line) => line.trim()).map((line, index) => {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new TypeError(`${source} JSONL row ${index + 1} is malformed`);
    }
    if (!isRecord(value)) throw new TypeError(`${source} JSONL row ${index + 1} must be an object`);
    return value;
  });
}

async function collectRows(context: MigrationContext, table: WorkflowTable): Promise<{
  origins: RowOrigin[];
  exists: boolean;
}> {
  const origins: RowOrigin[] = [];
  let exists = false;
  for (const location of sourceLocations(context)) {
    const tables = await inspectTables(context, location);
    if (!tables.some((item) => item.name === table)) continue;
    exists = true;
    for (const row of await readTable(context, location, table)) {
      origins.push({ databaseId: location.databaseId, databasePath: location.databasePath, row: stripCredentialColumns(row) });
    }
  }

  const snapshots = await context.target.list(SQLITE_LEGACY);
  const pattern = new RegExp(`^${SQLITE_LEGACY}/([^/]+)/${table}\\.jsonl$`);
  for (const snapshotPath of [...snapshots].sort((a, b) => a.localeCompare(b))) {
    const match = pattern.exec(snapshotPath);
    if (!match) continue;
    const content = await context.target.read(snapshotPath);
    if (!content) continue;
    exists = true;
    const location = sourceLocations(context).find((item) => item.databaseId === match[1]);
    const databasePath = location?.databasePath ?? snapshotPath;
    for (const row of parseSnapshotRows(content.content, snapshotPath)) {
      origins.push({ databaseId: match[1]!, databasePath, row });
    }
  }
  return { origins, exists };
}

function mergeRows(origins: RowOrigin[], table: WorkflowTable): {
  rows: RowOrigin[][];
  conflicts: RowOrigin[][];
} {
  const byId = new Map<string, RowOrigin[]>();
  for (const origin of origins) {
    const id = sqliteRowId(origin.row, table);
    const group = byId.get(id) ?? [];
    group.push(origin);
    byId.set(id, group);
  }
  const rows: RowOrigin[][] = [];
  const conflicts: RowOrigin[][] = [];
  const sortedGroups = [...byId.values()].map((items) => items.sort((a, b) =>
    a.databaseId.localeCompare(b.databaseId) || a.databasePath.localeCompare(b.databasePath),
  )).sort((a, b) => sqliteRowId(a[0]!.row, table).localeCompare(sqliteRowId(b[0]!.row, table)));
  for (const group of sortedGroups) {
    const baseline = stableJson(group[0]!.row);
    if (group.some((item) => stableJson(item.row) !== baseline)) conflicts.push(group);
    else rows.push(group);
  }
  return { rows, conflicts };
}

function dispositionEntry(input: {
  table: WorkflowTable;
  target: string;
  category: "authoritative" | "provisional";
  disposition: MigrationEntry["disposition"];
  recordCount: number;
  detail: string;
}): MigrationEntry {
  return {
    producerId: "story-v1",
    source: `sqlite#${input.table}`,
    target: input.target,
    category: input.category,
    disposition: input.disposition,
    recordCount: input.recordCount,
    detail: input.detail,
  };
}

async function planWorkflowTable(
  context: MigrationContext,
  table: WorkflowTable,
  collected: Awaited<ReturnType<typeof collectRows>>,
): Promise<MigrationContribution> {
  const target = table === "state_proposals" ? STATE_PROPOSALS_PATH : ZUKAN_SUGGESTIONS_PATH;
  const result: MigrationContribution = { entries: [], operations: [], recovery: [] };
  if (!collected.exists) return result;
  const { rows: merged, conflicts } = mergeRows(collected.origins, table);
  const sourceRecords: PlainRecord[] = [];
  try {
    for (const group of merged) {
      const first = group[0]!;
      sourceRecords.push(table === "state_proposals"
        ? convertStateProposal(first, group)
        : convertZukanSuggestion(first, group));
    }
  } catch (error) {
    result.entries.push(dispositionEntry({
      table,
      target,
      category: "provisional",
      disposition: "blocked",
      recordCount: merged.length,
      detail: `Story could not convert one or more ${table} rows into its runtime record schema; the complete raw rows remain in the SQLite legacy snapshots: ${error instanceof Error ? error.message : String(error)}`,
    }));
    for (const group of conflicts) {
      for (const item of group) result.recovery.push(recoveryRecord({
        producerId: "story-v1-workflow-conflict",
        source: sourceLabel(item.databasePath, table),
        content: JSON.stringify({ sourceDatabase: item.databaseId, sourceTable: table, record: item.row }),
        encoding: "utf8",
        stableId: `${item.databaseId}:${table}:${String(item.row.id)}`,
        detail: "Divergent workflow rows are withheld from canonical Story state for author review.",
      }));
    }
    return result;
  }
  for (const group of conflicts) {
    const id = sqliteRowId(group[0]!.row, table);
    result.entries.push(dispositionEntry({
      table,
      target,
      category: "provisional",
      disposition: "conflict",
      recordCount: group.length,
      detail: `Workflow row ${id} has divergent values across legacy databases; no version was selected for canonical Story state.`,
    }));
    for (const item of group) result.recovery.push(recoveryRecord({
      producerId: "story-v1-workflow-conflict",
      source: sourceLabel(item.databasePath, table),
      content: JSON.stringify({ sourceDatabase: item.databaseId, sourceTable: table, record: item.row }),
      encoding: "utf8",
      stableId: `${item.databaseId}:${table}:${id}`,
      detail: "Divergent workflow row preserved for explicit author review; no approval or rejection was inferred.",
    }));
  }

  const existing = await context.target.read(target);
  const existingRows = existing ? parseSnapshotRows(existing.content, target) : [];
  const existingById = new Map<string, string>();
  try {
    for (const row of existingRows) existingById.set(sqliteRowId(row, target), stableJson(row));
  } catch (error) {
    result.entries.push(dispositionEntry({
      table,
      target,
      category: "authoritative",
      disposition: "conflict",
      recordCount: sourceRecords.length,
      detail: `Existing Story workflow JSONL cannot be read safely: ${error instanceof Error ? error.message : String(error)}.`,
    }));
    return result;
  }
  const additions: PlainRecord[] = [];
  for (const row of sourceRecords) {
    const id = sqliteRowId(row, table);
    const prior = existingById.get(id);
    const next = stableJson(row);
    if (prior !== undefined && prior !== next) {
      result.entries.push(dispositionEntry({
        table,
        target,
        category: "authoritative",
        disposition: "conflict",
        recordCount: 1,
        detail: `Story workflow ID ${id} already exists with different target data; no source row was selected or overwritten.`,
      }));
      return result;
    }
    if (prior === undefined) additions.push(row);
  }

  let disposition: MigrationEntry["disposition"] = "unchanged";
  if (additions.length) {
    const content = (existing?.content ?? "") + (existing?.content && !existing.content.endsWith("\n") ? "\n" : "")
      + additions.map(stableJson).join("\n") + "\n";
    if (Buffer.byteLength(content, "utf8") > MAX_OUTPUT_BYTES) {
      disposition = "blocked";
    } else {
      const planned = await planGeneratedFileImport({
        context,
        producerId: "story-v1-workflow",
        source: `sqlite#${table}`,
        target,
        category: "authoritative",
        content,
        detail: `Convert ${additions.length} source ${table} row(s) to Story runtime JSONL. Every workflow status is retained; pending/proposed records remain provisional and no state is approved automatically.`,
        message: `Import Story ${table} workflow records`,
        existing,
      });
      disposition = planned.entry.disposition;
      if (planned.operation) result.operations.push(planned.operation);
    }
  }

  const decisions = sourceRecords.filter((row) => row.status === "approved" || row.status === "rejected").length;
  const provisional = sourceRecords.length - decisions;
  if (decisions > 0) result.entries.push(dispositionEntry({
    table,
    target,
    category: "authoritative",
    disposition,
    recordCount: decisions,
    detail: "Approved/rejected source decisions retain their original workflow status, full non-secret row data, unknown fields, and source database provenance.",
  }));
  if (provisional > 0 || decisions === 0) result.entries.push(dispositionEntry({
    table,
    target,
    category: "provisional",
    disposition,
    recordCount: provisional,
    detail: "Pending/proposed/stale workflow rows retain their source status and remain available for author review; migration does not auto-approve them.",
  }));
  if (collected.origins.length === 0) result.entries.push(dispositionEntry({
    table,
    target,
    category: "provisional",
    disposition: "unchanged",
    recordCount: 0,
    detail: "The legacy database table exists but contains no workflow rows.",
  }));
  return result;
}

/** Convert retained legacy Story workflow tables into the JSONL records consumed by Story actions. */
export async function planStorySqliteWorkflow(context: MigrationContext): Promise<MigrationContribution> {
  const result: MigrationContribution = { entries: [], operations: [], recovery: [] };
  if (!context.enabledModules.has("story")) return result;
  for (const table of WORKFLOW_TABLES) {
    try {
      const collected = await collectRows(context, table);
      const planned = await planWorkflowTable(context, table, collected);
      result.entries.push(...planned.entries);
      result.operations.push(...planned.operations);
      result.recovery.push(...planned.recovery);
    } catch (error) {
      result.entries.push(dispositionEntry({
        table,
        target: table === "state_proposals" ? STATE_PROPOSALS_PATH : ZUKAN_SUGGESTIONS_PATH,
        category: "provisional",
        disposition: "blocked",
        recordCount: 0,
        detail: `Read-only legacy workflow inspection failed; source data remains untouched: ${error instanceof Error ? error.message : String(error)}.`,
      }));
    }
  }
  return result;
}
