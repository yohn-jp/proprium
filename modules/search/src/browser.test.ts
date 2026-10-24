import assert from "node:assert/strict";
import test from "node:test";
import { browserModule } from "./browser.js";

type Listener = (event: Event) => void;

class TestElement {
  readonly tagName: string;
  readonly children: TestElement[] = [];
  readonly attributes = new Map<string, string>();
  readonly listeners = new Map<string, Listener[]>();
  readonly style: Record<string, string> = {};
  readonly dataset: Record<string, string> = {};
  textContent = "";
  value = "";
  type = "";
  checked = false;
  disabled = false;
  maxLength = 0;
  placeholder = "";

  constructor(tagName: string) { this.tagName = tagName; }

  append(...nodes: TestElement[]): void { this.children.push(...nodes); }
  replaceChildren(...nodes: TestElement[]): void { this.children.splice(0, this.children.length, ...nodes); }
  setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
  addEventListener(name: string, listener: EventListenerOrEventListenerObject | null): void {
    if (!listener) return;
    const callbacks = this.listeners.get(name) ?? [];
    callbacks.push(typeof listener === "function" ? listener as Listener : (event) => listener.handleEvent(event));
    this.listeners.set(name, callbacks);
  }
  removeEventListener(name: string, listener: EventListenerOrEventListenerObject | null): void {
    const callbacks = this.listeners.get(name) ?? [];
    this.listeners.set(name, callbacks.filter((callback) => callback !== listener));
  }
  dispatch(name: string, fields: Record<string, unknown> = {}): void {
    const event = { type: name, ...fields } as Event;
    for (const callback of this.listeners.get(name) ?? []) callback(event);
  }
  click(): void { if (!this.disabled) this.dispatch("click"); }
}

class TestDocument {
  createElement(tagName: string): TestElement { return new TestElement(tagName); }
}

function walk(root: TestElement): TestElement[] {
  return [root, ...root.children.flatMap(walk)];
}

function findField(root: TestElement, label: string): TestElement {
  const field = walk(root).find((node) => node.tagName === "label" && node.children[0]?.textContent === label);
  assert.ok(field, `expected field ${label}`);
  return field.children[1]!;
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise; });
  return { promise, resolve, reject };
}

function actionResult(
  data: Record<string, unknown>,
  snapshot: Record<string, unknown> = { remoteCommit: "requested-snapshot-123456" },
): unknown {
  return { ok: true, snapshot, data };
}

async function mountSearchPanel(options: {
  invoke(actionId: string, input: unknown): Promise<unknown>;
  signal?: AbortSignal;
  navigateDocument?(path: string): Promise<void>;
  propose?(): Promise<unknown>;
}): Promise<{ root: TestElement; run: TestElement; query: TestElement; scope: TestElement; mode: TestElement; status: TestElement; results: TestElement; dispose(): void }> {
  const root = new TestElement("div");
  const context = {
    projectId: "fixture-project", snapshot: {} as never, signal: options.signal ?? new AbortController().signal,
    invoke: options.invoke as never, propose: (options.propose ?? (async () => ({}))) as never, refresh: async () => undefined,
    navigateDocument: options.navigateDocument,
  };
  const dispose = await browserModule.mount("search.panel", root as never, context as never);
  const mode = findField(root, "検索対象");
  mode.value = "fulltext";
  return {
    root,
    run: walk(root).find((node) => node.tagName === "button" && node.textContent === "検索")!,
    query: findField(root, "検索語"),
    scope: findField(root, "範囲パス"),
    mode,
    status: walk(root).find((node) => node.tagName === "output")!,
    results: walk(root).find((node) => node.tagName === "ol")!,
    dispose,
  };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

test("changing the query while a response is pending cannot display results for the old query", async () => {
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", { configurable: true, value: new TestDocument() });
  try {
    const response = deferred<unknown>();
    const panel = await mountSearchPanel({ invoke: () => response.promise });

    panel.query.value = "query A";
    panel.run.click();
    panel.query.value = "query B";
    panel.query.dispatch("input");
    response.resolve(actionResult({ results: [{ title: "Result from A", path: "manuscript/a.md", kind: "document" }], indexedDocuments: 1 }));
    await settle();

    assert.equal(panel.results.children.length, 0, "editing the search form should invalidate the pending result");
    assert.match(panel.status.textContent, /検索条件が変更/u);
    panel.dispose();
  } finally {
    if (previousDocument) Object.defineProperty(globalThis, "document", previousDocument);
    else Reflect.deleteProperty(globalThis, "document");
  }
});

test("repeated submissions keep the latest empty response and its submitted snapshot", async () => {
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", { configurable: true, value: new TestDocument() });
  try {
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    const inputs: Array<{ actionId: string; input: Record<string, unknown> }> = [];
    let proposals = 0;
    const panel = await mountSearchPanel({
      invoke: (actionId, input) => {
        inputs.push({ actionId, input: input as Record<string, unknown> });
        return inputs.length === 1 ? first.promise : second.promise;
      },
      propose: async () => { proposals += 1; return {}; },
    });

    panel.query.value = "query A";
    panel.run.click();
    panel.query.value = "query B";
    panel.query.dispatch("input");
    panel.scope.value = "manuscript/vol-1";
    panel.scope.dispatch("input");
    panel.mode.value = "exact";
    panel.mode.dispatch("change");
    panel.run.click();
    assert.equal(inputs.length, 2, "a new submission should run while the older response is pending");
    assert.deepEqual(inputs.map(({ actionId }) => actionId), ["search.query", "search.query"]);
    assert.equal(inputs[1]?.input.query, "query B");
    assert.equal(inputs[1]?.input.scope, "manuscript/vol-1");
    assert.equal(inputs[1]?.input.mode, "exact");
    assert.equal(inputs[1]?.input.useNlp, false);
    assert.equal(inputs[1]?.input.includeSemantic, false);

    second.resolve(actionResult({ results: [], indexedDocuments: 0, semanticResults: [], warnings: [], indexSnapshot: { remoteCommit: "index-snapshot-987654" } }));
    await settle();
    assert.equal(panel.results.children.length, 0);
    assert.match(panel.status.textContent, /0 件/u);
    assert.match(panel.status.textContent, /query B/u);
    assert.match(panel.status.textContent, /完全一致/u);
    assert.match(panel.status.textContent, /manuscript\/vol-1/u);
    assert.match(panel.status.textContent, /requested-sn/u);
    assert.match(panel.status.textContent, /index-snapsh/u);

    first.resolve(actionResult({ results: [{ title: "Stale result from A", path: "manuscript/a.md", kind: "document" }], indexedDocuments: 1 }));
    await settle();
    assert.equal(panel.results.children.length, 0, "an older response must not replace the latest empty response");
    assert.match(panel.status.textContent, /query B/u);
    assert.match(panel.status.textContent, /0 件/u);
    assert.equal(proposals, 0, "search must not create manuscript proposals");
    panel.dispose();
  } finally {
    if (previousDocument) Object.defineProperty(globalThis, "document", previousDocument);
    else Reflect.deleteProperty(globalThis, "document");
  }
});

test("aborting a contribution disables search and prevents further action calls", async () => {
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", { configurable: true, value: new TestDocument() });
  try {
    const controller = new AbortController();
    let calls = 0;
    const panel = await mountSearchPanel({ signal: controller.signal, invoke: async () => { calls += 1; return actionResult({ results: [] }); } });

    controller.abort();
    assert.equal(panel.run.disabled, true);
    panel.run.click();
    assert.equal(calls, 0);
    panel.dispose();
    assert.equal(panel.root.children.length, 0);
  } finally {
    if (previousDocument) Object.defineProperty(globalThis, "document", previousDocument);
    else Reflect.deleteProperty(globalThis, "document");
  }
});

test("current search result navigation keeps using the host document callback", async () => {
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", { configurable: true, value: new TestDocument() });
  try {
    const opened: string[] = [];
    const panel = await mountSearchPanel({
      invoke: async () => actionResult({ results: [{ title: "Scene", path: "manuscript/scene.md", kind: "document" }], indexedDocuments: 1 }),
      navigateDocument: async (path) => { opened.push(path); },
    });
    panel.query.value = "scene";
    panel.run.click();
    await settle();
    const open = walk(panel.root).find((node) => node.tagName === "button" && node.textContent === "この文書を開く: manuscript/scene.md");
    assert.ok(open);
    open.click();
    await settle();
    assert.deepEqual(opened, ["manuscript/scene.md"]);
    panel.dispose();
  } finally {
    if (previousDocument) Object.defineProperty(globalThis, "document", previousDocument);
    else Reflect.deleteProperty(globalThis, "document");
  }
});
