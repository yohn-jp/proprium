import { useEffect, useRef, useState, type ReactElement } from "react";
import { BrowserLocalGit } from "../git/index.js";
import type { FileRevisionExpectation, WorkspaceChange, WorkspaceIdentity } from "../git/protocol.js";
import { validateGitPath } from "../git/protocol.js";

export const LIVE_MCP_TOOLS = ["repositories_list", "repository_info", "files_list", "file_read", "git_log", "git_status", "plugin_call", "proposal_submit"] as const;
export type LiveMcpTool = typeof LIVE_MCP_TOOLS[number];
export interface LiveWorkspaceProposal {
  id: string;
  title: string;
  target: WorkspaceIdentity;
  changes: Array<{ path: string; content: string; expectedRevision: string | null }>;
}
export type LiveToolExecutor = (tool: LiveMcpTool, args: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>;

interface LiveRequest { requestId: string; workspaceId: string; generation: string; tool: LiveMcpTool; arguments: Record<string, unknown>; deadline: number; }
interface Props {
  gatewayUrl: string;
    workspaceId: string;
  generation: string;
  identity: WorkspaceIdentity;
  repositories: Array<{ identity: WorkspaceIdentity; title: string }>;
  git: BrowserLocalGit;
  canApply: boolean;
  onWorkspaceChanged(): Promise<void>;
  onExecutePlugin(args: Record<string, unknown>, signal: AbortSignal): Promise<unknown>;
}
type State = "disabled" | "connecting" | "connected" | "disconnected" | "error";

function normalizedGateway(value: string): string {
  const url = new URL(value);
  const loopback = url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname);
  if ((!loopback && url.protocol !== "https:") || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Gateway must be an HTTPS origin (or loopback HTTP during local development).");
  }
  return url.origin;
}
function isObject(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }

async function jsonResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    let message = `Gateway request failed (${response.status}).`;
    try { const payload = await response.json() as { error?: string }; if (payload.error) message = payload.error; } catch { /* use generic status */ }
    throw new Error(message);
  }
  return response.status === 204 ? undefined as T : await response.json() as T;
}

async function readSse(reader: ReadableStreamDefaultReader<Uint8Array>, onEvent: (event: string, data: string) => void, signal: AbortSignal): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = "";
  while (!signal.aborted) {
    const part = await reader.read();
    if (part.done) return;
    buffer += decoder.decode(part.value, { stream: true });
    while (true) {
      const split = buffer.search(/\r?\n\r?\n/u);
      if (split < 0) break;
      const block = buffer.slice(0, split);
      const marker = /^\r?\n\r?\n/u.exec(buffer.slice(split))?.[0].length ?? 2;
      buffer = buffer.slice(split + marker);
      let event = "message";
      const data: string[] = [];
      for (const line of block.split(/\r?\n/u)) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
      }
      if (data.length) onEvent(event, data.join("\n"));
    }
  }
}

export function LiveMcpPanel({ gatewayUrl, workspaceId, identity, repositories, git, canApply, onWorkspaceChanged, onExecutePlugin }: Props): ReactElement {
  const [state, setState] = useState<State>("disabled");
  const [error, setError] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [activeRequests, setActiveRequests] = useState<Array<{ id: string; tool: LiveMcpTool }>>([]);
  const abortRef = useRef<AbortController | null>(null);
  const pendingRef = useRef(new Map<string, AbortController>());
  const liveSessionRef = useRef("");
  const connectAttemptRef = useRef("");
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    void connect();
    return () => {
      mountedRef.current = false;
      connectAttemptRef.current = "";
      const id = liveSessionRef.current;
      liveSessionRef.current = "";
      abortRef.current?.abort();
      for (const pending of pendingRef.current.values()) pending.abort();
      pendingRef.current.clear();
      if (id) void gatewayRequest(`/live/sessions/${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => undefined);
    };
    // HostApp remounts this component when the active workspace or Gateway changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const gatewayRequest = async <T,>(path: string, init: RequestInit = {}): Promise<T> => {
    const origin = normalizedGateway(gatewayUrl.trim());
    return jsonResponse<T>(await fetch(`${origin}${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", ...init.headers },
      credentials: "include", cache: "no-store", redirect: "error", referrerPolicy: "no-referrer",
    }));
  };

  useEffect(() => {
    const activate = (): void => {
      const id = liveSessionRef.current;
      if (id && !document.hidden && document.hasFocus()) {
        void gatewayRequest(`/live/sessions/${encodeURIComponent(id)}/activate`, { method: "POST" }).catch(() => undefined);
      }
    };
    window.addEventListener("focus", activate);
    document.addEventListener("visibilitychange", activate);
    return () => {
      window.removeEventListener("focus", activate);
      document.removeEventListener("visibilitychange", activate);
    };
    // The HostApp key changes when the Gateway or workspace changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function knownRepositories(): Array<{ identity: WorkspaceIdentity; title: string }> {
    const entries = [{ identity, title: `${identity.owner}/${identity.repository} · ${identity.branch}` }, ...repositories];
    const seen = new Set<string>();
    return entries.filter(entry => {
      const key = `${entry.identity.repositoryId}:${entry.identity.branch}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function resolveRepository(args: Record<string, unknown>): WorkspaceIdentity {
    const id = args.repository_id;
    if (!Number.isSafeInteger(id) || (id as number) <= 0) throw new Error("repository_id must be a positive GitHub repository ID.");
    if (args.branch !== undefined && (typeof args.branch !== "string" || !args.branch.trim())) throw new Error("branch must be a non-empty string.");
    const matches = knownRepositories().filter(entry => entry.identity.repositoryId === id &&
      (args.branch === undefined || entry.identity.branch === args.branch));
    if (!matches.length) throw new Error("repository_unavailable: this browser has not opened the requested repository and branch.");
    if (matches.length !== 1) throw new Error("repository_ambiguous: specify branch to select the local worktree.");
    return matches[0].identity;
  }

  async function execute(request: LiveRequest, expectedSession: string, expectedGeneration: string): Promise<void> {
    if (request.workspaceId !== workspaceId || request.generation !== expectedGeneration || !LIVE_MCP_TOOLS.includes(request.tool) || !isObject(request.arguments)) return;
    if (pendingRef.current.has(request.requestId) || !Number.isFinite(request.deadline)) return;
    const controller = new AbortController();
    pendingRef.current.set(request.requestId, controller);
    setActiveRequests(value => [...value.filter(item => item.id !== request.requestId), { id: request.requestId, tool: request.tool }]);
    const remaining = Math.max(1, Math.min(60_000, request.deadline - Date.now()));
    const timer = setTimeout(() => controller.abort(new DOMException("The repository request expired.", "TimeoutError")), remaining);
    let temporaryGit: BrowserLocalGit | null = null;
    try {
      let result: unknown;
      if (request.tool === "repositories_list") {
        result = knownRepositories().map(entry => ({
          repository_id: entry.identity.repositoryId,
          owner: entry.identity.owner,
          repository: entry.identity.repository,
          branch: entry.identity.branch,
          active: entry.identity.localWorkspaceId === identity.localWorkspaceId,
        }));
      } else {
        const target = resolveRepository(request.arguments);
        const active = target.localWorkspaceId === identity.localWorkspaceId;
        const targetGit = active ? git : new BrowserLocalGit(target);
        if (!active) {
          temporaryGit = targetGit;
          await targetGit.init();
        }
        if (request.tool === "repository_info") {
          const status = await targetGit.status();
          result = { repository_id: target.repositoryId, owner: target.owner, repository: target.repository, branch: target.branch, head: status.head, active };
        } else if (request.tool === "files_list") {
          result = await targetGit.listFiles();
        } else if (request.tool === "file_read") {
          if (typeof request.arguments.path !== "string") throw new Error("path is required.");
          validateGitPath(request.arguments.path);
          const file = await targetGit.read(request.arguments.path);
          let content: string | null = null;
          if (file.data) { try { content = new TextDecoder("utf-8", { fatal: true }).decode(file.data); } catch { content = null; } }
          result = { path: request.arguments.path, content, binary: file.data !== null && content === null, revision: file.revision.oid };
        } else if (request.tool === "git_status") {
          result = await targetGit.status();
        } else if (request.tool === "git_log") {
          const limit = request.arguments.limit === undefined ? 40 : request.arguments.limit;
          if (!Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > 100) throw new Error("limit must be an integer from 1 to 100.");
          result = await targetGit.log(limit as number);
        } else if (request.tool === "plugin_call") {
          if (!active) throw new Error("repository_not_active: open this repository in the Browser Host to invoke its plugins.");
          result = await onExecutePlugin(request.arguments, controller.signal);
        } else {
          result = await submitProposal(request.arguments, targetGit, target);
        }
      }
      if (request.tool === "proposal_submit") {
        if (controller.signal.aborted || liveSessionRef.current !== expectedSession) throw new DOMException("The active Browser Host disconnected before proposal review.", "AbortError");
        const proposal = result as LiveWorkspaceProposal;
        setProposals(current => [...current, proposal]);
        result = { proposalId: proposal.id, status: "awaiting_host_review", repository_id: proposal.target.repositoryId, branch: proposal.target.branch, files: proposal.changes.map(change => change.path) };
      }
      if (controller.signal.aborted) throw controller.signal.reason ?? new DOMException("Request cancelled.", "AbortError");
      if (new TextEncoder().encode(JSON.stringify(result)).byteLength > 768 * 1024) throw new Error("The MCP result is too large.");
      await postResponse(request, expectedGeneration, { status: "completed", result });
    } catch (caught) {
      const cancelled = controller.signal.aborted;
      const message = caught instanceof Error ? caught.message.slice(0, 2048) : "The Browser Host could not complete this request.";
      if (liveSessionRef.current === expectedSession) {
        await postResponse(request, expectedGeneration, cancelled ? { status: "cancelled", error: message } : { status: "failed", error: message }).catch(() => undefined);
      }
    } finally {
      temporaryGit?.close();
      clearTimeout(timer);
      pendingRef.current.delete(request.requestId);
      if (mountedRef.current) setActiveRequests(value => value.filter(item => item.id !== request.requestId));
    }
  }

  async function submitProposal(args: Record<string, unknown>, targetGit: BrowserLocalGit, target: WorkspaceIdentity): Promise<unknown> {
    if (typeof args.title !== "string" || !args.title.trim() || args.title.length > 200 || !Array.isArray(args.changes) || !args.changes.length || args.changes.length > 32) {
      throw new Error("A proposal requires a short title and 1 to 32 file changes.");
    }
    let total = 0;
    const changes: LiveWorkspaceProposal["changes"] = [];
    const seen = new Set<string>();
    for (const raw of args.changes) {
      if (!isObject(raw) || typeof raw.path !== "string" || typeof raw.content !== "string" || !(typeof raw.expectedRevision === "string" || raw.expectedRevision === null)) {
        throw new Error("Each proposed change must include path, text content, and an expected revision.");
      }
      validateGitPath(raw.path);
      if (seen.has(raw.path)) throw new Error("A proposal cannot change the same path more than once.");
      seen.add(raw.path);
      total += new TextEncoder().encode(raw.content).byteLength;
      if (total > 512 * 1024) throw new Error("Proposal content exceeds the 512 KiB Live MCP limit.");
      const current = await targetGit.read(raw.path);
      if (current.revision.oid !== raw.expectedRevision) throw new Error(`The revision for ${raw.path} has changed; refresh the workspace before proposing it.`);
      changes.push({ path: raw.path, content: raw.content, expectedRevision: raw.expectedRevision });
    }
    return { id: crypto.randomUUID(), title: args.title.trim(), target, changes } satisfies LiveWorkspaceProposal;
  }

  async function postResponse(request: LiveRequest, requestGeneration: string, payload: Record<string, unknown>): Promise<void> {
    const origin = normalizedGateway(gatewayUrl.trim());
    await jsonResponse(await fetch(`${origin}/live/sessions/${encodeURIComponent(liveSessionRef.current)}/responses`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestId: request.requestId, workspaceId, generation: requestGeneration, ...payload }),
      credentials: "include", cache: "no-store", redirect: "error", referrerPolicy: "no-referrer",
    }));
  }

  async function connect(): Promise<void> {
    if (connectAttemptRef.current) return;
    setError("");
    setState("connecting");
    const attempt = crypto.randomUUID();
    connectAttemptRef.current = attempt;
    let created: { sessionId: string } | null = null;
    let eventController: AbortController | null = null;
    const liveGeneration = crypto.randomUUID();
    try {
      created = await gatewayRequest<{ sessionId: string }>("/live/sessions", {
        method: "POST", body: JSON.stringify({ workspaceId, generation: liveGeneration }),
      });
      if (connectAttemptRef.current !== attempt) {
        await gatewayRequest(`/live/sessions/${encodeURIComponent(created.sessionId)}`, { method: "DELETE" }).catch(() => undefined);
        return;
      }
      const activeSession = created;
      liveSessionRef.current = activeSession.sessionId;
      setEndpoint(`${normalizedGateway(gatewayUrl.trim())}/mcp`);
      const controller = new AbortController();
      eventController = controller;
      abortRef.current = controller;
      const origin = normalizedGateway(gatewayUrl.trim());
      const events = await fetch(`${origin}/live/sessions/${encodeURIComponent(activeSession.sessionId)}/events`, {
        headers: { Accept: "text/event-stream" },
        credentials: "include", cache: "no-store", redirect: "error", referrerPolicy: "no-referrer", signal: controller.signal,
      });
      if (!events.ok || !events.body) throw new Error(`Gateway event stream failed (${events.status}).`);
      setState("connected");
      if (!document.hidden && document.hasFocus()) {
        void gatewayRequest(`/live/sessions/${encodeURIComponent(activeSession.sessionId)}/activate`, { method: "POST" }).catch(() => undefined);
      }
      await readSse(events.body.getReader(), (name, data) => {
        let payload: unknown;
        try { payload = JSON.parse(data); } catch { return; }
        if (!isObject(payload) || payload.workspaceId !== workspaceId || payload.generation !== liveGeneration || liveSessionRef.current !== activeSession.sessionId) return;
        if (name === "request") {
          const request = payload as unknown as LiveRequest;
          if (typeof request.requestId === "string" && LIVE_MCP_TOOLS.includes(request.tool)) void execute(request, activeSession.sessionId, liveGeneration);
        } else if (name === "cancel" && typeof payload.requestId === "string") {
          pendingRef.current.get(payload.requestId)?.abort(new DOMException("The MCP client cancelled this request.", "AbortError"));
        }
      }, controller.signal);
      if (!controller.signal.aborted && liveSessionRef.current === activeSession.sessionId && mountedRef.current) {
        setState("disconnected");
        setError("Browser Host disconnected. Reconnect to resume MCP.");
      }
    } catch (caught) {
      if (connectAttemptRef.current === attempt && mountedRef.current && !eventController?.signal.aborted) {
        setState("error");
        setError(caught instanceof Error ? caught.message : "Could not reach the Gateway.");
      }
    } finally {
      if (created && connectAttemptRef.current === attempt) {
        liveSessionRef.current = "";
        abortRef.current = null;
        connectAttemptRef.current = "";
        for (const pending of pendingRef.current.values()) pending.abort(new DOMException("The Browser Host disconnected.", "AbortError"));
        pendingRef.current.clear();
        void gatewayRequest(`/live/sessions/${encodeURIComponent(created.sessionId)}`, { method: "DELETE" }).catch(() => undefined);
      }
    }
  }

  async function approveProposal(proposal: LiveWorkspaceProposal): Promise<void> {
    const active = proposal.target.localWorkspaceId === identity.localWorkspaceId;
    if (active && !canApply) { setError("Save the editor draft before reviewing the proposed changes."); return; }
    const targetGit = active ? git : new BrowserLocalGit(proposal.target);
    try {
      if (!active) await targetGit.init();
      const changes: WorkspaceChange[] = [];
      const readSet: FileRevisionExpectation[] = [];
      for (const change of proposal.changes) {
        const actual = await targetGit.read(change.path);
        if (actual.revision.oid !== change.expectedRevision) throw new Error(`The file ${change.path} changed since the proposal; it remains unapplied.`);
        const expectedRevision = { oid: change.expectedRevision };
        readSet.push({ path: change.path, revision: expectedRevision });
        changes.push({ path: change.path, content: new TextEncoder().encode(change.content), expectedRevision });
      }
      await targetGit.applyChanges(changes, readSet);
      setProposals(current => current.filter(item => item.id !== proposal.id));
      if (active) await onWorkspaceChanged();
      setError(`Approved “${proposal.title}” for ${proposal.target.owner}/${proposal.target.repository} (${proposal.target.branch}). Changes remain local until explicitly committed and published.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Proposal review failed.");
    } finally {
      if (!active) targetGit.close();
    }
  }

  const [proposals, setProposals] = useState<LiveWorkspaceProposal[]>([]);

  return <section className="live-mcp-panel" aria-label="MCP connection">
    <div className="live-mcp-content">
      <strong>MCP</strong>
      <p role="status">{state === "connected" ? "ブラウザーに接続中" : state === "connecting" ? "接続中…" : "未接続"}</p>
      {endpoint && <div className="live-mcp-endpoint"><span>Gateway MCP接続先</span><code>{endpoint}</code><button type="button" onClick={() => { void navigator.clipboard.writeText(endpoint).catch(() => setError("MCP接続先をコピーできませんでした。")); }}>URLをコピー</button></div>}
      {state === "connected" && <p className="live-mcp-current-target"><span>接続中のリポジトリ</span><strong>{identity.owner}/{identity.repository}</strong><span>ブランチ: {identity.branch}</span></p>}
      {(state === "disconnected" || state === "error") && <button type="button" onClick={() => void connect()}>再接続</button>}
      {error && <p role="alert">{error}</p>}
      {activeRequests.length > 0 && <p role="status">MCP requests: {activeRequests.length}</p>}
      {proposals.map(proposal => <article key={proposal.id}><h3>{proposal.title}</h3><p>{proposal.target.owner}/{proposal.target.repository} · {proposal.target.branch}</p><ul>{proposal.changes.map(change => <li key={change.path}>{change.path}<details><summary>提案内容を全文確認</summary><pre>{change.content}</pre></details></li>)}</ul><button type="button" disabled={proposal.target.localWorkspaceId === identity.localWorkspaceId && !canApply} onClick={() => void approveProposal(proposal)}>Review and approve</button><button type="button" onClick={() => setProposals(value => value.filter(item => item.id !== proposal.id))}>Reject</button></article>)}
    </div>
  </section>;
}
