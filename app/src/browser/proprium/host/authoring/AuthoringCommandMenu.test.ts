import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AuthoringCommandMenu } from "./AuthoringCommandMenu.js";
import type { AuthoringSurfaceRegistration } from "./WorkspaceAuthoringPanels.js";

test("signed command surfaces are reachable through the Host command menu", () => {
  const registration: AuthoringSurfaceRegistration = {
    pluginId: "proprium.research",
    pluginVersion: "2.0.0",
    status: "ready",
    surface: {
      id: "search-command", kind: "command", title: "作品を検索", context: {},
      body: { id: "search-form", type: "form", fields: [{ id: "query", label: "検索語", type: "string" }],
        submit: { action_id: "proprium.research.search.query", input_template: { query: { data_key: "form.query" } } } },
    },
  };
  const html = renderToStaticMarkup(createElement(AuthoringCommandMenu, {
    registrations: [registration],
    invoke: async () => ({ action_result: { ok: true } }),
    read: async () => ({ ok: true }),
  }));
  assert.match(html, /プラグインコマンド/u);
  assert.match(html, /作品を検索/u);
  assert.match(html, /proprium\.research/u);
});
