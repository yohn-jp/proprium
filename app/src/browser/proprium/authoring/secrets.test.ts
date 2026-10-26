import assert from "node:assert/strict";
import test from "node:test";
import {
  FixedOriginShareReaderTransport,
  PublishingSecretBroker,
  PublishingSecretError,
  PublishingShareReaderAdapter,
  ReaderSecretLeaseVault,
  ShareDestinationConsentAuthority,
  readonlyReaderHeaders,
  type DestinationConsentRequest,
  type SecretCreateRequest,
  type ShareProviderConfiguration,
} from "./secrets.js";

const config: ShareProviderConfiguration = {
  service_id: "reader.example",
  origin: "https://reader.example",
  host_public_origin: "https://writer.example",
  reader_version: 1,
  max_expiry_hours: 168,
  endpoints: {
    capabilities: "https://reader.example/api/publishing/capabilities",
    metadata: "https://reader.example/api/publishing/metadata",
    read_scene: "https://reader.example/api/publishing/read-scene",
  },
};
const scope = { workspace_id: "local-workspace", repository_id: 42, branch: "main", generation: "generation-4" };
const grant_scope = { kind: "chapter" as const, id: "chapter-3" };
const remote_commit = "a".repeat(64);
const now = Date.parse("2026-10-26T00:00:00.000Z");

class GestureTestAuthority {
  private readonly tokens = new WeakSet<object>();
  issue() { const token = {}; this.tokens.add(token); return token; }
  consume(token: object) { if (!this.tokens.has(token)) return false; this.tokens.delete(token); return true; }
}

function request(consent: object, patch: Partial<SecretCreateRequest> = {}): SecretCreateRequest {
  return {
    request_id: "request-7", idempotency_id: "d".repeat(64), request_digest: "b".repeat(64), scope, repository_id: 42, branch: "main", remote_commit,
    grant_scope, expires_at: new Date(now + 86_400_000).toISOString(), provider: config,
    provider_capability: { available: true, service_id: config.service_id, max_expiry_hours: 168 },
    destination_consent: consent,
    ...patch,
  };
}

function consentInput(r: SecretCreateRequest): DestinationConsentRequest {
  return { service_id: r.provider.service_id, origin: r.provider.origin, host_public_origin: r.provider.host_public_origin,
    repository_id: r.repository_id, branch: r.branch, remote_commit: r.remote_commit,
    grant_scope: r.grant_scope, expires_at: r.expires_at };
}

async function digest(token: string) {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
  return [...bytes].map(value => value.toString(16).padStart(2, "0")).join("");
}

test("share bearer remains private until applied proposal and one owner reveal", async () => {
  let time = now;
  const gestures = new GestureTestAuthority(); const consents = new ShareDestinationConsentAuthority();
  const broker = new PublishingSecretBroker(gestures, consents, () => time);
  const first = request({}, {});
  const consent = consents.issue({ isTrusted: true } as Event, consentInput(first));
  const input = request(consent);
  const created = await broker.create(input, gestures.issue());
  assert.match(created.handle, /^[A-Za-z0-9_-]{32}$/u);
  assert.match(created.sha256, /^[a-f0-9]{64}$/u);
  assert.deepEqual(Object.keys(created).sort(), ["handle", "sha256"]);
  assert.equal((JSON.stringify(created) ?? "").includes("token="), false);
  assert.equal(broker.status("proposal-4"), "unavailable");

  assert.throws(() => broker.revealApprovedUrl(created.handle, "ui", gestures.issue(), config.host_public_origin),
    error => error instanceof PublishingSecretError && error.code === "file_not_found");
  // The token capability binds to the one exact ChangeSet admitted by the Host writer.
  broker.associateProposal(input.idempotency_id, "proposal-4", "grant-9");
  assert.throws(() => broker.associateProposal(input.idempotency_id, "proposal-4", "grant-9"),
    error => error instanceof PublishingSecretError && error.code === "invalid_input");
  assert.equal(broker.status("proposal-4"), "pending");
  broker.markApplied("proposal-4");
  assert.equal(broker.status("proposal-4"), "approved");
  assert.throws(() => broker.revealApprovedUrl(created.handle, "mcp", gestures.issue(), config.host_public_origin),
    error => error instanceof PublishingSecretError && error.code === "capability_denied");
  const url = broker.revealApprovedUrl(created.handle, "ui", gestures.issue(), config.host_public_origin);
  const parsed = new URL(url);
  const token = new URLSearchParams(parsed.hash.slice(1)).get("token")!;
  assert.equal(parsed.origin, config.host_public_origin);
  assert.equal(parsed.pathname, "/r/publishing/42/grant-9");
  assert.match(token, /^[A-Za-z0-9_-]{43}$/u);
  assert.equal(await digest(token), created.sha256);
  assert.equal(broker.status("proposal-4"), "unavailable");
  assert.throws(() => broker.revealApprovedUrl(created.handle, "ui", gestures.issue(), config.host_public_origin),
    error => error instanceof PublishingSecretError && error.code === "file_not_found");
  time += 1;
});

test("share creation denies forged gesture, mismatched consent, expired snapshot and absent provider", async () => {
  const gestures = new GestureTestAuthority(); const consents = new ShareDestinationConsentAuthority();
  const broker = new PublishingSecretBroker(gestures, consents, () => now);
  const seed = request({});
  const consent = consents.issue({ isTrusted: true } as Event, consentInput(seed));
  const valid = request(consent);
  assert.rejects(broker.create(valid, {}), error => error instanceof PublishingSecretError && error.code === "capability_denied");

  const wrongConsent = consents.issue({ isTrusted: true } as Event, consentInput(valid));
  const changed = request(wrongConsent, { repository_id: 99, scope: { ...scope, repository_id: 99 } });
  await assert.rejects(broker.create(changed, gestures.issue()), error => error instanceof PublishingSecretError && error.code === "capability_denied");
  await assert.rejects(broker.create(request(consent, { provider_capability: { available: false, service_id: config.service_id, max_expiry_hours: 168 } }), gestures.issue()),
    error => error instanceof PublishingSecretError && error.code === "capability_denied");
  await assert.rejects(broker.create(request(consent, { expires_at: new Date(now - 1).toISOString() }), gestures.issue()),
    error => error instanceof PublishingSecretError && error.code === "capability_denied");
});

test("same action key reuses only the same exact request and rejected proposals destroy the token", async () => {
  const gestures = new GestureTestAuthority(); const consents = new ShareDestinationConsentAuthority();
  const broker = new PublishingSecretBroker(gestures, consents, () => now);
  const seed = request({}); const c = consents.issue({ isTrusted: true } as Event, consentInput(seed)); const input = request(c);
  const first = await broker.create(input, gestures.issue());
  const same = await broker.create(request(c, { request_id: "retry-request-8" }), gestures.issue());
  assert.deepEqual(same, first);
  const differentDigest = request(c, { request_digest: "c".repeat(64) });
  await assert.rejects(broker.create(differentDigest, gestures.issue()), error => error instanceof PublishingSecretError && error.code === "idempotency_conflict");
  broker.associateProposal(input.idempotency_id, "proposal-5", "grant-10");
  broker.rejectProposal("proposal-5");
  assert.equal(broker.status("proposal-5"), "unavailable");
  assert.throws(() => broker.markApplied("proposal-5"), error => error instanceof PublishingSecretError && error.code === "file_not_found");
});

test("reader route strips fragment before provider calls and binds the in-memory lease to scope", async () => {
  const token = "a".repeat(43);
  const calls: string[] = [];
  const vault = new ReaderSecretLeaseVault();
  const route = vault.takeFromLocation({ pathname: "/r/publishing/42/grant-9", search: "?mode=reader", hash: `#token=${token}` },
    { state: { navigation: "existing" }, replaceState(_data, _unused, url) { calls.push(String(url)); } });
  assert.deepEqual(calls, ["/r/publishing/42/grant-9"]);
  let seen = "";
  await vault.withBearer(route.lease, route, async bearer => { seen = bearer; return undefined; });
  assert.equal(seen, token);
  assert.throws(() => vault.withBearer(route.lease, { ...route, repository_id: 43 }, async () => undefined),
    error => error instanceof PublishingSecretError && error.code === "provider_unavailable");
  vault.clear(route.lease);
  assert.throws(() => vault.withBearer(route.lease, route, async () => undefined),
    error => error instanceof PublishingSecretError && error.code === "provider_unavailable");

  for (const hash of [`#token=${token}&token=${token}`, `#token=${token}&url=https://evil.example`, "#token=bad"]) {
    let scrubbed = false;
    assert.throws(() => vault.takeFromLocation({ pathname: "/r/publishing/42/grant-9", search: "", hash },
      { state: null, replaceState() { scrubbed = true; } }), error => error instanceof PublishingSecretError && error.code === "provider_unavailable");
    assert.equal(scrubbed, true);
  }
});

test("provider transport pins HTTPS origin, sends bearer only in Authorization, and rejects redirects", async () => {
  const seen: Array<{ url: string; init: RequestInit }> = [];
  const transport = new FixedOriginShareReaderTransport(config, async (input, init) => {
    seen.push({ url: String(input), init: init! });
    return new Response(JSON.stringify({ available: true, service_id: config.service_id, origin: config.origin,
      host_public_origin: config.host_public_origin, reader_version: 1, max_expiry_hours: 168 }), {
      status: 200, headers: { "Content-Type": "application/json" },
    });
  });
  await transport.capabilities({ repository_id: 42, branch: "main", remote_commit });
  assert.equal(seen[0]!.init.redirect, "error");
  assert.equal(seen[0]!.init.credentials, "omit");
  assert.equal(seen[0]!.init.cache, "no-store");
  assert.equal(seen[0]!.init.referrerPolicy, "no-referrer");
  assert.equal((seen[0]!.init.headers as Record<string, string>).Authorization, undefined);

  const adapter = new PublishingShareReaderAdapter(config, transport);
  const route = adapter.takeRouteFromLocation({ pathname: "/r/publishing/42/grant-9", search: "", hash: `#token=${"b".repeat(43)}` }, { state: null, replaceState() {} });
  // Adapter validates response metadata and does not return the bearer in the provider result.
  const invalidMeta = await adapter.metadata(route).catch(error => error);
  assert.ok(invalidMeta instanceof PublishingSecretError);

  const bodyBytes = new TextEncoder().encode("本文です。\n");
  const bodyHash = await digest(new TextDecoder().decode(bodyBytes));
  const fixedWire = new FixedOriginShareReaderTransport(config, async (input, init) => {
    assert.equal(new URL(String(input)).origin, config.origin);
    assert.equal((init!.headers as Record<string, string>).Authorization, `Bearer ${"c".repeat(43)}`);
    const operation = new URL(String(input)).pathname;
    if (operation.endsWith("metadata")) return new Response(JSON.stringify({
      remote_snapshot: { repository_id: 42, branch: "main", remote_commit }, scope: { kind: "chapter", id: "chapter-3" },
      label: "試し読み", expires_at: new Date(now + 86_400_000).toISOString(),
      items: [{ id: "scene-1", kind: "scene", title: "第一話", parent_id: "chapter-3" }], next_cursor: null,
    }), { status: 200, headers: { "Content-Type": "application/json" } });
    return new Response(JSON.stringify({ remote_snapshot: { repository_id: 42, branch: "main", remote_commit },
      scene: { id: "scene-1", title: "第一話", revision: bodyHash, total_bytes: bodyBytes.length,
        offset: 0, bytes: [...bodyBytes], next_offset: null },
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  });
  const goodAdapter = new PublishingShareReaderAdapter(config, fixedWire);
  const secretRoute = goodAdapter.takeRouteFromLocation({ pathname: "/r/publishing/42/grant-9", search: "", hash: `#token=${"c".repeat(43)}` }, { state: null, replaceState() {} });
  const tree = await goodAdapter.metadata(secretRoute);
  assert.equal(tree.items[0]!.id, "scene-1");
  const page = await goodAdapter.readScene(secretRoute, "scene-1", remote_commit);
  assert.ok(page.scene.bytes instanceof Uint8Array);
  assert.equal(new TextDecoder().decode(page.scene.bytes), "本文です。\n");

  const rejected = new FixedOriginShareReaderTransport(config, async (_input, init) => {
    assert.equal((init!.headers as Record<string, string>).Authorization, `Bearer ${"b".repeat(43)}`);
    return new Response("same unavailable response", { status: 404 });
  });
  await assert.rejects(rejected.metadata({ service_id: config.service_id, repository_id: 42, grant_id: "grant-9" }, "b".repeat(43)),
    error => error instanceof PublishingSecretError && error.message === "This shared reading link is unavailable.");
  const unauthorized = new FixedOriginShareReaderTransport(config, async () => new Response("different body", { status: 401 }));
  await assert.rejects(unauthorized.metadata({ service_id: config.service_id, repository_id: 42, grant_id: "grant-9" }, "b".repeat(43)),
    error => error instanceof PublishingSecretError && error.message === "This shared reading link is unavailable.");
  assert.deepEqual(readonlyReaderHeaders(), { "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow", "Referrer-Policy": "no-referrer" });
});
