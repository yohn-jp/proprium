import assert from "node:assert/strict";
import test from "node:test";
import { createElement, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { UiContribution } from "@scriptorium/contracts";
import { ApplicationStatus, hasApplicationStatus } from "./ApplicationStatus";
import { availableModulePanels } from "./AvailableModulePanels";
import { DocumentInspector } from "./DocumentInspector";
import { LibraryOutline } from "./LibraryOutline";

const tree = {
  title: "Novel",
  volumes: [{
    id: "volume-1",
    title: "Volume One",
    chapters: [{ id: "chapter-1", title: "Chapter One", scenes: [{ id: "scene-1", title: "Opening" }] }],
  }],
};

test("status presentation hides an empty state and exposes current errors and recovery visibility", () => {
  const emptyProps = {
    status: { message: "", kind: "normal" },
    globalError: "",
    journalOpenError: "",
    isolatedRecoveryCount: 0,
    remoteState: "fresh",
  } as const;
  assert.equal(hasApplicationStatus(emptyProps), false);
  const empty = renderToStaticMarkup(createElement(ApplicationStatus, emptyProps));
  assert.match(empty, /保存と接続/u);
  assert.doesNotMatch(empty, /<details[^>]* open/u);

  const visible = renderToStaticMarkup(createElement(ApplicationStatus, {
    status: { message: "保存に失敗しました", kind: "error" },
    globalError: "通信を確認してください",
    journalOpenError: "回復記録を開けません",
    isolatedRecoveryCount: 2,
    remoteState: "failed",
  }));
  assert.match(visible, /aria-live="assertive"/u);
  assert.match(visible, /role="alert"/u);
  assert.match(visible, /回復記録 2 件/u);
  assert.match(visible, /リモート確認状態: failed/u);
});

test("library outline renders project, continuation, scene, and recovery controls from explicit props", () => {
  const markup = renderToStaticMarkup(createElement(LibraryOutline, {
    hostedMode: false,
    busy: "",
    projects: [{ id: "project-1", url: "https://github.com/owner/work.git", branch: "main" }],
    activeProjectId: "project-1",
    projectManagement: null,
    tree,
    selectedSceneId: "scene-1",
    continueCandidates: [],
    deviceType: "desktop",
    continueError: "",
    legacyDrafts: [],
    legacySelectedSceneId: "",
    recoverableEntries: [],
    onRegisterProject: () => undefined,
    onActivateProject: () => undefined,
    onContinue: () => undefined,
    onSelectScene: () => undefined,
    onExportLegacyDrafts: () => undefined,
    onMapLegacyDraft: () => undefined,
  }));
  assert.match(markup, /class="sidebar"/u);
  assert.match(markup, /github\.com\/owner\/work/u);
  assert.match(markup, /aria-current="true"/u);
  assert.match(markup, /class="continue-panel"/u);
  assert.match(markup, /作品構成/u);
  assert.match(markup, /Chapter One: Opening/u);
});

test("document inspector renders only the document facts and recovery records it receives", () => {
  const markup = renderToStaticMarkup(createElement(DocumentInspector, {
    status: createElement("p", null, "保存状態"),
    editorFacts: { path: "manuscript/opening.md", snapshot: "snapshot-1", recoveryStatus: "ready" },
    inspectedDocument: { path: "notes/outline.md", content: "Outline text" },
    recoveryEntries: [],
  }));
  assert.match(markup, /aria-label="文書と保存状態"/u);
  assert.match(markup, /manuscript\/opening\.md/u);
  assert.match(markup, /snapshot-1/u);
  assert.match(markup, /notes\/outline\.md/u);
  assert.match(markup, /Outline text/u);
});

test("available module panels retain host catalog checks and the no-project placeholder", () => {
  const contribution: UiContribution = {
    id: "story:panel",
    module: "story",
    slot: "dock",
    title: "Story tools",
    action: "story.search",
  };
  const panels = availableModulePanels({
    items: [contribution],
    contributions: [contribution],
    modules: [{ id: "story", availability: "active", activeJobs: 0 }],
    projectId: null,
    authorScope: "author:one",
    snapshot: null,
    journal: null,
    refresh: async () => undefined,
    onProposalStored: () => undefined,
    readCurrentEditor: () => null,
    navigateDocument: async () => undefined,
  });
  assert.deepEqual(panels.map(({ id, title }) => [id, title]), [["module:story:panel", "Story tools"]]);
  const markup = renderToStaticMarkup(createElement(Fragment, null, panels[0]!.render()));
  assert.match(markup, /作品を選択してください/u);
});
