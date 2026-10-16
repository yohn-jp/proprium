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

class ToolFailure extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ToolFailure";
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function errorResult(code: string, message: string) {
  const error = { code, message: message.slice(0, 512) };
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

function guarded<TArgs>(handler: (args: TArgs) => Promise<ReturnType<typeof errorResult> | ReturnType<typeof outputResult>>) {
  return async (args: TArgs) => {
    try {
      return await handler(args);
    } catch (error) {
      return apiError(error);
    }
  };
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

/** Register source-facing MCP tools against the same pinned host action API in both transports. */
export function registerMcpTools(server: McpServer, baseClient: McpActionClient): void {
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
      if (/approve|checkpoint|publish|reconcile|apply/i.test(action_id)) {
        return errorResult("FORBIDDEN", "MCP can propose changes but cannot approve, apply, checkpoint, or publish");
      }
      if (byteLength(input) > 1_048_576) {
        return errorResult("INVALID_INPUT", "Action input exceeds the 1 MiB MCP limit");
      }
      const client = scopedClient(baseClient, project_id);
      const actions = await client.listActions();
      if (!actions.some((action) => action.id === action_id)) {
        return errorResult("ACTION_UNAVAILABLE", `Action is not enabled: ${action_id}`);
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
    "Search saved project story content",
    {
      project_id: projectIdSchema,
      query: z.string().describe("Search query"),
      limit: z.number().optional().describe("Maximum result count (default 20)"),
    },
    guarded(async ({ project_id, query, limit }) =>
      invoke(scopedClient(baseClient, project_id), "core.search", { query, ...(limit === undefined ? {} : { limit }) })),
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
    "Run saved scene diagnostics and return normalized findings",
    {
      project_id: projectIdSchema,
      scene_id: z.string().describe("Saved scene ID"),
      text: z.string().optional().describe("Optional caller-supplied text; defaults to saved manuscript"),
    },
    guarded(async ({ project_id, scene_id, text }) => {
      const client = scopedClient(baseClient, project_id);
      const { result, context } = text === undefined
        ? await savedScene(client, scene_id)
        : await (async () => {
            const result = await sceneContext(client, scene_id);
            if (!result.ok) throw new ToolFailure(result.error.code, result.error.message);
            if (result.data === null) throw new ToolFailure("NOT_FOUND", `Scene not found: ${scene_id}`);
            return { result, context: extractSceneContext(result.data, scene_id) };
          })();
      if (!result.ok) return actionResult(result);
      const body = text ?? context?.manuscriptBody;
      if (body === undefined || body === null) {
        return errorResult("NOT_FOUND", `Scene manuscript not found: ${scene_id}`);
      }
      const actions = await client.listActions();
      if (!actions.some((action) => action.id === "diagnostics.analyze")) {
        return unavailableModuleAction(client, "diagnostics", "get_diagnostics");
      }
      const diagnostics = await client.invoke("diagnostics.analyze", {
        text: body,
        sceneId: scene_id,
        ...(context?.intendedTone ? { intendedTone: context.intendedTone } : {}),
        ...(context?.goalConflictText ? { goalConflictText: context.goalConflictText } : {}),
      });
      if (!diagnostics.ok) return actionResult(diagnostics);
      requireSameSnapshot(result.snapshot, diagnostics.snapshot);
      return outputResult(diagnostics.data, diagnostics.snapshot);
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
      const client = scopedClient(baseClient, project_id);
      if (client.projectId !== change_set.projectId) {
        return errorResult("INVALID_INPUT", "ChangeSet projectId does not match project_id");
      }
      const result = await client.invoke("story.changes.propose", change_set);
      if (result.ok) {
        const proposalId = result.proposals?.[0]?.id;
        if (proposalId !== change_set.id) {
          return errorResult("INVALID_RESPONSE", "Story proposal did not preserve the ChangeSet ID");
        }
      }
      return actionResult(result);
    }),
  );

  server.tool(
    "list_change_sets",
    "List project proposals and their author review/checkpoint status",
    { project_id: projectIdSchema },
    guarded(async ({ project_id }) =>
      invoke(scopedClient(baseClient, project_id), "core.proposals.list", {})),
  );

  server.tool(
    "get_change_set",
    "Get one project proposal and its author review/checkpoint status",
    {
      project_id: projectIdSchema,
      change_set_id: z.string().min(1).max(256),
    },
    guarded(async ({ project_id, change_set_id }) =>
      invoke(scopedClient(baseClient, project_id), "core.proposals.get", { proposalId: change_set_id })),
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
    guarded(async ({ project_id }) =>
      unavailableModuleAction(scopedClient(baseClient, project_id), "assistant", "suggest_rewrite")),
  );

  server.tool(
    "reload",
    "Refresh derived project reads and indexes without changing project files",
    { project_id: projectIdSchema },
    guarded(async ({ project_id }) =>
      unavailableModuleAction(scopedClient(baseClient, project_id), "core", "reload")),
  );

  server.tool(
    "check_stylometric_deviations",
    "Check saved scene dialogue for source-compatible stylometric outliers",
    { project_id: projectIdSchema, scene_id: z.string().describe("Scene ID") },
    guarded(async ({ project_id }) =>
      unavailableModuleAction(scopedClient(baseClient, project_id), "speaker", "check_stylometric_deviations")),
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

  const inspectionScope = z.string().optional().describe("Optional source scope: sc-*, ch-*, or vol-*" );
  server.tool(
    "check_consistency",
    "Validate story links, threads, and manuscript references within an optional scope",
    { project_id: projectIdSchema, scope: inspectionScope },
    guarded(async ({ project_id }) =>
      unavailableModuleAction(scopedClient(baseClient, project_id), "story", "check_consistency")),
  );

  server.tool(
    "check_continuity",
    "Detect scene-to-scene location continuity issues within an optional scope",
    { project_id: projectIdSchema, scope: inspectionScope },
    guarded(async ({ project_id }) =>
      unavailableModuleAction(scopedClient(baseClient, project_id), "story", "check_continuity")),
  );

  server.tool(
    "compute_cooccurrence",
    "Compute scene-level character co-occurrence within an optional scope",
    { project_id: projectIdSchema, scope: inspectionScope },
    guarded(async ({ project_id }) =>
      unavailableModuleAction(scopedClient(baseClient, project_id), "story", "compute_cooccurrence")),
  );

  server.tool(
    "check_voice_consistency",
    "Check source-compatible character voice consistency in scene dialogue",
    {
      project_id: projectIdSchema,
      scene_id: z.string().optional().describe("Single scene ID"),
      scope: inspectionScope,
    },
    guarded(async ({ project_id }) =>
      unavailableModuleAction(scopedClient(baseClient, project_id), "speaker", "check_voice_consistency")),
  );

  server.tool(
    "check_style_deviations",
    "Detect dialogue that deviates from the learned character style profile",
    {
      project_id: projectIdSchema,
      scene_id: z.string().optional().describe("Single scene ID"),
      scope: inspectionScope,
    },
    guarded(async ({ project_id }) =>
      unavailableModuleAction(scopedClient(baseClient, project_id), "speaker", "check_style_deviations")),
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
    guarded(async ({ project_id }) =>
      unavailableModuleAction(scopedClient(baseClient, project_id), "speaker", "get_dialogue")),
  );

  server.tool(
    "format_manuscript",
    "Propose source-compatible formatting for a saved scene manuscript",
    { project_id: projectIdSchema, scene_id: sceneIdSchema.describe("Saved scene ID") },
    guarded(async ({ project_id }) =>
      unavailableModuleAction(scopedClient(baseClient, project_id), "assistant", "format_manuscript")),
  );
}
