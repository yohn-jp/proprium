import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { GitHubAuthorizationError, GitHubDeviceAuthorization } from "./GitHubDeviceAuthorization.js";

test("device authorization shows Japanese copy, expiry, retry and cancel actions", () => {
  const markup = renderToStaticMarkup(createElement(GitHubDeviceAuthorization, {
    prompt: { userCode: "ABCD-EFGH", verificationUri: "https://github.com/login/device", expiresAt: Date.now() - 1 },
    stage: "waiting",
    onRetry: () => undefined,
    onCancel: () => undefined,
  }));
  assert.match(markup, /ABCD-EFGH/u);
  assert.match(markup, /コードをコピー/u);
  assert.match(markup, /認証コードの有効期限が切れました/u);
  assert.match(markup, /新しい認証コードを取得/u);
  assert.match(markup, /GitHub接続をキャンセル/u);
});

test("authorization failure offers a clear retry", () => {
  const markup = renderToStaticMarkup(createElement(GitHubAuthorizationError, { message: "Gatewayに接続できません。", onRetry: () => undefined }));
  assert.match(markup, /Gatewayに接続できません/u);
  assert.match(markup, /もう一度試す/u);
});
