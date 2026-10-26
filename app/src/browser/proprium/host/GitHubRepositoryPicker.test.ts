import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { GitHubRepositoryPicker } from "./GitHubRepositoryPicker.js";
import type { GitHubRepository } from "../git/github-sync.js";

test("repository picker labels its host-owned repository and branch fields", () => {
  const repository: GitHubRepository = {
    id: 12,
    fullName: "writer/notes",
    owner: "writer",
    name: "notes",
    defaultBranch: "main",
    private: true,
    permissions: { pull: false, push: false },
  };
  const markup = renderToStaticMarkup(createElement(GitHubRepositoryPicker, {
    session: null,
    repositories: [repository],
    selectedRepositoryId: 12,
    selectedBranch: "main",
    onRepositoryChange: () => undefined,
    onBranchChange: () => undefined,
    idPrefix: "dialog",
  }));
  assert.match(markup, /dialog-repository-picker/u);
  assert.match(markup, /dialog-branch-picker/u);
  assert.match(markup, /読み取り権限なし/u);
});
