import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { GatewayAccessLink, gatewayAccessLandingUrl } from "./GatewayAccessLink.js";

test("Access link routes to the protected authentication landing and rejects arbitrary paths", () => {
  assert.equal(gatewayAccessLandingUrl("https://gateway.example"), "https://gateway.example/auth");
  assert.equal(gatewayAccessLandingUrl("http://localhost:8080/"), "http://localhost:8080/auth");
  assert.equal(gatewayAccessLandingUrl("https://gateway.example/healthz"), null);
  assert.equal(gatewayAccessLandingUrl("https://user:password@gateway.example"), null);
  const markup = renderToStaticMarkup(createElement(GatewayAccessLink, { gatewayUrl: "https://gateway.example" }));
  assert.match(markup, /href="https:\/\/gateway\.example\/auth"/u);
  assert.doesNotMatch(markup, /healthz/u);
});
