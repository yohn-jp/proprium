import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AuthoringSurface, formValuesToJson, resolveAuthoringTemplate } from "./AuthoringSurface.js";
import type { AuthoringSurfaceDeclaration } from "./types.js";

const outlineSurface: AuthoringSurfaceDeclaration = {
  id: "narrative-outline",
  kind: "panel",
  title: "作品構成",
  context: { label: "選択中の作品" },
  body: {
    id: "outline",
    type: "outline",
    title: "章とシーン",
    items: { data_key: "tree.items" },
    activate: { action_id: "proprium.narrative.scene.open", input_template: { scene_id: { data_key: "item.id" } } },
  },
};

test("authoring surface renders a navigable outline and context as escaped Host UI", () => {
  const html = renderToStaticMarkup(createElement(AuthoringSurface, {
    surface: outlineSurface,
    data: { tree: { items: [{ id: "scene-1", title: "第一章 <scene>", kind: "scene", path: "manuscript/1.md" }] } },
    onInvoke: async () => ({ ok: true }),
    onClose: () => undefined,
  }));
  assert.match(html, /authoring-surface-context">選択中の作品/u);
  assert.match(html, /role="tree"/u);
  assert.match(html, /第一章 &lt;scene&gt;/u);
  assert.match(html, /data-authoring-tree-id="scene-1"/u);
  assert.match(html, /作品構成を閉じる/u);
});

test("surface reports stale and unavailable states without removing its accessible title", () => {
  const stale = renderToStaticMarkup(createElement(AuthoringSurface, {
    surface: outlineSurface,
    status: "stale",
    onInvoke: async () => ({}),
  }));
  assert.match(stale, /ワークスペースが変更されています/u);
  assert.match(stale, /aria-labelledby="authoring-surface-narrative-outline"/u);

  const unavailable = renderToStaticMarkup(createElement(AuthoringSurface, {
    surface: outlineSurface,
    status: "unavailable",
    message: "Narrative plugin is disabled.",
    onInvoke: async () => ({}),
  }));
  assert.match(unavailable, /Narrative plugin is disabled\./u);
  assert.doesNotMatch(unavailable, /role="tree"/u);
});

test("action templates substitute declared data keys and reject missing or invalid keys", () => {
  assert.deepEqual(resolveAuthoringTemplate({ data_key: "item.scene_id" }, { item: { scene_id: "s-1" } }), "s-1");
  assert.throws(() => resolveAuthoringTemplate({ data_key: "item.__proto__" }, { item: {} }), /invalid data key/u);
  assert.throws(() => resolveAuthoringTemplate({ data_key: "item.id" }, { item: {} }), /missing declared data key/u);
});

test("integer form values become safe JSON numbers and invalid values fail before dispatch", () => {
  const fields = [{ id: "limit", label: "件数", type: "integer" as const }];
  assert.deepEqual(formValuesToJson(fields, { limit: "12" }), { limit: 12 });
  assert.deepEqual(formValuesToJson(fields, { limit: "" }), {});
  assert.throws(() => formValuesToJson(fields, { limit: "1.2" }), /整数/u);
  assert.throws(() => formValuesToJson(fields, { limit: "9007199254740992" }), /範囲外/u);
});

test("forms render Host-owned fields and inaccessible UI markup is not accepted as content", () => {
  const surface: AuthoringSurfaceDeclaration = {
    id: "create-scene", kind: "panel", title: "シーンを追加", context: { label: "第1章" },
    body: {
      id: "scene-form", type: "form", title: "新しいシーン",
      fields: [{ id: "title", label: "シーン名", type: "string", required: true }],
      submit: { action_id: "proprium.narrative.structure.create", input_template: { title: { data_key: "form.title" } } },
    },
  };
  const html = renderToStaticMarkup(createElement(AuthoringSurface, { surface, onInvoke: async () => ({}) }));
  assert.match(html, /<form/u);
  assert.match(html, /aria-labelledby="authoring-form-scene-form"/u);
  assert.match(html, /シーン名/u);
  assert.match(html, /送信/u);
  assert.doesNotMatch(html, /<script/u);
});

test("declared panel read is an explicit Host action with an accessible refresh control", () => {
  const surface: AuthoringSurfaceDeclaration = {
    ...outlineSurface,
    body: {
      ...outlineSurface.body,
      load_action: { action_id: "proprium.narrative.hierarchy.tree", input_template: { limit: 128 } },
    },
  };
  const html = renderToStaticMarkup(createElement(AuthoringSurface, {
    surface,
    onInvoke: async () => ({ items: [] }),
  }));
  assert.match(html, /class="authoring-load-action"/u);
  assert.match(html, />読み込む<\/button>/u);
});
