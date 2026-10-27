import assert from "node:assert/strict";
import test from "node:test";
import { BrowserLocalGit } from "./index.js";

class TestWorker extends EventTarget {
  static current: TestWorker;
  requests: Array<{ id: string; workspace: { localWorkspaceId: string }; operation: string }> = [];
  constructor(..._args: unknown[]) { super(); TestWorker.current = this; }
  postMessage(request: TestWorker["requests"][number]) { this.requests.push(request); }
  terminate() {}
  crash() { this.dispatchEvent(Object.assign(new Event("error"), { message: "Worker stopped" })); }
}

for (const operation of ["read", "write"] as const) for (const cause of ["close", "error"] as const) {
  test(`${cause} during ${operation} retains uncertainty only for unconfirmed mutations`, async () => {
    const descriptors = new Map(["Worker", "localStorage"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    const values = new Map<string, string>();
    Object.defineProperty(globalThis, "Worker", { configurable: true, value: TestWorker });
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
      getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key),
    } });
    const identity = { provider: "local" as const, name: "Lifecycle fixture", branch: "main", localWorkspaceId: `lifecycle-${crypto.randomUUID()}` };
    const git = new BrowserLocalGit(identity);
    try {
      const request = operation === "read" ? git.status() : git.write("book.md", new Uint8Array([65]), { oid: null });
      const rejected = assert.rejects(request, { code: operation === "write" ? "storage_unknown" : "git_error" });
      if (cause === "close") git.close(); else TestWorker.current.crash();
      await rejected;
      const marker = values.get(`proprium.git.storage-unknown.${identity.localWorkspaceId}`);
      assert.equal(marker, operation === "write" ? "1" : undefined);
      const reopened = new BrowserLocalGit(identity);
      if (operation === "write") await assert.rejects(reopened.status(), { code: "storage_unknown" });
      else {
        const read = reopened.status();
        const posted = TestWorker.current.requests.at(-1)!;
        TestWorker.current.dispatchEvent(new MessageEvent("message", { data: { id: posted.id, workspaceId: identity.localWorkspaceId, result: { head: null, entries: [] } } }));
        assert.deepEqual(await read, { head: null, entries: [] });
      }
      reopened.close();
    } finally {
      git.close();
      for (const [key, descriptor] of descriptors) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
      }
    }
  });
}
