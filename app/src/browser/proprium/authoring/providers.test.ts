import assert from "node:assert/strict";
import { createServer, request as httpRequest, type Server } from "node:http";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { FreshGestureAuthority } from "./brokers.js";
import {
  ProviderRequestBroker,
  ProviderRequestError,
  type ProviderConfiguration,
  type ProviderRequestContext,
  type ProviderRequestInput,
} from "./providers.js";
import { ProviderRequestConsentDialog } from "../host/ProviderRequestConsentDialog.js";

const HOST_CREDENTIAL = "host-only-test-credential-3b0f82";
const PROVIDER_ENDPOINT = "https://provider.example.test/v1/complete";
const configuration: ProviderConfiguration = {
  provider_id: "test-provider",
  label: "Configured Test Provider",
  endpoint: PROVIDER_ENDPOINT,
  credential_handle: "host-provider-key-1",
  models: [{ model_id: "model-small", label: "Small Test Model", estimated_cost: "about 1 unit" }],
};
const context: ProviderRequestContext = {
  plugin_id: "proprium.paired-writing",
  action_id: "paired.rewrite.suggest",
  scope: { workspace_id: "workspace-local", repository_id: 73, branch: "main", generation: "generation-9" },
  snapshot: { id: "snapshot-12", local_commit: "a".repeat(40), worktree_generation: "worktree-8", draft_generation: "draft-4", remote_commit: "b".repeat(40) },
};

function input(patch: Partial<ProviderRequestInput> = {}): ProviderRequestInput {
  return {
    request_id: "provider-request-1",
    provider_id: "test-provider",
    model_id: "model-small",
    purpose: "Suggest three rewrites for the selected passage",
    payload: { instruction: "Keep the original meaning.", text: "A short selected passage." },
    source_manifest: { path: "manuscript/scene-1.md", revision: "c".repeat(64), start: 0, end: 27 },
    max_output_bytes: 4096,
    ...patch,
  };
}

function broker(options: {
  readonly providers?: readonly ProviderConfiguration[];
  readonly fetcher?: typeof fetch;
  readonly queryStatus?: ConstructorParameters<typeof ProviderRequestBroker>[0]["queryStatus"];
  readonly deadline_ms?: number;
} = {}) {
  const gestures = new FreshGestureAuthority();
  const instance = new ProviderRequestBroker({
    providers: options.providers ?? [configuration],
    credentials: { resolve: async handle => handle === configuration.credential_handle ? HOST_CREDENTIAL : undefined },
    gestures,
    fetcher: options.fetcher ?? globalThis.fetch,
    queryStatus: options.queryStatus,
    deadline_ms: options.deadline_ms,
  });
  return { instance, gestures };
}

function trustedClick(): Event { return { isTrusted: true } as Event; }

test("action provider route waits for separate exact-preview consent and checks freshness before egress", async () => {
  let sends=0;
  const {instance}=broker({fetcher:async()=>{sends++;return new Response(JSON.stringify({answer:"untrusted"}),{headers:{"content-type":"application/json"}});}});
  let stale=false;
  await assert.rejects(instance.requestWithConsent(input(),context,async (owner,preview,send) => {
    assert.equal(sends,0);
    assert.deepEqual(preview.context,context);
    assert.deepEqual(preview.request.payload,input().payload);
    const consent=owner.authorize(trustedClick(),preview);
    stale=true;
    return send(consent);
  },async()=>{if(stale)throw Object.assign(new Error("stale"),{code:"snapshot_stale"});}),{code:"snapshot_stale"});
  assert.equal(sends,0);
});

test("action provider route denies absent consent UI and cancels a pending preview", async () => {
  let sends=0;
  const {instance}=broker({fetcher:async()=>{sends++;throw new Error("must not send");}});
  await assert.rejects(instance.requestWithConsent(input(),context,undefined,async()=>{}),{code:"provider_unavailable"});
  const controller=new AbortController();
  let shown!:()=>void;
  const displayed=new Promise<void>(resolve=>{shown=resolve;});
  const pending=instance.requestWithConsent(input(),context,async()=>{shown();return new Promise<never>(()=>{});},async()=>{},controller.signal);
  await displayed;controller.abort();
  await assert.rejects(pending,{code:"cancelled"});
  assert.equal(sends,0);
});

test("cancelling an action after provider send preserves unknown external outcome", async () => {
  const controller=new AbortController();
  let sent!:()=>void;
  const started=new Promise<void>(resolve=>{sent=resolve;});
  const {instance}=broker({fetcher:async (_url,init)=>{
    sent();
    return new Promise<Response>((_resolve,reject)=>init!.signal!.addEventListener("abort",()=>reject(new DOMException("aborted","AbortError")),{once:true}));
  }});
  const pending=instance.requestWithConsent(input(),context,async(owner,preview,send)=>send(owner.authorize(trustedClick(),preview)),async()=>{},controller.signal);
  await started;controller.abort();
  await assert.rejects(pending,{code:"external_state_unknown"});
});

async function prepared(instance: ProviderRequestBroker, value = input()) {
  return instance.prepare(value, context);
}

async function withServer(handler: Parameters<typeof createServer>[0], body: (server: Server, port: number) => Promise<void>) {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try { await body(server, address.port); }
  finally { await new Promise<void>(resolve => server.close(() => resolve())); }
}

function loopbackTransport(port: number): typeof fetch {
  return async (target, init = {}) => {
    // Preserve the broker's configured HTTPS destination while terminating only in this local test server.
    assert.equal(String(target), PROVIDER_ENDPOINT);
    assert.equal(init.method, "POST");
    assert.equal(init.credentials, "omit");
    assert.equal(init.cache, "no-store");
    assert.equal(init.redirect, "error");
    assert.equal(init.referrerPolicy, "no-referrer");
    assert.equal(init.mode, "cors");
    const url = new URL(String(target));
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    const response = await new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }>((resolve, reject) => {
      const request = httpRequest({ hostname: "127.0.0.1", port, path: url.pathname, method: init.method, headers }, result => {
        const parts: Buffer[] = [];
        result.on("data", chunk => parts.push(Buffer.from(chunk)));
        result.on("end", () => resolve({ status: result.statusCode ?? 500, headers: result.headers, body: Buffer.concat(parts) }));
      });
      request.once("error", reject);
      const signal = init.signal;
      if (signal) {
        const abort = () => request.destroy(new Error("test transport aborted"));
        if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
      }
      if (typeof init.body === "string") request.end(init.body);
      else request.end();
    });
    return new Response(response.body, {
      status: response.status,
      headers: { "content-type": String(response.headers["content-type"] ?? "application/octet-stream") },
    });
  };
}

test("default-deny reports provider_unavailable without resolving credentials or touching the network", async () => {
  let credentialLookups = 0;
  let networkCalls = 0;
  const instance = new ProviderRequestBroker({
    providers: [],
    credentials: { resolve: async () => { credentialLookups += 1; return HOST_CREDENTIAL; } },
    gestures: new FreshGestureAuthority(),
    fetcher: async () => { networkCalls += 1; return new Response("{}"); },
  });
  assert.deepEqual(instance.status(), { available: false, provider_ids: [] });
  await assert.rejects(instance.prepare(input(), context), error => error instanceof ProviderRequestError && error.code === "provider_unavailable");
  assert.equal(credentialLookups, 0);
  assert.equal(networkCalls, 0);
});

test("an actual local synthetic HTTP receiver sees the fixed destination payload and Host credential only as Authorization", async () => {
  let received: { method?: string; url?: string; headers?: Record<string, string | string[] | undefined>; body?: string } | undefined;
  await withServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", chunk => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      received = { method: request.method, url: request.url, headers: request.headers, body: Buffer.concat(chunks).toString("utf8") };
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ suggestions: ["A measured rewrite."], usage: { input: 24 } }));
    });
  }, async (_server, port) => {
    const { instance } = broker({ fetcher: loopbackTransport(port) });
    const preview = await prepared(instance);
    const consent = instance.authorize(trustedClick(), preview);
    const result = await instance.request(preview, consent);

    assert.equal(received?.method, "POST");
    assert.equal(received?.url, "/v1/complete");
    assert.equal(received?.headers?.authorization, `Bearer ${HOST_CREDENTIAL}`);
    assert.equal(received?.headers?.cookie, undefined);
    assert.equal(received?.headers?.referer, undefined);
    assert.deepEqual(JSON.parse(received?.body ?? "{}"), input());
    assert.equal((received?.body ?? "").includes(HOST_CREDENTIAL), false);
    assert.equal(JSON.stringify(result).includes(HOST_CREDENTIAL), false);
    assert.equal(result.request_id, "provider-request-1");
    assert.deepEqual(result.scope, context.scope);
    assert.deepEqual(result.snapshot, context.snapshot);
    assert.equal(result.untrusted, true);
    assert.deepEqual(result.output, { suggestions: ["A measured rewrite."], usage: { input: 24 } });
  });
});

test("consent is a trusted one-use capability bound to endpoint, model, payload, manifest and snapshot", async () => {
  let networkCalls = 0;
  const { instance } = broker({ fetcher: async () => { networkCalls += 1; return new Response("{}", { headers: { "content-type": "application/json" } }); } });
  const first = await prepared(instance, input({ request_id: "consent-first" }));
  const second = await prepared(instance, input({ request_id: "consent-second", payload: { instruction: "Changed", text: "Different" } }));
  const consent = instance.authorize(trustedClick(), first);
  await assert.rejects(instance.request(second, consent), error => error instanceof ProviderRequestError && error.code === "capability_denied");
  await assert.rejects(instance.request(first, {}), error => error instanceof ProviderRequestError && error.code === "capability_denied");
  assert.throws(() => instance.authorize({ isTrusted: false } as Event, first), error => error instanceof ProviderRequestError && error.code === "capability_denied");
  assert.equal(networkCalls, 0);
});

test("cancellation before submission makes no credential lookup or provider request", async () => {
  let credentialLookups = 0;
  let networkCalls = 0;
  const gestures = new FreshGestureAuthority();
  const instance = new ProviderRequestBroker({
    providers: [configuration],
    credentials: { resolve: async () => { credentialLookups += 1; return HOST_CREDENTIAL; } },
    gestures,
    fetcher: async () => { networkCalls += 1; return new Response("{}"); },
  });
  const preview = await prepared(instance);
  const consent = instance.authorize(trustedClick(), preview);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(instance.request(preview, consent, controller.signal),
    error => error instanceof ProviderRequestError && error.code === "cancelled");
  assert.equal(credentialLookups, 0);
  assert.equal(networkCalls, 0);
});

test("guest cannot select endpoints, unlisted models, or place credentials in request data", async () => {
  const { instance } = broker({ fetcher: async () => new Response("{}") });
  await assert.rejects(instance.prepare(input({ ...input(), endpoint: "https://attacker.invalid/collect" } as ProviderRequestInput & { endpoint: string }), context),
    error => error instanceof ProviderRequestError && error.code === "invalid_input");
  await assert.rejects(instance.prepare(input({ model_id: "not-allowlisted" }), context),
    error => error instanceof ProviderRequestError && error.code === "provider_unavailable");
  await assert.rejects(instance.prepare(input({ payload: { prompt: "text", api_key: "guest-secret" } }), context),
    error => error instanceof ProviderRequestError && error.code === "invalid_input");
  await assert.rejects(instance.prepare(input({ source_manifest: { authorization: "Bearer guest-secret" } }), context),
    error => error instanceof ProviderRequestError && error.code === "invalid_input");
});

test("provider responses are size bounded and a credential echo is never returned to the guest", async () => {
  const tooLarge = new ProviderRequestBroker({
    providers: [configuration],
    credentials: { resolve: async () => HOST_CREDENTIAL },
    gestures: new FreshGestureAuthority(),
    fetcher: async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode("x".repeat(1025))); controller.close(); },
    }), { headers: { "content-type": "application/json" } }),
  });
  const largePreview = await prepared(tooLarge, input({ max_output_bytes: 1024 }));
  await assert.rejects(tooLarge.request(largePreview, tooLarge.authorize(trustedClick(), largePreview)),
    error => error instanceof ProviderRequestError && error.code === "capacity");

  const echo = broker({ fetcher: async () => new Response(JSON.stringify({ text: `leaked ${HOST_CREDENTIAL}` }), { headers: { "content-type": "application/json" } }) });
  const echoPreview = await prepared(echo.instance, input({ request_id: "credential-echo" }));
  await assert.rejects(echo.instance.request(echoPreview, echo.instance.authorize(trustedClick(), echoPreview)),
    error => error instanceof ProviderRequestError && error.code === "provider_unavailable");
});

test("a lost response is queried once by request ID and never automatically replayed", async () => {
  let queryCalls = 0;
  let providerReceives = 0;
  let reportReceived: (() => void) | undefined;
  const received = new Promise<void>(resolve => { reportReceived = resolve; });
  await withServer(request => { providerReceives += 1; request.resume(); reportReceived?.(); }, async (_server, port) => {
    const { instance } = broker({
      fetcher: loopbackTransport(port),
      queryStatus: async ({ request_id }) => {
        queryCalls += 1;
        assert.equal(request_id, "uncertain-request");
        return { state: "pending" };
      },
    });
    const preview = await prepared(instance, input({ request_id: "uncertain-request" }));
    const consent = instance.authorize(trustedClick(), preview);
    const controller = new AbortController();
    const pending = instance.request(preview, consent, controller.signal);
    await received;
    controller.abort();
    await assert.rejects(pending, error => error instanceof ProviderRequestError && error.code === "external_state_unknown");
    await assert.rejects(instance.request(preview, {}), error => error instanceof ProviderRequestError && error.code === "external_state_unknown");
    assert.equal(providerReceives, 1);
    assert.equal(queryCalls, 1);
  });
});

test("the Host consent view renders the exact target, cost, source and payload as escaped text", async () => {
  const { instance } = broker({ fetcher: async () => new Response("{}") });
  const preview = await prepared(instance, input({ payload: { text: "<script>alert(1)</script>", instruction: "Show the selected text." } }));
  const markup = renderToStaticMarkup(createElement(ProviderRequestConsentDialog, {
    broker: instance,
    preview,
    onGranted: () => undefined,
    onCancel: () => undefined,
  }));
  assert.match(markup, /https:\/\/provider\.example\.test\/v1\/complete/u);
  assert.match(markup, /about 1 unit/u);
  assert.match(markup, /selected text/u);
  assert.match(markup, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/u);
  assert.doesNotMatch(markup, /<script>alert/u);
  assert.equal(markup.includes(HOST_CREDENTIAL), false);
});
