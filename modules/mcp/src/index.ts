import type { ModuleContext, ModuleDefinition, ModuleManifest } from "@scriptorium/contracts";
import { closeMcpSessions, createMcpHttpContribution } from "./http.js";

export const mcpManifest: ModuleManifest = {
  id: "mcp",
  version: "0.1.0",
  contractVersion: 1,
  dependencies: [],
  provides: [],
  requires: [],
  serverEntry: "./dist/index.js",
  statePaths: [],
  locality: "local",
};

/** Register the external MCP transports without allocating models or persistent storage. */
export async function createModule(context: ModuleContext): Promise<ModuleDefinition> {
  const sessions = new Map();
  let disposed = false;
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    context.signal.removeEventListener("abort", abortHandler);
    await closeMcpSessions(sessions);
  };
  const abortHandler = () => {
    void dispose();
  };

  context.signal.addEventListener("abort", abortHandler, { once: true });
  if (context.signal.aborted) await dispose();

  return {
    manifest: mcpManifest,
    actions: [],
    ui: [],
    http: [createMcpHttpContribution(sessions)],
    dispose,
  };
}

export { createMcpHttpContribution } from "./http.js";
export { registerMcpTools } from "./tools.js";
export { ApiClient, McpApiError, actionClientFromContext } from "./api-client.js";
export {
  createMcpWritingContext,
  MCP_WRITING_CONTEXT_MAX_CHARACTERS,
  MCP_WRITING_CONTEXT_MAX_SELECTION_CHARACTERS,
  mcpWritingContextSelectionSchema,
} from "./context-manifest.js";
