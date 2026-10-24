import assert from "node:assert/strict";
import test from "node:test";
import { ApiError } from "../api.js";
import { messageOf } from "./error-message.js";

test("only Hosted admission 401s are presented as expired browser sessions", () => {
  const dependencyFailure = new ApiError("GitHub credential provider is unavailable", 401, "git_credential_unavailable");
  assert.equal(messageOf(dependencyFailure), "GitHub credential provider is unavailable");

  const expiredSession = new ApiError("Authentication required", 401, "UNAUTHORIZED");
  assert.equal(messageOf(expiredSession), "セッションの有効期限が切れました。もう一度ログインしてください。");
});
