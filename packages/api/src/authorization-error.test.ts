import assert from "node:assert/strict";
import { test } from "node:test";
import { authorizationFailure } from "./authorization-error.js";

test("authorization distinguishes dependency outages from credential and permission denial", () => {
  for (const permission of ["read", "write"] as const) {
    for (const status of [502, 503] as const) {
      const result = authorizationFailure(Object.assign(new Error("secret provider detail"), { status }), permission);
      assert.equal(result.status, status);
      assert.equal(result.code, "AUTHORIZATION_UNAVAILABLE");
      assert.ok(!result.message.includes("secret"));
    }
    assert.equal(authorizationFailure({ status: 401 }, permission).status, 401);
    assert.equal(authorizationFailure({ status: 403 }, permission).status, 403);
    assert.equal(authorizationFailure(new Error("unexpected"), permission).status, 503);
  }
});
