#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ApiClient } from "./api-client.js";
import { registerMcpTools } from "./tools.js";

const token = process.env.SCRIPTORIUM_AUTH_TOKEN;
if (!token) {
  process.stderr.write("Set SCRIPTORIUM_AUTH_TOKEN to connect to the Scriptorium owner API.\n");
  process.exitCode = 1;
} else {
  const client = new ApiClient({
    baseUrl: process.env.SCRIPTORIUM_API_URL ?? "http://127.0.0.1:3000",
    token,
    projectId: process.env.SCRIPTORIUM_PROJECT_ID || undefined,
  });
  const server = new McpServer({ name: "scriptorium-mcp", version: "0.1.0" });
  registerMcpTools(server, client);
  await server.connect(new StdioServerTransport());
}
