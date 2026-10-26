import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { authoringPanelId, createAuthoringWorkspacePanels, validateAuthoringSurfaceRegistrations, type AuthoringSurfaceRegistration } from "./WorkspaceAuthoringPanels.js";

const registration: AuthoringSurfaceRegistration = {
  pluginId: "proprium.narrative",
  pluginVersion: "1.0.0",
  status: "ready",
  data: { last_action_result: { items: [{ id: "v1", title: "第1巻" }] } },
  surface: {
    id: "hierarchy",
    kind: "panel",
    title: "作品構成",
    context: { label: "選択中の作品" },
    body: { id: "outline", type: "outline", items: { data_key: "last_action_result.items" } },
  },
};

test("verified authoring declarations become stable normal workspace panels", () => {
  const panels = createAuthoringWorkspacePanels([registration], async () => ({
    action_result: {
      ok: true, request_id: "req-1", scope: { workspace_id: "w", repository_id: null, branch: "main", generation: "g" },
      snapshot: { id: "s", local_commit: null, worktree_generation: "g", draft_generation: null }, value: {}, warnings: [],
    },
  }), async () => ({
    ok: true, request_id: "read-1", scope: { workspace_id: "w", repository_id: null, branch: "main", generation: "g" },
    snapshot: { id: "s", local_commit: null, worktree_generation: "g", draft_generation: null }, value: {}, warnings: [],
  }));
  assert.equal(panels.length, 1);
  assert.equal(panels[0]?.id, "plugin:proprium.narrative:hierarchy");
  assert.equal(panels[0]?.title, "作品構成");
  const html = renderToStaticMarkup(createElement("div", null, panels[0]?.render()));
  assert.match(html, /role="tree"/u);
  assert.match(html, /第1巻/u);
});

test("panel IDs stay within the Workspace layout limit for long signed IDs", () => {
  const id = authoringPanelId("proprium." + "p".repeat(120), "surface." + "s".repeat(120));
  assert.ok(id.startsWith("plugin:proprium."));
  assert.ok(id.length <= 159);
  assert.equal(id, authoringPanelId("proprium." + "p".repeat(120), "surface." + "s".repeat(120)));
});

test("service registrations preserve disabled reasons and reject invalid signed surfaces", () => {
  const result = validateAuthoringSurfaceRegistrations([
    { pluginId: "proprium.narrative", pluginVersion: "2.0.0", manifestDigest: "abc", availability: "disabled", reason: "Enable the plugin.", surface: registration.surface },
    { pluginId: "proprium.bad", pluginVersion: "2.0.0", availability: "ready", surface: { ...registration.surface, body: { id: "unsafe", type: "list", items: [], primary: "title", html: "<script/>" } } },
  ]);
  assert.equal(result.length, 1);
  assert.equal(result[0]?.status, "unavailable");
  assert.equal(result[0]?.message, "Enable the plugin.");
  assert.equal(result[0]?.manifestDigest, "abc");
});
