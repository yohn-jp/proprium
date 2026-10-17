import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import {
  type ActionResult,
} from "@scriptorium/contracts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { McpApiError, type McpActionClient } from "./api-client.js";
import { narrativeChangeSetSchema } from "./change-set-schema.js";
import {
  createMcpWritingContext,
  McpWritingContextInputError,
  mcpWritingContextSelectionSchema,
} from "./context-manifest.js";

const projectIdSchema = z.string().min(1).max(256).optional().describe("Registered project ID");
const sceneIdSchema = z.string().min(1).max(256);
const operationIdSchema = z.string().regex(/^[a-zA-Z0-9._:-]{1,128}$/);

type JsonRecord = Record<string, unknown>;
const AUTHOR_OPERATION_ACTIONS = new Set([
  "core.approve",
  "core.checkpoint",
  "core.reconcile",
  "core.publish",
  "core.apply",
  "core.sync",
]);
const toolCancellation = new AsyncLocalStorage<AbortSignal>();

class ToolFailure extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ToolFailure";
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function errorResult(code: string, message: string, details?: unknown) {
  const error = {
    code,
    message: message.slice(0, 512),
    ...(details === undefined ? {} : { details }),
  };
  return {
    isError: true,
    structuredContent: { error },
    content: [{ type: "text" as const, text: JSON.stringify(error) }],
  };
}

async function unavailableModuleAction(
  client: McpActionClient,
  moduleId: string,
  toolName: string,
) {
  const actions = await client.listActions();
  const installed = actions.some((action) => action.module === moduleId);
  return errorResult(
    installed ? "ACTION_UNAVAILABLE" : "MODULE_UNAVAILABLE",
    installed
      ? `The ${moduleId} module does not currently expose the source capability for ${toolName}`
      : `Enable the ${moduleId} module to use ${toolName}`,
  );
}

function outputResult(data: unknown, snapshot?: unknown, proposals?: unknown[]) {
  const output = {
    ...(snapshot === undefined ? {} : { snapshot }),
    data,
    ...(proposals?.length ? { proposals } : {}),
  };
  return {
    structuredContent: output,
    content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }],
  };
}

function actionResult(result: ActionResult) {
  if (!result.ok) return errorResult(result.error.code, result.error.message);
  return outputResult(result.data, result.snapshot, result.proposals);
}

function sameSnapshot(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function requireSameSnapshot(left: unknown, right: unknown): void {
  if (!sameSnapshot(left, right)) {
    throw new ToolFailure("STALE_PRECONDITION", "Project snapshot changed while the MCP tool was running");
  }
}

function apiError(error: unknown) {
  if (error instanceof McpApiError) return errorResult(error.code, error.message);
  if (error instanceof ToolFailure) return errorResult(error.code, error.message);
  if (error instanceof McpWritingContextInputError) return errorResult("INVALID_INPUT", error.message);
  return errorResult("INTERNAL_ERROR", "MCP tool failed");
}

function guarded<TArgs>(handler: (args: TArgs) => Promise<ReturnType<typeof errorResult> | ReturnType<typeof outputResult> | ReturnType<typeof structuredRecord>>) {
  return async (args: TArgs, extra: { signal: AbortSignal }) => toolCancellation.run(extra.signal, async () => {
    try {
      return await handler(args);
    } catch (error) {
      if (extra.signal.aborted) throw error;
      return apiError(error);
    }
  });
}

function signalAwareClient(client: McpActionClient): McpActionClient {
  const signal = () => toolCancellation.getStore();
  const wrapped: McpActionClient = {
    get projectId() {
      return client.projectId;
    },
    listActions: () => client.listActions(signal()),
    invoke: (actionId, input) => client.invoke(actionId, input, signal()),
    propose: (operations, evidence, proposalId) => client.propose(operations, evidence, proposalId, signal()),
    forProject(projectId) {
      if (!client.forProject) {
        if (client.projectId && client.projectId !== projectId) {
          throw new ToolFailure("PROJECT_SCOPE_MISMATCH", "The requested project does not match this MCP session");
        }
        return wrapped;
      }
      return signalAwareClient(client.forProject(projectId));
    },
  };
  if (client.listProjects) {
    wrapped.listProjects = () => client.listProjects!(signal());
  }
  return wrapped;
}

function scopedClient(client: McpActionClient, requestedProjectId?: string): McpActionClient {
  const projectId = requestedProjectId || client.projectId;
  if (!projectId) throw new ToolFailure("INVALID_PROJECT", "Pass project_id or set SCRIPTORIUM_PROJECT_ID");
  if (client.forProject) return client.forProject(projectId);
  if (client.projectId && client.projectId !== projectId) {
    throw new ToolFailure("PROJECT_SCOPE_MISMATCH", "The requested project does not match this MCP session");
  }
  return client;
}

function byteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

function coreProposalIdForChangeSet(sourceId: string): string {
  if (/^[A-Za-z0-9_-]{1,128}$/u.test(sourceId)) return sourceId;
  return `story-cs-${createHash("sha256").update(sourceId, "utf8").digest("hex")}`;
}

interface NarrativeChangeSetDetails {
  sourceChangeSet: JsonRecord & { id: string; projectId: string; operations: JsonRecord[] };
  sourceFingerprint: string;
  submittedAt: string;
  coreProposalId: string;
  operationMap: Record<string, string>;
  resultIds: Record<string, string>;
  resultPaths: Record<string, string[]>;
  resultRevisions: Record<string, string>;
  affectedEntities: Record<string, Array<{ id: string; revision: string }>>;
}

function stringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((item) => typeof item === "string");
}

function sourceChangeSetDetails(value: unknown): NarrativeChangeSetDetails | undefined {
  if (!isRecord(value) || !isRecord(value.proposal) || !Array.isArray(value.proposal.evidence)) return undefined;
  const identity = value.proposal.evidence.find(
    (item) => isRecord(item) && item.kind === "source.narrative-change-set.v1",
  );
  if (!identity) return undefined;
  if (!isRecord(identity) || !isRecord(identity.details)) {
    throw new ToolFailure("INVALID_RESPONSE", "Story proposal source ChangeSet evidence is invalid");
  }
  const details = identity.details;
  const changeSet = details.sourceChangeSet;
  if (
    !isRecord(changeSet) ||
    typeof changeSet.id !== "string" ||
    typeof changeSet.projectId !== "string" ||
    !Array.isArray(changeSet.operations) ||
    !changeSet.operations.every(isRecord) ||
    typeof details.sourceFingerprint !== "string" ||
    !/^[a-f0-9]{64}$/u.test(details.sourceFingerprint) ||
    typeof details.submittedAt !== "string" ||
    Number.isNaN(Date.parse(details.submittedAt)) ||
    typeof details.coreProposalId !== "string" ||
    !stringRecord(details.operationMap) ||
    !stringRecord(details.resultIds) ||
    !isRecord(details.resultPaths) ||
    !isRecord(details.resultRevisions) ||
    !isRecord(details.affectedEntities)
  ) {
    throw new ToolFailure("INVALID_RESPONSE", "Story proposal source ChangeSet evidence is invalid");
  }
  const resultPaths = details.resultPaths as Record<string, unknown>;
  for (const operation of changeSet.operations) {
    const operationPaths = resultPaths[operation.id as string];
    if (
      typeof operation.id !== "string" ||
      typeof operation.kind !== "string" ||
      typeof details.operationMap[operation.id] !== "string" ||
      typeof details.resultIds[operation.id] !== "string" ||
      typeof details.resultRevisions[operation.id] !== "string" ||
      !Array.isArray(operationPaths) ||
      !operationPaths.every((path: unknown) => typeof path === "string")
    ) {
      throw new ToolFailure("INVALID_RESPONSE", "Story proposal source operation identity is incomplete");
    }
  }
  return details as unknown as NarrativeChangeSetDetails;
}

function changeSetRecordFromProposalStatus(value: unknown): Record<string, unknown> | undefined {
  const details = sourceChangeSetDetails(value);
  if (!details) return undefined;
  if (!isRecord(value) || !isRecord(value.proposal)) {
    throw new ToolFailure("INVALID_RESPONSE", "Core proposal status is invalid");
  }
  const proposal = value.proposal;
  if (proposal.id !== details.coreProposalId || details.coreProposalId !== coreProposalIdForChangeSet(details.sourceChangeSet.id)) {
    throw new ToolFailure("INVALID_RESPONSE", "Core proposal ID does not match its source ChangeSet identity");
  }
  if (!Array.isArray(proposal.operations) || !Array.isArray(value.approvedOperationIds) || !Array.isArray(value.checkpoints)) {
    throw new ToolFailure("INVALID_RESPONSE", "Core proposal status is missing review details");
  }

  const sourceOperations = details.sourceChangeSet.operations;
  const sourceByCoreId = new Map<string, JsonRecord>();
  const coreOperations = new Map<string, JsonRecord>();
  for (const operation of proposal.operations) {
    if (isRecord(operation) && typeof operation.id === "string") coreOperations.set(operation.id, operation);
  }
  for (const sourceOperation of sourceOperations) {
    const sourceId = sourceOperation.id as string;
    const coreId = details.operationMap[sourceId]!;
    const operation = coreOperations.get(coreId);
    if (!operation || !Array.isArray(operation.writes)) {
      throw new ToolFailure("INVALID_RESPONSE", "Core proposal does not preserve the source operation map");
    }
    const writes = operation.writes as unknown[];
    const corePaths = writes.map((write) => isRecord(write) ? write.path : undefined);
    const expectedPaths = details.resultPaths[sourceId]!;
    if (corePaths.some((path) => typeof path !== "string") || JSON.stringify(corePaths) !== JSON.stringify(expectedPaths)) {
      throw new ToolFailure("INVALID_RESPONSE", "Story source result paths do not match the Core proposal");
    }
    sourceByCoreId.set(coreId, sourceOperation);
  }

  const approved = new Set<string>();
  for (const operationId of value.approvedOperationIds) {
    if (typeof operationId !== "string" || !sourceByCoreId.has(operationId)) {
      throw new ToolFailure("INVALID_RESPONSE", "Core proposal approval references an unknown source operation");
    }
    approved.add(operationId);
  }
  const checkpointed = new Map<string, JsonRecord>();
  for (const receipt of value.checkpoints) {
    if (!isRecord(receipt) || typeof receipt.operationId !== "string" || !sourceByCoreId.has(receipt.operationId) || !Array.isArray(receipt.revisions)) {
      throw new ToolFailure("INVALID_RESPONSE", "Core checkpoint receipt does not match the source operation map");
    }
    const operation = coreOperations.get(receipt.operationId)!;
    const paths = receipt.revisions.map((revision) => isRecord(revision) ? revision.path : undefined);
    const writes = operation.writes as unknown[];
    const expectedPaths = writes.map((write) => isRecord(write) ? write.path : undefined);
    if (paths.some((path) => typeof path !== "string") || JSON.stringify(paths) !== JSON.stringify(expectedPaths)) {
      throw new ToolFailure("INVALID_RESPONSE", "Core checkpoint receipt does not cover the source operation writes");
    }
    checkpointed.set(receipt.operationId, receipt);
    approved.add(receipt.operationId);
  }

  const selectedSourceIds = sourceOperations
    .filter((operation) => approved.has(details.operationMap[operation.id as string]!))
    .map((operation) => operation.id as string);
  const approvedOperationIds = selectedSourceIds;
  let status = approvedOperationIds.length ? "approved" : "proposed";
  let result: Record<string, unknown> | undefined;
  if (approvedOperationIds.length > 0 && approvedOperationIds.every((sourceId) => checkpointed.has(details.operationMap[sourceId]!))) {
    const appliedOperations = approvedOperationIds.map((sourceId) => {
      const sourceOperation = sourceOperations.find((item) => item.id === sourceId)!;
      const affectedEntities = details.affectedEntities[sourceId];
      return {
        operationId: sourceId,
        kind: sourceOperation.kind,
        precondition: sourceOperation.precondition,
        resultingRevision: details.resultRevisions[sourceId],
        resultId: details.resultIds[sourceId],
        ...(Array.isArray(affectedEntities) && affectedEntities.length ? { affectedEntities } : {}),
      };
    });
    status = approvedOperationIds.length === sourceOperations.length ? "applied" : "partially-applied";
    result = {
      changeSetId: details.sourceChangeSet.id,
      projectId: details.sourceChangeSet.projectId,
      status,
      operations: appliedOperations,
    };
  }
  return {
    changeSet: details.sourceChangeSet,
    fingerprint: details.sourceFingerprint,
    submittedAt: details.submittedAt,
    status,
    ...(approvedOperationIds.length ? { approvedOperationIds } : {}),
    ...(result ? { result } : {}),
  };
}

function unavailableChangeSetPayload(value: unknown, sourceChangeSetId?: string): Record<string, unknown> | undefined {
  if (!isRecord(value) || value.payloadComplete !== false || !isRecord(value.proposal)) return undefined;
  const proposal = value.proposal;
  if (typeof proposal.id !== "string" || (sourceChangeSetId && proposal.id !== coreProposalIdForChangeSet(sourceChangeSetId))) {
    return undefined;
  }
  const operationIds = Array.isArray(value.operationIds)
    ? value.operationIds.filter((id): id is string => typeof id === "string")
    : [];
  const approvedOperationIds = Array.isArray(value.approvedOperationIds)
    ? value.approvedOperationIds.filter((id): id is string => typeof id === "string")
    : [];
  const checkpointedOperationIds = Array.isArray(value.checkpoints)
    ? value.checkpoints.flatMap((receipt) =>
        isRecord(receipt) && typeof receipt.operationId === "string" ? [receipt.operationId] : [])
    : [];
  const publishedOperationIds = Array.isArray(value.publishedOperationIds)
    ? value.publishedOperationIds.filter((id): id is string => typeof id === "string")
    : [];
  return {
    coreProposalId: proposal.id,
    ...(sourceChangeSetId ? { sourceChangeSetId } : {}),
    payloadComplete: false,
    ...(typeof value.originalDigest === "string" ? { originalDigest: value.originalDigest } : {}),
    operationIds,
    approvedOperationIds,
    checkpointedOperationIds,
    publishedOperationIds,
    ...(typeof value.state === "string" ? { state: value.state } : {}),
    recovery: "Restore the original browser/private proposal to recover its complete NarrativeChangeSet. This MCP result contains Core review status only.",
  };
}

function unavailableChangeSetError(status: Record<string, unknown>) {
  return errorResult(
    "PROPOSAL_PAYLOAD_UNAVAILABLE",
    "The complete source ChangeSet is not recoverable from the current Core journal",
    status,
  );
}

function structuredRecord(record: Record<string, unknown>) {
  return {
    structuredContent: record,
    content: [{ type: "text" as const, text: JSON.stringify(record, null, 2) }],
  };
}

async function invoke(client: McpActionClient, actionId: string, input: unknown) {
  return actionResult(await client.invoke(actionId, input));
}

async function sceneContext(client: McpActionClient, sceneId: string): Promise<ActionResult> {
  return client.invoke("story.scene.context", { sceneId });
}

function extractSceneContext(value: unknown, requestedSceneId: string) {
  if (!isRecord(value)) throw new ToolFailure("STALE_CONTEXT", "Saved scene context is unavailable");
  const scene = isRecord(value.scene) ? value.scene : value;
  const manuscript = isRecord(value.manuscript) ? value.manuscript : undefined;
  const manuscriptBody =
    (typeof value.manuscriptBody === "string" ? value.manuscriptBody : undefined) ??
    (typeof value.manuscriptText === "string" ? value.manuscriptText : undefined) ??
    (typeof manuscript?.text === "string" ? manuscript.text : undefined) ??
    (typeof manuscript?.body === "string" ? manuscript.body : undefined);
  const manuscriptId =
    (typeof value.manuscriptId === "string" ? value.manuscriptId : undefined) ??
    (typeof manuscript?.id === "string" ? manuscript.id : undefined);
  const manuscriptRevision =
    (typeof value.manuscriptRevision === "string" ? value.manuscriptRevision : undefined) ??
    (typeof manuscript?.revision === "string" ? manuscript.revision : undefined);
  const manuscriptPath =
    (typeof value.manuscriptPath === "string" ? value.manuscriptPath : undefined) ??
    (typeof manuscript?.path === "string" ? manuscript.path : undefined) ??
    (typeof manuscript?.filePath === "string" ? manuscript.filePath : undefined);
  const sceneRevision =
    (typeof value.sceneRevision === "string" ? value.sceneRevision : undefined) ??
    (typeof scene.revision === "string" ? scene.revision : undefined);
  const sceneTitle =
    (typeof value.sceneTitle === "string" ? value.sceneTitle : undefined) ??
    (typeof scene.title === "string" ? scene.title : undefined) ??
    (typeof scene.name === "string" ? scene.name : undefined) ??
    (isRecord(scene.raw) && typeof scene.raw.title === "string" ? scene.raw.title : undefined);
  const sceneRaw = isRecord(scene.raw) ? scene.raw : scene;
  const goalConflictText = [sceneRaw.goal, sceneRaw.conflict]
    .filter((part): part is string => typeof part === "string" && part.trim().length > 0)
    .join("\n");
  const intendedTone = typeof sceneRaw.tone === "string" ? sceneRaw.tone : undefined;

  return {
    sceneId: typeof scene.id === "string" ? scene.id : requestedSceneId,
    sceneRevision,
    sceneTitle,
    manuscriptId,
    manuscriptRevision,
    manuscriptPath,
    manuscriptBody,
    goalConflictText,
    intendedTone,
  };
}

async function savedScene(client: McpActionClient, sceneId: string) {
  const result = await sceneContext(client, sceneId);
  if (!result.ok) throw new ToolFailure(result.error.code, result.error.message);
  const context = extractSceneContext(result.data, sceneId);
  if (!context.manuscriptId || !context.manuscriptRevision || context.manuscriptBody === undefined) {
    throw new ToolFailure("NOT_FOUND", `Scene manuscript not found: ${sceneId}`);
  }
  return { result, context };
}

async function sceneVoiceWarnings(
  client: McpActionClient,
  sceneId: string,
  field: "warnings" | "styleDeviations" | "stylometricDeviations",
  toolName: string,
) {
  const { result, context } = await savedScene(client, sceneId);
  if (!context.manuscriptBody) return errorResult("NOT_FOUND", `Scene not found or has no manuscript body: ${sceneId}`);
  const actions = await client.listActions();
  if (!actions.some((action) => action.id === "speaker.voice.check")) {
    return unavailableModuleAction(client, "speaker", toolName);
  }
  const voice = await client.invoke("speaker.voice.check", { sceneId });
  if (!voice.ok) return actionResult(voice);
  requireSameSnapshot(result.snapshot, voice.snapshot);
  const data = isRecord(voice.data) ? voice.data : {};
  if (!Array.isArray(data[field])) return errorResult("INVALID_RESPONSE", `Speaker voice result is missing ${field}`);
  return outputResult(data[field], voice.snapshot);
}

/** Register source-facing MCP tools against the same pinned host action API in both transports. */
export function registerMcpTools(server: McpServer, baseClient: McpActionClient): void {
  baseClient = signalAwareClient(baseClient);
  server.tool(
    "list_projects",
    "List projects registered to the authenticated owner; select a returned project_id for project tools",
    {},
    guarded(async () => {
      if (!baseClient.listProjects) {
        return errorResult("PROJECT_SCOPE_BOUND", "Project discovery is available through the standalone owner API client");
      }
      return outputResult({ projects: await baseClient.listProjects() });
    }),
  );

  server.tool(
    "discover_actions",
    "List enabled project actions available through this authenticated MCP session",
    { project_id: projectIdSchema },
    guarded(async ({ project_id }) => {
      const client = scopedClient(baseClient, project_id);
      return outputResult({ actions: await client.listActions() });
    }),
  );

  server.tool(
    "invoke_action",
    "Invoke one enabled read, compute, or proposal action from the authenticated project catalog",
    {
      project_id: projectIdSchema,
      action_id: z.string().min(1).max(256),
      input: z.record(z.unknown()).default({}),
    },
    guarded(async ({ project_id, action_id, input }) => {
      if (AUTHOR_OPERATION_ACTIONS.has(action_id)) {
        return errorResult("FORBIDDEN", "MCP cannot approve, checkpoint, reconcile, apply, or publish author changes");
      }
      if (byteLength(input) > 1_048_576) {
        return errorResult("INVALID_INPUT", "Action input exceeds the 1 MiB MCP limit");
      }
      const client = scopedClient(baseClient, project_id);
      const actions = await client.listActions();
      const action = actions.find((candidate) => candidate.id === action_id);
      if (!action) {
        return errorResult("ACTION_UNAVAILABLE", `Action is not enabled: ${action_id}`);
      }
      if (!["read", "compute", "propose"].includes(action.effect)) {
        return errorResult("FORBIDDEN", "MCP can invoke only read, compute, and proposal actions");
      }
      return invoke(client, action_id, input);
    }),
  );

  server.tool(
    "get_entity",
    "Get a single project entity by ID",
    {
      project_id: projectIdSchema,
      id: z.string().describe("Entity ID"),
    },
    guarded(async ({ project_id, id }) =>
      {
        const result = await scopedClient(baseClient, project_id).invoke("story.entities.get", { id });
        if (result.ok && result.data === null) return errorResult("NOT_FOUND", `Entity not found: ${id}`);
        return actionResult(result);
      }),
  );

  server.tool(
    "list_entities",
    "List project entities, optionally filtered by type",
    {
      project_id: projectIdSchema,
      type: z.string().optional().describe("Optional entity type"),
    },
    guarded(async ({ project_id, type }) =>
      invoke(scopedClient(baseClient, project_id), "story.entities.list", { type })),
  );

  server.tool(
    "get_scene_context",
    "Get a scene with its linked story context and saved manuscript",
    {
      project_id: projectIdSchema,
      scene_id: z.string().describe("Saved scene ID"),
    },
    guarded(async ({ project_id, scene_id }) =>
      {
        const result = await sceneContext(scopedClient(baseClient, project_id), scene_id);
        if (result.ok && result.data === null) return errorResult("NOT_FOUND", `Scene not found: ${scene_id}`);
        return actionResult(result);
      }),
  );

  const writingContextArgs = {
    project_id: projectIdSchema,
    scene_id: sceneIdSchema.describe("Saved scene ID"),
    selection: mcpWritingContextSelectionSchema
      .optional()
      .describe("Optional text selection explicitly supplied by the MCP caller"),
  };

  const readWritingContext = async (
    client: McpActionClient,
    sceneId: string,
    selection: z.infer<typeof mcpWritingContextSelectionSchema> | undefined,
    manifestOnly: boolean,
  ) => {
    const { result, context } = await savedScene(client, sceneId);
    if (context.manuscriptBody === undefined) {
      throw new ToolFailure("NOT_FOUND", `Scene manuscript body not found: ${sceneId}`);
    }
    const writingContext = createMcpWritingContext({
      projectId: client.projectId ?? "",
      sceneId: context.sceneId,
      sceneRevision: context.sceneRevision,
      sceneTitle: context.sceneTitle,
      manuscriptId: context.manuscriptId!,
      manuscriptRevision: context.manuscriptRevision!,
      manuscriptText: context.manuscriptBody,
      selection,
      manifestOnly,
    });
    return outputResult(manifestOnly ? writingContext.manifest : writingContext, result.snapshot);
  };

  server.tool(
    "get_writing_context",
    "Get bounded saved scene writing context and its context manifest",
    writingContextArgs,
    guarded(async ({ project_id, scene_id, selection }) =>
      readWritingContext(scopedClient(baseClient, project_id), scene_id, selection, false)),
  );

  server.tool(
    "get_context_manifest",
    "Get the bounded context manifest for a saved scene without returning manuscript text",
    writingContextArgs,
    guarded(async ({ project_id, scene_id, selection }) =>
      readWritingContext(scopedClient(baseClient, project_id), scene_id, selection, true)),
  );

  server.tool(
    "get_volume_tree",
    "Get the volume, chapter, and scene hierarchy",
    { project_id: projectIdSchema },
    guarded(async ({ project_id }) =>
      invoke(scopedClient(baseClient, project_id), "story.volumes.tree", {})),
  );

  server.tool(
    "search",
    "Run source hybrid full-text and semantic search over project story content",
    {
      project_id: projectIdSchema,
      query: z.string().describe("Search query"),
      limit: z.number().optional().describe("Maximum result count (default 20)"),
    },
    guarded(async ({ project_id, query, limit }) => {
      const client = scopedClient(baseClient, project_id);
      const actions = await client.listActions();
      if (!actions.some((action) => action.id === "semantic.search")) {
        return unavailableModuleAction(client, "semantic", "search");
      }
      return invoke(client, "semantic.search", { query, ...(limit === undefined ? {} : { limit }) });
    }),
  );

  server.tool(
    "analyze_manuscript",
    "Analyze saved scene manuscript text with source-compatible local diagnostics",
    {
      project_id: projectIdSchema,
      scene_id: z.string().describe("Saved scene ID"),
    },
    guarded(async ({ project_id, scene_id }) => {
      const client = scopedClient(baseClient, project_id);
      const { result, context } = await savedScene(client, scene_id);
      const actions = await client.listActions();
      if (!actions.some((action) => action.id === "diagnostics.analyze")) {
        return unavailableModuleAction(client, "diagnostics", "analyze_manuscript");
      }
      const analysis = await client.invoke("diagnostics.analyze", {
        text: context.manuscriptBody,
        sceneId: context.sceneId,
      });
      if (!analysis.ok) return actionResult(analysis);
      requireSameSnapshot(result.snapshot, analysis.snapshot);
      return outputResult(analysis.data, analysis.snapshot);
    }),
  );

  server.tool(
    "get_diagnostics",
    "Run the full source scene diagnostics, including speaker-dependent checks",
    {
      project_id: projectIdSchema,
      scene_id: z.string().describe("Saved scene ID"),
      text: z.string().optional().describe("Optional caller-supplied text; defaults to saved manuscript"),
    },
    guarded(async ({ project_id, scene_id, text }) => {
      const client = scopedClient(baseClient, project_id);
      const actions = await client.listActions();
      if (!actions.some((action) => action.id === "diagnostics.scene")) {
        return unavailableModuleAction(client, "diagnostics", "get_diagnostics");
      }
      return invoke(client, "diagnostics.scene", {
        sceneId: scene_id,
        ...(text === undefined ? {} : { text }),
      });
    }),
  );

  server.tool(
    "get_thread_status",
    "Query foreshadowing thread status at a scene or for one thread",
    {
      project_id: projectIdSchema,
      at: z.string().optional().describe("Scene ID for story-point status"),
      thread_id: z.string().optional().describe("Thread ID for its full lifecycle"),
    },
    guarded(async ({ project_id, at, thread_id }) => {
      if (!at && !thread_id) return errorResult("INVALID_INPUT", "Provide at and/or thread_id");
      return invoke(scopedClient(baseClient, project_id), "story.threads.status", {
        at,
        threadId: thread_id,
      });
    }),
  );

  server.tool(
    "get_status",
    "Get current repository synchronization status",
    { project_id: projectIdSchema },
    guarded(async ({ project_id }) =>
      invoke(scopedClient(baseClient, project_id), "core.status", {})),
  );

  server.tool(
    "get_history",
    "Get recent project repository history",
    { project_id: projectIdSchema },
    guarded(async ({ project_id }) =>
      invoke(scopedClient(baseClient, project_id), "core.history", {})),
  );

  server.tool(
    "get_observation",
    "Observe the project repository at its current remote snapshot",
    { project_id: projectIdSchema },
    guarded(async ({ project_id }) =>
      invoke(scopedClient(baseClient, project_id), "core.observation", {})),
  );

  server.tool(
    "submit_change_set",
    "Submit a source NarrativeChangeSet v1 proposal for author review; changes are never approved or applied",
    {
      project_id: projectIdSchema,
      change_set: narrativeChangeSetSchema.describe("Schema v1 NarrativeChangeSet proposal"),
    },
    guarded(async ({ project_id, change_set }) => {
      if (byteLength(change_set) > 1_048_576) {
        return errorResult("INVALID_INPUT", "ChangeSet proposal exceeds the 1 MiB MCP limit");
      }
      if (change_set.status !== "proposed") {
        return errorResult("INVALID_INPUT", "Only proposed ChangeSets can be submitted");
      }
      const client = scopedClient(baseClient, project_id);
      if (client.projectId !== change_set.projectId) {
        return errorResult("INVALID_INPUT", "ChangeSet projectId does not match project_id");
      }
      const proposalResult = await client.invoke("story.changes.propose", change_set);
      if (!proposalResult.ok) return actionResult(proposalResult);
      const data = isRecord(proposalResult.data) ? proposalResult.data : {};
      const coreProposalId = coreProposalIdForChangeSet(change_set.id);
      const returnedProposalId = proposalResult.proposals?.[0]?.id;
      const replayed = data.replayed === true;
      if (
        data.changeSetId !== change_set.id ||
        data.coreProposalId !== coreProposalId ||
        data.proposalId !== coreProposalId ||
        (returnedProposalId !== undefined && returnedProposalId !== coreProposalId) ||
        (returnedProposalId === undefined && !replayed)
      ) {
        return errorResult("INVALID_RESPONSE", "Story proposal did not preserve the source ChangeSet identity mapping");
      }
      const statusResult = await client.invoke("core.proposals.get", { proposalId: coreProposalId });
      if (!statusResult.ok) return actionResult(statusResult);
      requireSameSnapshot(proposalResult.snapshot, statusResult.snapshot);
      const proposalStatus = isRecord(statusResult.data) ? statusResult.data.proposal : undefined;
      const record = changeSetRecordFromProposalStatus(proposalStatus);
      if (!record || !isRecord(record.changeSet) || record.changeSet.id !== change_set.id) {
        return errorResult("INVALID_RESPONSE", "Core did not return the submitted source ChangeSet record");
      }
      return structuredRecord(record);
    }),
  );

  server.tool(
    "list_change_sets",
    "List project proposals and their author review/checkpoint status",
    { project_id: projectIdSchema },
    guarded(async ({ project_id }) => {
      const result = await scopedClient(baseClient, project_id).invoke("core.proposals.list", {});
      if (!result.ok) return actionResult(result);
      const data = isRecord(result.data) ? result.data : {};
      if (!Array.isArray(data.proposals)) return errorResult("INVALID_RESPONSE", "Core proposal list is invalid");
      const records = data.proposals.flatMap((status) => {
        const record = changeSetRecordFromProposalStatus(status);
        return record ? [record] : [];
      });
      const changeSets = records.map((record) => {
        const changeSet = record.changeSet as JsonRecord & { id: string; projectId: string; operations: JsonRecord[] };
        const resultValue = isRecord(record.result) ? record.result : undefined;
        return {
          change_set_id: changeSet.id,
          project_id: changeSet.projectId,
          status: record.status,
          submitted_at: record.submittedAt,
          operation_ids: changeSet.operations.map((operation) => operation.id),
          approved_operation_ids: record.approvedOperationIds,
          ...(resultValue ? {
            result: {
              status: resultValue.status,
              operations: Array.isArray(resultValue.operations)
                ? resultValue.operations.map((operation) => isRecord(operation) ? {
                    operation_id: operation.operationId,
                    result_id: operation.resultId,
                    resulting_revision: operation.resultingRevision,
                  } : null).filter((operation) => operation !== null)
                : [],
              failure: resultValue.failure,
            },
          } : {}),
        };
      });
      const incompletePayloads = data.proposals.flatMap((status) => {
        const incomplete = unavailableChangeSetPayload(status);
        return incomplete ? [incomplete] : [];
      });
      return structuredRecord({
        change_sets: changeSets,
        ...(incompletePayloads.length ? { incomplete_payloads: incompletePayloads } : {}),
      });
    }),
  );

  server.tool(
    "get_change_set",
    "Get one project proposal and its author review/checkpoint status",
    {
      project_id: projectIdSchema,
      change_set_id: z.string().min(1).max(256),
    },
    guarded(async ({ project_id, change_set_id }) => {
      const coreProposalId = coreProposalIdForChangeSet(change_set_id);
      const result = await scopedClient(baseClient, project_id).invoke("core.proposals.get", { proposalId: coreProposalId });
      if (!result.ok) {
        if (["PROPOSAL_NOT_FOUND", "proposal_not_found"].includes(result.error.code)) {
          return errorResult("NOT_FOUND", `ChangeSet not found: ${change_set_id}`);
        }
        return actionResult(result);
      }
      const data = isRecord(result.data) ? result.data : {};
      const record = changeSetRecordFromProposalStatus(data.proposal);
      if (!record || !isRecord(record.changeSet) || record.changeSet.id !== change_set_id) {
        const incomplete = unavailableChangeSetPayload(data.proposal, change_set_id);
        if (incomplete) return unavailableChangeSetError(incomplete);
        return errorResult("NOT_FOUND", `ChangeSet not found: ${change_set_id}`);
      }
      return structuredRecord(record);
    }),
  );

  server.tool(
    "update_entity",
    "Propose a revision-bound story entity update for author review",
    {
      project_id: projectIdSchema,
      id: z.string().min(1).max(256),
      base_revision: z.string().min(1).max(256),
      operation_id: operationIdSchema,
      patch: z.record(z.unknown()),
    },
    guarded(async ({ project_id, id, base_revision, operation_id, patch }) =>
      invoke(scopedClient(baseClient, project_id), "story.entities.update", {
        id,
        patch,
        base_revision,
        operation_id,
      })),
  );

  server.tool(
    "create_scene",
    "Propose a scene and manuscript stub under a chapter for author review",
    {
      project_id: projectIdSchema,
      chapter_id: z.string().min(1).max(256),
      base_revision: z.string().min(1).max(256),
      operation_id: operationIdSchema,
      slug: z.string(),
      title: z.string().min(1).max(256),
      position: z.number().int().positive().optional(),
      characters: z.array(z.string().min(1).max(256)).optional(),
      location: z.string().min(1).max(256).optional(),
    },
    guarded(async ({
      project_id,
      chapter_id,
      base_revision,
      operation_id,
      slug,
      title,
      position,
      characters,
      location,
    }) => {
      const client = scopedClient(baseClient, project_id);
      const chapter = await client.invoke("story.entities.get", { id: chapter_id });
      if (!chapter.ok) return actionResult(chapter);
      const chapterData = isRecord(chapter.data) ? chapter.data : {};
      const raw = isRecord(chapterData.raw) ? chapterData.raw : chapterData;
      const volumeId = typeof raw.volume === "string" ? raw.volume : undefined;
      if (chapterData.type !== "chapter" || !volumeId) {
        return errorResult("NOT_FOUND", `Chapter not found or has no volume reference: ${chapter_id}`);
      }
      const sceneId = slug.startsWith("sc-") ? slug : `sc-${slug}`;
      const created = await client.invoke("story.entities.create", {
        type: "scene",
        id: sceneId,
        title,
        chapter: chapter_id,
        volume: volumeId,
        ...(position === undefined ? {} : { position }),
        ...(characters?.length ? { characters } : {}),
        ...(location ? { location } : {}),
        base_revision,
        operation_id,
      });
      if (!created.ok) return actionResult(created);
      requireSameSnapshot(chapter.snapshot, created.snapshot);
      return actionResult(created);
    }),
  );

  server.tool(
    "lint_manuscript",
    "Analyze a saved manuscript; fixes are proposals for author review",
    {
      project_id: projectIdSchema,
      scene_id: z.string().optional(),
      fix: z.boolean().optional().describe("Propose rule fixes for author review; never writes directly"),
      base_revision: z.string().optional(),
      operation_id: z.string().optional(),
    },
    guarded(async ({ project_id, scene_id, fix, base_revision, operation_id }) => {
      const client = scopedClient(baseClient, project_id);
      if (!scene_id) {
        if (fix === true) return errorResult("UNAPPROVED", "Bulk fixes require per-scene review; provide scene_id");
        const listed = await client.invoke("story.entities.list", { type: "scene" });
        if (!listed.ok) return actionResult(listed);
        if (!Array.isArray(listed.data)) return errorResult("INVALID_RESPONSE", "Scene list response is invalid");
        const results: unknown[] = [];
        for (const scene of listed.data) {
          if (!isRecord(scene) || typeof scene.id !== "string") continue;
          const result = await sceneContext(client, scene.id);
          if (!result.ok) return actionResult(result);
          requireSameSnapshot(listed.snapshot, result.snapshot);
          const context = extractSceneContext(result.data, scene.id);
          if (context.manuscriptBody === undefined) continue;
          const lint = await client.invoke("diagnostics.lint", { text: context.manuscriptBody });
          if (!lint.ok) return actionResult(lint);
          requireSameSnapshot(listed.snapshot, lint.snapshot);
          if (isRecord(lint.data) && Array.isArray(lint.data.warnings) && lint.data.warnings.length > 0) {
            results.push({ scene_id: scene.id, ...lint.data });
          }
        }
        return outputResult({ scene_count: listed.data.length, results }, listed.snapshot);
      }
      const { result, context } = await savedScene(client, scene_id);
      if (fix !== true) {
        const analysis = await client.invoke("diagnostics.lint", { text: context.manuscriptBody });
        if (!analysis.ok) return actionResult(analysis);
        requireSameSnapshot(result.snapshot, analysis.snapshot);
        return outputResult(analysis.data, analysis.snapshot);
      }
      if (!base_revision || !operation_id) {
        return errorResult("INVALID_INPUT", "base_revision and operation_id are required when fix is true");
      }
      if (!/^[a-zA-Z0-9._:-]{1,128}$/.test(operation_id)) {
        return errorResult("INVALID_INPUT", "operation_id must be a stable ID of up to 128 characters");
      }
      if (context.manuscriptRevision !== base_revision) {
        return errorResult("STALE_PRECONDITION", "Manuscript revision changed since it was read");
      }
      if (!context.manuscriptPath) {
        return errorResult("STALE_CONTEXT", "Saved manuscript path is unavailable");
      }
      const proposal = await client.invoke("diagnostics.proposeLintFix", {
        path: context.manuscriptPath,
        operationId: operation_id,
        baseRevision: base_revision,
      });
      if (!proposal.ok) return actionResult(proposal);
      requireSameSnapshot(result.snapshot, proposal.snapshot);
      return actionResult(proposal);
    }),
  );

  server.tool(
    "suggest_rewrite",
    "Generate source-compatible rewrite candidates for a saved scene sentence",
    {
      project_id: projectIdSchema,
      scene_id: z.string().describe("Scene ID"),
      sentence_index: z.number().int().nonnegative().describe("Zero-based sentence index"),
    },
    guarded(async ({ project_id, scene_id, sentence_index }) => {
      const client = scopedClient(baseClient, project_id);
      const actions = await client.listActions();
      if (!actions.some((action) => action.id === "assistant.rewrite")) {
        return unavailableModuleAction(client, "assistant", "suggest_rewrite");
      }
      if (!actions.some((action) => action.id === "nlp.analyze")) {
        return unavailableModuleAction(client, "nlp", "sentence segmentation for suggest_rewrite");
      }

      const { result: scene, context } = await savedScene(client, scene_id);
      const manuscriptBody = context.manuscriptBody;
      if (manuscriptBody === undefined) return errorResult("NOT_FOUND", `Scene manuscript not found: ${scene_id}`);
      const segmentation = await client.invoke("nlp.analyze", { text: manuscriptBody });
      if (!segmentation.ok) return actionResult(segmentation);
      requireSameSnapshot(scene.snapshot, segmentation.snapshot);
      if (!isRecord(segmentation.data) || !isRecord(segmentation.data.analysis) ||
          !Array.isArray(segmentation.data.analysis.sentences)) {
        return errorResult("INVALID_RESPONSE", "NLP sentence segmentation response is invalid");
      }
      const sentences: string[] = [];
      for (const span of segmentation.data.analysis.sentences) {
        if (!isRecord(span) || typeof span.text !== "string" ||
            !Number.isSafeInteger(span.start) || !Number.isSafeInteger(span.end) ||
            (span.start as number) < 0 || (span.end as number) < (span.start as number) ||
            (span.end as number) > manuscriptBody.length ||
            manuscriptBody.slice(span.start as number, span.end as number) !== span.text) {
          return errorResult("INVALID_RESPONSE", "NLP sentence segmentation response is invalid");
        }
        const sentence = span.text.trim();
        if (sentence) sentences.push(sentence);
      }
      if (sentence_index >= sentences.length) {
        return errorResult(
          "INVALID_INPUT",
          `Sentence index out of range: ${sentence_index} (scene has ${sentences.length} sentences)`,
        );
      }

      const originalSentence = sentences[sentence_index];
      const rewritten = await client.invoke("assistant.rewrite", {
        sceneId: scene_id,
        selectedText: originalSentence,
        sentenceIndex: sentence_index,
      });
      if (!rewritten.ok) return actionResult(rewritten);
      requireSameSnapshot(scene.snapshot, rewritten.snapshot);
      if (!isRecord(rewritten.data) || rewritten.data.sceneId !== scene_id ||
          rewritten.data.sentenceIndex !== sentence_index ||
          rewritten.data.originalSentence !== originalSentence ||
          !Array.isArray(rewritten.data.suggestions) ||
          rewritten.data.suggestions.length !== 3 ||
          rewritten.data.suggestions.some((suggestion) => !isRecord(suggestion) ||
            typeof suggestion.text !== "string" ||
            !["concise", "contextual", "voice"].includes(String(suggestion.strategy)) ||
            typeof suggestion.rationale !== "string") ||
          !isRecord(rewritten.data.context) || typeof rewritten.data.prompt !== "string") {
        return errorResult("INVALID_RESPONSE", "Assistant rewrite response omitted source-compatible context or prompt");
      }
      const response = {
        sceneId: rewritten.data.sceneId,
        sentenceIndex: rewritten.data.sentenceIndex,
        originalSentence: rewritten.data.originalSentence,
        suggestions: rewritten.data.suggestions,
        prompt: rewritten.data.prompt,
        context: rewritten.data.context,
        ...(rewritten.data.sentenceSplit === undefined ? {} : { sentenceSplit: rewritten.data.sentenceSplit }),
        ...(rewritten.data.tellToShow === undefined ? {} : { tellToShow: rewritten.data.tellToShow }),
        ...(rewritten.data.model === undefined ? {} : { model: rewritten.data.model }),
        ...(rewritten.data.provider === undefined ? {} : { provider: rewritten.data.provider }),
        ...(rewritten.data.promptVersion === undefined ? {} : { promptVersion: rewritten.data.promptVersion }),
        ...(rewritten.data.citations === undefined ? {} : { citations: rewritten.data.citations }),
        ...(rewritten.data.provenance === undefined ? {} : { provenance: rewritten.data.provenance }),
      };
      return outputResult(response, rewritten.snapshot);
    }),
  );

  server.tool(
    "reload",
    "Materialize the selected canonical project snapshot and return its entity and link counts",
    { project_id: projectIdSchema },
    guarded(async ({ project_id }) => {
      const client = scopedClient(baseClient, project_id);
      const materialize = (await client.listActions()).find((action) => action.id === "story.snapshot.materialize");
      if (!materialize) {
        return unavailableModuleAction(client, "story", "reload");
      }
      if (materialize.effect !== "read") return errorResult("ACTION_EFFECT_DENIED", "The Story snapshot materializer must be read-only");
      return invoke(client, "story.snapshot.materialize", {});
    }),
  );

  server.tool(
    "check_stylometric_deviations",
    "Check saved scene dialogue for source-compatible stylometric outliers",
    { project_id: projectIdSchema, scene_id: z.string().describe("Scene ID") },
    guarded(async ({ project_id, scene_id }) =>
      sceneVoiceWarnings(scopedClient(baseClient, project_id), scene_id, "stylometricDeviations", "check_stylometric_deviations")),
  );

  server.tool(
    "check_plot_semantics",
    "Check saved manuscript text against the scene goal and conflict",
    { project_id: projectIdSchema, scene_id: z.string().describe("Scene ID") },
    guarded(async ({ project_id, scene_id }) => {
      const client = scopedClient(baseClient, project_id);
      const { result, context } = await savedScene(client, scene_id);
      const actions = await client.listActions();
      if (!actions.some((action) => action.id === "diagnostics.checkPlotSemantics")) {
        return unavailableModuleAction(client, "diagnostics", "check_plot_semantics");
      }
      const diagnostics = await client.invoke("diagnostics.checkPlotSemantics", {
        sceneId: scene_id,
        text: context.manuscriptBody,
      });
      if (!diagnostics.ok) return actionResult(diagnostics);
      requireSameSnapshot(result.snapshot, diagnostics.snapshot);
      return actionResult(diagnostics);
    }),
  );

  server.tool(
    "check_consistency",
    "Validate story links, threads, and manuscript references",
    { project_id: projectIdSchema },
    guarded(async ({ project_id }) => {
      const client = scopedClient(baseClient, project_id);
      if (!(await client.listActions()).some((action) => action.id === "diagnostics.checkConsistency")) {
        return unavailableModuleAction(client, "diagnostics", "check_consistency");
      }
      const result = await client.invoke("diagnostics.checkConsistency", {});
      if (!result.ok) return actionResult(result);
      const data = isRecord(result.data) ? result.data : {};
      if (!Array.isArray(data.issues)) return errorResult("INVALID_RESPONSE", "Diagnostics consistency result is invalid");
      const issues = data.issues;
      const errorCount = issues.filter((issue) => isRecord(issue) && issue.severity === "error").length;
      return outputResult({ ok: errorCount === 0, issue_count: issues.length, issues }, result.snapshot);
    }),
  );

  server.tool(
    "check_continuity",
    "Detect scene-to-scene location continuity issues",
    { project_id: projectIdSchema },
    guarded(async ({ project_id }) => {
      const client = scopedClient(baseClient, project_id);
      if (!(await client.listActions()).some((action) => action.id === "diagnostics.checkContinuity")) {
        return unavailableModuleAction(client, "diagnostics", "check_continuity");
      }
      const result = await client.invoke("diagnostics.checkContinuity", {});
      if (!result.ok) return actionResult(result);
      const data = isRecord(result.data) ? result.data : {};
      if (!Array.isArray(data.warnings)) return errorResult("INVALID_RESPONSE", "Diagnostics continuity result is invalid");
      return outputResult(data.warnings, result.snapshot);
    }),
  );

  server.tool(
    "compute_cooccurrence",
    "Compute scene-level character co-occurrence",
    { project_id: projectIdSchema },
    guarded(async ({ project_id }) => {
      const client = scopedClient(baseClient, project_id);
      if (!(await client.listActions()).some((action) => action.id === "story.cooccurrence")) {
        return unavailableModuleAction(client, "story", "compute_cooccurrence");
      }
      return invoke(client, "story.cooccurrence", {});
    }),
  );

  server.tool(
    "check_voice_consistency",
    "Check source-compatible character voice consistency in scene dialogue",
    {
      project_id: projectIdSchema,
      scene_id: z.string().describe("Scene ID"),
    },
    guarded(async ({ project_id, scene_id }) =>
      sceneVoiceWarnings(scopedClient(baseClient, project_id), scene_id, "warnings", "check_voice_consistency")),
  );

  server.tool(
    "check_style_deviations",
    "Detect dialogue that deviates from the learned character style profile",
    {
      project_id: projectIdSchema,
      scene_id: z.string().describe("Scene ID"),
    },
    guarded(async ({ project_id, scene_id }) =>
      sceneVoiceWarnings(scopedClient(baseClient, project_id), scene_id, "styleDeviations", "check_style_deviations")),
  );

  server.tool(
    "get_dialogue",
    "Extract character dialogue lines as a voice reference",
    {
      project_id: projectIdSchema,
      character_id: z.string().describe("Character entity ID"),
      limit: z.number().int().positive().optional().describe("Max recent lines (default 20)"),
      scene_id: z.string().optional().describe("Optional scene filter"),
      min_confidence: z.enum(["high", "low"]).optional().describe("Minimum attribution confidence"),
    },
    guarded(async ({ project_id, character_id, limit, scene_id, min_confidence }) => {
      const client = scopedClient(baseClient, project_id);
      const actions = await client.listActions();
      if (!actions.some((action) => action.id === "speaker.dialogue.list")) {
        return unavailableModuleAction(client, "speaker", "get_dialogue");
      }
      const result = await client.invoke("speaker.dialogue.list", {
        characterId: character_id,
        ...(limit === undefined ? {} : { limit }),
        ...(scene_id === undefined ? {} : { sceneId: scene_id }),
        ...(min_confidence === undefined ? {} : { minConfidence: min_confidence }),
      });
      if (!result.ok) return actionResult(result);
      const data = isRecord(result.data) ? result.data : {};
      if (!Array.isArray(data.lines)) return errorResult("INVALID_RESPONSE", "Speaker dialogue result is invalid");
      return outputResult({ character_id, count: data.lines.length, lines: data.lines }, result.snapshot);
    }),
  );

  server.tool(
    "format_manuscript",
    "Propose source-compatible formatting for a saved scene manuscript",
    { project_id: projectIdSchema, scene_id: sceneIdSchema.describe("Saved scene ID") },
    guarded(async ({ project_id, scene_id }) => {
      const client = scopedClient(baseClient, project_id);
      const actions = await client.listActions();
      if (!actions.some((action) => action.id === "diagnostics.formatManuscript")) {
        return unavailableModuleAction(client, "diagnostics", "format_manuscript");
      }
      const result = await client.invoke("diagnostics.formatManuscript", {
        sceneId: scene_id,
        registerProposal: false,
      });
      if (!result.ok) return actionResult(result);
      if (!isRecord(result.data) ||
          result.data.actionId !== "format-manuscript" ||
          typeof result.data.resultId !== "string" ||
          !(result.data.proposalId === null || typeof result.data.proposalId === "string") ||
          !(result.data.sourceProposal === null || isRecord(result.data.sourceProposal))) {
        return errorResult("INVALID_RESPONSE", "Formatter action did not return its source-compatible result identity");
      }
      const proposal = result.data.sourceProposal;
      const proposalId = result.data.proposalId;
      if (proposal !== null && (!isRecord(proposal) || typeof proposal.id !== "string" || proposalId !== proposal.id)) {
        return errorResult("INVALID_RESPONSE", "Formatter proposal identity does not match its source result");
      }
      if (proposal === null && proposalId !== null) {
        return errorResult("INVALID_RESPONSE", "Formatter returned a proposal ID without a proposal");
      }
      return outputResult({
        action_id: "format-manuscript",
        result_id: result.data.resultId,
        proposal_id: proposalId,
        proposal,
      }, result.snapshot);
    }),
  );
}
