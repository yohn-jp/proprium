import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AuthoringSurface, formValuesToJson, initialFormValues, mergeInitialFormValues, omitAbsentOptionalFormInputs, optionsForRecordField, resolveAuthoringNavigation, resolveAuthoringTemplate } from "./AuthoringSurface.js";
import type { AuthoringSurfaceDeclaration } from "./types.js";
import { validateAuthoringSurfaceDeclaration } from "./validate.js";

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

test("every official signed surface fits the Host renderer while pathological JSON remains bounded", () => {
  for (const name of ["narrative", "knowledge", "research", "paired-writing", "diagnostics", "speaker", "semantic", "publishing"]) {
    const manifest = JSON.parse(readFileSync(new URL(`../../../../../../plugins/${name}/plugin.json`, import.meta.url), "utf8"));
    for (const surface of manifest.ui) assert.doesNotThrow(() => validateAuthoringSurfaceDeclaration(surface), `${name}:${surface.id}`);
  }
  assert.throws(() => validateAuthoringSurfaceDeclaration({ ...outlineSurface, context: { values: Array(1024).fill(0) } }), /nesting or item limit/u);
  let deep: unknown = "leaf";
  for (let i = 0; i < 20; i++) deep = { value: deep };
  assert.throws(() => validateAuthoringSurfaceDeclaration({ ...outlineSurface, context: deep }), /nesting or item limit/u);
});

test("unchecked required boolean fields submit false while optional fields stay absent", () => {
  const fields = [
    { id: "appendix", type: "boolean" as const, label: "Include appendix", required: true },
    { id: "optional", type: "boolean" as const, label: "Optional flag" },
  ];
  const values = initialFormValues(fields, {});
  assert.deepEqual(formValuesToJson(fields, values), { appendix: false });
});

test("optional absent form values are omitted from inputs without hiding missing required or unknown keys", () => {
  const fields = [{ id: "title", type: "string" as const, label: "Title" },
    { id: "appendix", type: "boolean" as const, label: "Appendix", required: true }];
  const binding = { action_id: "publishing.export", input_template: { title: { data_key: "form.title" }, appendix: { data_key: "form.appendix" } } };
  const form = { appendix: false };
  const pruned = omitAbsentOptionalFormInputs(binding, fields, form);
  assert.deepEqual(resolveAuthoringTemplate(pruned.input_template, { form }), { appendix: false });
  const filled = { title: "A book", appendix: false };
  assert.deepEqual(resolveAuthoringTemplate(omitAbsentOptionalFormInputs(binding, fields, filled).input_template, { form: filled }), filled);
  assert.throws(() => resolveAuthoringTemplate(omitAbsentOptionalFormInputs(binding, fields, {}).input_template, { form: {} }), /missing declared data key/u);
  const typo = { action_id: "publishing.export", input_template: { title: { data_key: "form.typo" } } };
  assert.throws(() => resolveAuthoringTemplate(omitAbsentOptionalFormInputs(typo, fields, {}).input_template, { form: {} }), /missing declared data key/u);
});

test("active nested tab exposes its signed read and separate detail/source controls", () => {
  const surface: AuthoringSurfaceDeclaration = {
    id: "bible", kind: "panel", title: "Bible", context: {},
    body: { id: "tabs", type: "tabs", tabs: [{ id: "characters", title: "Characters", body: {
      id: "characters-list", type: "list", title: "Character records",
      load_action: { action_id: "knowledge.entities.list", input_template: { type: "character" } },
      items: { data_key: "records" }, primary: "name",
      item_action: { action_id: "knowledge.entities.get", input_template: { id: { data_key: "item.id" } } },
      item_navigation: { intent: "open", target: { path: { data_key: "item.path" } } },
    } }] },
  };
  const html = renderToStaticMarkup(createElement(AuthoringSurface, { surface,
    data: { records: [{ id: "alice", name: "Alice", path: "characters/alice.yaml" }] },
    onInvoke: async () => ({}), onRead: async () => ({ ok: true }),
  }));
  assert.match(html, /Character recordsを読み込む/u);
  assert.match(html, /<strong>Alice<\/strong>/u);
  assert.match(html, /Aliceの原文を開く/u);
});

test("authoring surface renders a navigable outline and context as escaped Host UI", () => {
  const html = renderToStaticMarkup(createElement(AuthoringSurface, {
    surface: outlineSurface,
    data: { tree: { items: [{ id: "scene-1", title: "第一章 <scene>", kind: "scene", path: "manuscript/1.md" }] } },
    onInvoke: async () => ({ ok: true }),
    onRead: async () => ({ ok: true }),
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
    onRead: async () => ({ ok: true }),
  }));
  assert.match(stale, /ワークスペースが変更されています/u);
  assert.match(stale, /aria-labelledby="authoring-surface-narrative-outline"/u);

  const unavailable = renderToStaticMarkup(createElement(AuthoringSurface, {
    surface: outlineSurface,
    status: "unavailable",
    message: "Narrative plugin is disabled.",
    onInvoke: async () => ({}),
    onRead: async () => ({ ok: true }),
  }));
  assert.match(unavailable, /Narrative plugin is disabled\./u);
  assert.doesNotMatch(unavailable, /role="tree"/u);
});

test("action templates substitute declared data keys and reject missing or invalid keys", () => {
  assert.deepEqual(resolveAuthoringTemplate({ data_key: "item.scene_id" }, { item: { scene_id: "s-1" } }), "s-1");
  assert.deepEqual(resolveAuthoringTemplate({ data_key: "item.sources.0.path" }, { item: { sources: [{ path: "notes/source.md" }] } }), "notes/source.md");
  assert.throws(() => resolveAuthoringTemplate({ data_key: "item.__proto__" }, { item: {} }), /invalid data key/u);
  assert.throws(() => resolveAuthoringTemplate({ data_key: "item.id" }, { item: {} }), /missing declared data key/u);
});

test("navigation resolves optional evidence spans and rejects an empty or malformed target", () => {
  const data = { item: { path: "notes/source.md", navigationSpan: null } };
  const binding = {
    intent: "open" as const,
    target: {
      path: { data_key: "item.path" },
      span: { data_key: "item.navigationSpan" },
    },
  };
  assert.deepEqual(resolveAuthoringNavigation(binding, data), {
    target: { path: "notes/source.md", panel_id: undefined, span: undefined },
    intent: "open",
  });
  assert.deepEqual(resolveAuthoringNavigation({
    intent: "open",
    target: {
      path: { data_key: "item.path" },
      span: { path: { data_key: "item.path" }, revision: "rev-1", start: 4, end: 9, quote: "quote" },
    },
  }, data).target.span, { path: "notes/source.md", revision: "rev-1", start: 4, end: 9, quote: "quote" });
  assert.throws(() => resolveAuthoringNavigation({ intent: "open", target: {} }, data), /target is invalid/u);
  assert.throws(() => resolveAuthoringNavigation({
    intent: "open",
    target: { path: { data_key: "item.path" }, span: { path: "notes/source.md", start: 9, end: 4 } },
  }, data), /span is invalid/u);
});

test("integer form values become safe JSON numbers and invalid values fail before dispatch", () => {
  const fields = [{ id: "limit", label: "件数", type: "integer" as const }];
  assert.deepEqual(formValuesToJson(fields, { limit: "12" }), { limit: 12 });
  assert.deepEqual(formValuesToJson(fields, { limit: "" }), {});
  assert.throws(() => formValuesToJson(fields, { limit: "1.2" }), /整数/u);
  assert.throws(() => formValuesToJson(fields, { limit: "9007199254740992" }), /範囲外/u);
  assert.deepEqual(formValuesToJson([{ id: "scene_ids", label: "話", type: "ordered-list" }], { scene_ids: [] }), { scene_ids: [] });
});

test("form fields initialize from declared data keys while untouched optional fields stay sparse", () => {
  const fields = [
    { id: "title", label: "題名", type: "string" as const, initial_value: { data_key: "load.episode.title" } },
    { id: "order", label: "順序", type: "integer" as const, initial_value: { data_key: "load.episode.order" } },
    { id: "note", label: "メモ", type: "string" as const },
  ];
  const html = renderToStaticMarkup(createElement(AuthoringSurface, {
    surface: {
      id: "episode-edit", kind: "panel", title: "話数", context: { label: "公開回" },
      body: { id: "edit", type: "form", fields, submit: { action_id: "proprium.publishing.episode_map.propose", input_template: { title: { data_key: "form.title" } } } },
    },
    data: { load: { episode: { title: "第一話", order: 1 } } },
    onInvoke: async () => ({}), onRead: async () => ({ ok: true }),
  }));
  assert.match(html, /value="第一話"/u);
  assert.match(html, /value="1"/u);
  assert.deepEqual(formValuesToJson(fields, { title: "第一話", order: 1, note: undefined }), { title: "第一話", order: 1 });
});

test("record-list forms retain unknown row data, edit declared fields, and preserve row order", () => {
  const fields = [{
    id: "episodes", label: "話数", type: "record-list" as const, key_field: "episode_id",
    initial_value: { data_key: "last_action_result.episodes" },
    fields: [
      { id: "title", label: "題名", type: "string" as const, required: true },
      { id: "order", label: "順序", type: "integer" as const },
    ],
  }];
  const original = [
    { episode_id: "e-2", title: "二話", order: 2, future_key: { retained: true } },
    { episode_id: "e-1", title: "一話", order: 1, extra: ["kept"] },
  ];
  const html = renderToStaticMarkup(createElement(AuthoringSurface, {
    surface: {
      id: "episode-edit", kind: "panel", title: "話数を編集", context: {},
      body: {
        id: "episodes", type: "form", fields,
        submit: { action_id: "proprium.publishing.episode_map.propose", input_template: { episodes: { data_key: "form.episodes" } } },
      },
    },
    data: { last_action_result: { episodes: original } },
    onInvoke: async () => ({}),
    onRead: async () => ({ ok: true }),
  }));
  assert.match(html, /value="二話"/u);
  assert.match(html, /value="一話"/u);
  assert.match(html, /aria-label="話数 1を下へ"/u);
  const result = formValuesToJson(fields, { episodes: [
    { ...original[1], title: "一話改訂", order: "1" },
    { ...original[0], title: "二話改訂", order: "2" },
  ] });
  assert.deepEqual(result, { episodes: [
    { episode_id: "e-1", title: "一話改訂", order: 1, extra: ["kept"] },
    { episode_id: "e-2", title: "二話改訂", order: 2, future_key: { retained: true } },
  ] });
});

test("changing dependent select data keeps edited record rows and current choices", () => {
  const fields = [{ id: "episodes", label: "話", type: "record-list" as const, fields: [{ id: "title", label: "題名", type: "string" as const }] },
    { id: "scope_id", label: "章", type: "enum" as const, options: { data_key: "last_action_result.items" }, option_value_key: "id", option_label_key: "title" }];
  const original = [{ episode_id: "e-1", title: "原題", future: "retained" }];
  const previousInitial = { episodes: original };
  const current = { episodes: [{ episode_id: "e-1", title: "編集中", future: "retained" }], scope_id: "chapter-1" };
  const nextInitial = { episodes: original };
  assert.deepEqual(mergeInitialFormValues(fields, current, previousInitial, nextInitial), current);
});

test("record-list dynamic options preserve selected values from earlier pages", () => {
  const field = { id: "scope_id", label: "章", type: "enum" as const,
    options: { data_key: "last_action_result.items" }, option_value_key: "id", option_label_key: "title" };
  assert.deepEqual(optionsForRecordField(field, { last_action_result: { items: [{ id: "chapter-2", title: "第二章" }] } }, "chapter-1"), [
    { value: "chapter-2", label: "第二章" },
    { value: "chapter-1", label: "chapter-1（現在の値を保持）" },
  ]);
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
  const html = renderToStaticMarkup(createElement(AuthoringSurface, { surface, onInvoke: async () => ({}), onRead: async () => ({ ok: true }) }));
  assert.match(html, /<form/u);
  assert.match(html, /aria-labelledby="authoring-form-scene-form"/u);
  assert.match(html, /シーン名/u);
  assert.match(html, /送信/u);
  assert.doesNotMatch(html, /<script/u);
});

test("form confirmation is a bounded Host-owned confirmation declaration", () => {
  const surface: AuthoringSurfaceDeclaration = {
    id: "share-create", kind: "panel", title: "共有リンク", context: {},
    body: {
      id: "create", type: "form", fields: [{ id: "scope", label: "範囲", type: "enum", options: [{ value: "chapter", label: "章" }] }],
      submit: { action_id: "proprium.publishing.shares.create", input_template: { scope: { data_key: "form.scope" } } },
      confirmation: { title: "共有リンクを作成しますか", message: "選択範囲を外部サービスへ登録します。", continue_label: "確認して続ける" },
    },
  };
  const html = renderToStaticMarkup(createElement(AuthoringSurface, { surface, onInvoke: async () => ({}), onRead: async () => ({ ok: true }) }));
  assert.match(html, /class="authoring-form-confirmation"/u);
  assert.match(html, /選択範囲を外部サービスへ登録します/u);
  assert.match(html, /確認して続ける/u);
  assert.throws(() => validateAuthoringSurfaceDeclaration({ ...surface, body: { ...surface.body, confirmation: { title: "a", message: "b", html: "<script/>" } } }), /unsupported fields/u);
});

test("enum options can bind to current declared action data and availability can disable submission", () => {
  const value = {
    id: "episode-scope", kind: "panel", title: "公開回", context: {},
    body: {
      id: "scope-form", type: "form", fields: [{ id: "scope_id", label: "章", type: "enum", required: true,
        options: { data_key: "last_action_result.items" }, option_value_key: "id", option_label_key: "title" }],
      submit: { action_id: "proprium.publishing.export.txt", input_template: { scope_id: { data_key: "form.scope_id" } } },
      submit_when: { data_key: "load.capabilities.export_available" }, unavailable_message: "現在の公開範囲を取得できません。",
    },
  };
  const surface = validateAuthoringSurfaceDeclaration(value);
  const html = renderToStaticMarkup(createElement(AuthoringSurface, {
    surface, data: { load: { capabilities: { export_available: false } }, last_action_result: { items: [{ id: "ch-1", title: "第一章" }] } },
    onInvoke: async () => ({}), onRead: async () => ({ ok: true }),
  }));
  assert.match(html, /<option value="ch-1">第一章<\/option>/u);
  assert.match(html, /現在の公開範囲を取得できません/u);
  assert.match(html, /<button type="submit" disabled="">送信<\/button>/u);
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
    onRead: async () => ({ ok: true }),
  }));
  assert.match(html, /class="authoring-load-action"/u);
  assert.match(html, />読み込む<\/button>/u);
});

test("surface validator admits only bounded Host widgets and fixed action/navigation bindings", () => {
  const validated = validateAuthoringSurfaceDeclaration({
    id: "search",
    kind: "panel",
    title: "検索",
    context: { label: "現在のWorkspace" },
    body: {
      id: "results",
      type: "list",
      items: { data_key: "last_action_result.hits" },
      primary: "title",
      secondary: "path",
      load_actions: [
        { key: "tree", action_id: "proprium.narrative.hierarchy.tree", input_template: { limit: 128 } },
        { key: "episodes", action_id: "proprium.publishing.episodes.read", input_template: {} },
      ],
      next_action: { action_id: "proprium.research.search.query", input_template: { cursor: { data_key: "last_action_result.next_cursor" }, query: { data_key: "last_action_result.query" } } },
      next_action_when: { data_key: "last_action_result.next_cursor" },
      item_navigation: { intent: "open", target: { path: { data_key: "item.path" }, span: { data_key: "item.navigation_span" } } },
    },
  });
  assert.equal(validated.body.type, "list");
  assert.equal(validated.body.load_actions?.length, 2);
  assert.throws(() => validateAuthoringSurfaceDeclaration({
    id: "bad", kind: "panel", title: "Bad", context: {}, body: { id: "bad-widget", type: "list", items: [], primary: "title", html: "<script/>" },
  }), /unsupported fields/u);
  assert.throws(() => validateAuthoringSurfaceDeclaration({
    id: "bad", kind: "panel", title: "Bad", context: {}, body: { id: "bad-widget", type: "form", fields: [], submit: { action_id: "proprium.x", input_template: { path: { data_key: "item.__proto__" } } } },
  }), /invalid key/u);
  const canonicalCaseSensitiveAction = validateAuthoringSurfaceDeclaration({
    id: "speaker-evaluation", kind: "panel", title: "評価", context: {},
    body: { id: "gate", type: "status", state: "ready", load_action: { action_id: "speaker.ruleGates", input_template: {} } },
  });
  assert.equal(canonicalCaseSensitiveAction.body.load_action?.action_id, "speaker.ruleGates");
});
