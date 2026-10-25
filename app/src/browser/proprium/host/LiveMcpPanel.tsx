import { useEffect, useRef, useState, type ReactElement } from "react";
import type { BrowserLocalGit } from "../git/index.js";
import type { FileRevisionExpectation, WorkspaceChange, WorkspaceIdentity } from "../git/protocol.js";
import { validateGitPath } from "../git/protocol.js";

export const LIVE_MCP_TOOLS = ["capabilities_list", "files_list", "file_read", "git_log", "git_status", "plugin_call", "proposal_submit", "workspace_info"] as const;
export type LiveMcpTool = typeof LIVE_MCP_TOOLS[number];
export interface LiveWorkspaceProposal {
  id: string;
  title: string;
  changes: Array<{ path: string; content: string; expectedRevision: string | null }>;
}
export type LiveToolExecutor = (tool: LiveMcpTool, args: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>;

interface Client { clientId: string; name: string; capabilities: LiveMcpTool[]; }
interface RecentRequest { id: string; tool: LiveMcpTool; status: "completed" | "failed" | "cancelled"; }
interface LiveRequest { requestId: string; workspaceId: string; generation: string; tool: LiveMcpTool; arguments: Record<string, unknown>; deadline: number; clientCapabilities?: LiveMcpTool[]; }
interface Props {
  gatewayUrl: string;
  onGatewayUrlChange(value: string): void;
  workspaceId: string;
  generation: string;
  identity: WorkspaceIdentity;
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

export function LiveMcpPanel({ gatewayUrl, onGatewayUrlChange, workspaceId, generation, identity, git, canApply, onWorkspaceChanged, onExecutePlugin }: Props): ReactElement {
  const [enabled, setEnabled] = useState(false);
  const [ownerKey, setOwnerKey] = useState("");
  const [selected, setSelected] = useState<LiveMcpTool[]>([...LIVE_MCP_TOOLS]);
  const [state, setState] = useState<State>("disabled");
  const [error, setError] = useState("");
  const [sessionId, setSessionId] = useState("");
  const [clients, setClients] = useState<Client[]>([]);
  const [clientName, setClientName] = useState("");
  const [clientCaps, setClientCaps] = useState<LiveMcpTool[]>([]);
  const [newToken, setNewToken] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [activeRequests, setActiveRequests] = useState<Array<{ id: string; tool: LiveMcpTool }>>([]);
  const [recentRequests, setRecentRequests] = useState<RecentRequest[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const pendingRef = useRef(new Map<string, AbortController>());
  const liveSessionRef = useRef("");
  const sessionOwnerTokenRef = useRef("");
  const workspaceBindingRef = useRef(`${workspaceId}:${generation}`);
  const mountedRef = useRef(true);
  const ownerKeyRef = useRef("");
  ownerKeyRef.current = ownerKey;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
    mountedRef.current = false;
    abortRef.current?.abort();
    for (const controller of pendingRef.current.values()) controller.abort();
    pendingRef.current.clear();
    liveSessionRef.current = "";
    sessionOwnerTokenRef.current = "";
    ownerKeyRef.current = "";
    };
  }, []);

  useEffect(() => {
    const binding = `${workspaceId}:${generation}`;
    if (workspaceBindingRef.current === binding) return;
    workspaceBindingRef.current = binding;
    setProposals([]);
    void stop();
  }, [workspaceId, generation]);

  const ownerRequest = async <T,>(path: string, init: RequestInit = {}, bearer = ownerKeyRef.current): Promise<T> => {
    const origin = normalizedGateway(gatewayUrl.trim());
    return jsonResponse<T>(await fetch(`${origin}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json", ...init.headers },
      credentials: "omit", cache: "no-store", redirect: "error", referrerPolicy: "no-referrer",
    }));
  };

  async function refreshClients(id = liveSessionRef.current): Promise<void> {
    if (!id) return;
    const payload = await ownerRequest<{ clients: Client[] }>(`/live/sessions/${encodeURIComponent(id)}/clients`, {}, sessionOwnerTokenRef.current);
    if (mountedRef.current && liveSessionRef.current === id) setClients(payload.clients);
  }

  async function execute(request: LiveRequest, bearer: string, expectedSession: string, expectedGeneration: string): Promise<void> {
    if (request.workspaceId !== workspaceId || request.generation !== expectedGeneration || !LIVE_MCP_TOOLS.includes(request.tool) || !selected.includes(request.tool) || !isObject(request.arguments)) return;
    const controller = new AbortController();
    pendingRef.current.set(request.requestId, controller);
    setActiveRequests(value => [...value.filter(item => item.id !== request.requestId), { id: request.requestId, tool: request.tool }]);
    const remaining = Math.max(1, Math.min(60_000, request.deadline - Date.now()));
    const timer = setTimeout(() => controller.abort(new DOMException("The workspace request expired.", "TimeoutError")), remaining);
    try {
      let result: unknown;
      if (request.tool === "capabilities_list") {
        result = request.clientCapabilities ?? [];
      } else if (request.tool === "workspace_info") {
        const status = await git.status();
        result = { workspaceId, repositoryId: identity.repositoryId, owner: identity.owner, repository: identity.repository, branch: identity.branch, head: status.head };
      } else if (request.tool === "files_list") {
        result = await git.listFiles();
      } else if (request.tool === "file_read") {
        if (typeof request.arguments.path !== "string") throw new Error("path is required.");
        validateGitPath(request.arguments.path);
        const file = await git.read(request.arguments.path);
        let content: string | null = null;
        if (file.data) { try { content = new TextDecoder("utf-8", { fatal: true }).decode(file.data); } catch { content = null; } }
        result = { path: request.arguments.path, content, binary: file.data !== null && content === null, revision: file.revision.oid };
      } else if (request.tool === "git_status") {
        result = await git.status();
      } else if (request.tool === "git_log") {
        const limit = request.arguments.limit === undefined ? 40 : request.arguments.limit;
        if (!Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > 100) throw new Error("limit must be an integer from 1 to 100.");
        result = await git.log(limit as number);
      } else if (request.tool === "plugin_call") {
        result = await onExecutePlugin(request.arguments, controller.signal);
      } else {
        result = await submitProposal(request.arguments);
      }
      if (request.tool === "proposal_submit") {
        if (controller.signal.aborted || liveSessionRef.current !== expectedSession) throw new DOMException("The workspace disconnected before the proposal could be queued.", "AbortError");
        const proposal = result as LiveWorkspaceProposal;
        setProposals(current => [...current, proposal]);
        result = { proposalId: proposal.id, status: "awaiting_host_review", files: proposal.changes.map(change => change.path) };
      }
      if (controller.signal.aborted) throw controller.signal.reason ?? new DOMException("Request cancelled.", "AbortError");
      if (new TextEncoder().encode(JSON.stringify(result)).byteLength > 768 * 1024) throw new Error("The result exceeds the Live MCP response limit. Narrow the request and try again.");
      await postResponse(bearer, request, expectedGeneration, { status: "completed", result });
      const status: RecentRequest["status"] = "completed";
      setRecentRequests(value => [{ id: request.requestId, tool: request.tool, status }, ...value].slice(0, 5));
    } catch (caught) {
      const cancelled = controller.signal.aborted;
      const message = caught instanceof Error ? caught.message.slice(0, 2048) : "The Browser Host could not complete this request.";
      await postResponse(bearer, request, expectedGeneration, cancelled ? { status: "cancelled", error: message } : { status: "failed", error: message }).catch(() => undefined);
      const status: RecentRequest["status"] = cancelled ? "cancelled" : "failed";
      setRecentRequests(value => [{ id: request.requestId, tool: request.tool, status }, ...value].slice(0, 5));
    } finally {
      clearTimeout(timer);
      pendingRef.current.delete(request.requestId);
      if (mountedRef.current) setActiveRequests(value => value.filter(item => item.id !== request.requestId));
    }
  }

  async function submitProposal(args: Record<string, unknown>): Promise<unknown> {
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
      const current = await git.read(raw.path);
      if (current.revision.oid !== raw.expectedRevision) throw new Error(`The revision for ${raw.path} has changed; refresh the workspace before proposing it.`);
      changes.push({ path: raw.path, content: raw.content, expectedRevision: raw.expectedRevision });
    }
    return { id: crypto.randomUUID(), title: args.title.trim(), changes } satisfies LiveWorkspaceProposal;
  }

  async function postResponse(bearer: string, request: LiveRequest, requestGeneration: string, payload: Record<string, unknown>): Promise<void> {
    const origin = normalizedGateway(gatewayUrl.trim());
    await jsonResponse(await fetch(`${origin}/live/sessions/${encodeURIComponent(liveSessionRef.current)}/responses`, {
      method: "POST", headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
      body: JSON.stringify({ requestId: request.requestId, workspaceId, generation: requestGeneration, ...payload }),
      credentials: "omit", cache: "no-store", redirect: "error", referrerPolicy: "no-referrer",
    }));
  }

  async function connect(): Promise<void> {
    setError(""); setNewToken(""); setState("connecting"); setEnabled(true);
    const key = ownerKey.trim();
    if (key.length < 32) { setState("error"); setError("Enter the Gateway owner key (at least 32 characters). It stays in this tab's memory."); return; }
    let created: { sessionId: string; ownerToken: string } | null = null;
    let eventController: AbortController | null = null;
    const liveGeneration = crypto.randomUUID();
    try {
      created = await ownerRequest<{ sessionId: string; ownerToken: string }>("/live/sessions", {
        method: "POST", body: JSON.stringify({ workspaceId, generation: liveGeneration, capabilities: selected }),
      });
      setOwnerKey("");
      const activeSession = created;
      sessionOwnerTokenRef.current = activeSession.ownerToken;
      liveSessionRef.current = activeSession.sessionId;
      setSessionId(activeSession.sessionId);
      setEndpoint(`${normalizedGateway(gatewayUrl.trim())}/mcp`);
      await refreshClients(activeSession.sessionId);
      const controller = new AbortController(); eventController = controller; abortRef.current = controller;
      const origin = normalizedGateway(gatewayUrl.trim());
      const events = await fetch(`${origin}/live/sessions/${encodeURIComponent(activeSession.sessionId)}/events`, {
        headers: { Authorization: `Bearer ${activeSession.ownerToken}`, Accept: "text/event-stream" },
        credentials: "omit", cache: "no-store", redirect: "error", referrerPolicy: "no-referrer", signal: controller.signal,
      });
      if (!events.ok || !events.body) throw new Error(`Gateway event stream failed (${events.status}).`);
      setState("connected");
      await readSse(events.body.getReader(), (name, data) => {
        let payload: unknown;
        try { payload = JSON.parse(data); } catch { return; }
        if (!isObject(payload) || payload.workspaceId !== workspaceId || payload.generation !== liveGeneration || liveSessionRef.current !== activeSession.sessionId) return;
        if (name === "request") {
          const request = payload as unknown as LiveRequest;
          if (typeof request.requestId === "string" && LIVE_MCP_TOOLS.includes(request.tool)) void execute(request, activeSession.ownerToken, activeSession.sessionId, liveGeneration);
        } else if (name === "cancel" && typeof payload.requestId === "string") {
          pendingRef.current.get(payload.requestId)?.abort(new DOMException("The MCP client cancelled this request.", "AbortError"));
        }
      }, controller.signal);
      if (liveSessionRef.current === activeSession.sessionId) {
        liveSessionRef.current = "";
        setSessionId("");
        setClients([]);
        sessionOwnerTokenRef.current = "";
      }
      for (const pending of pendingRef.current.values()) pending.abort(new DOMException("The Browser Host event stream disconnected.", "AbortError"));
      pendingRef.current.clear();
      if (mountedRef.current) setActiveRequests([]);
      if (mountedRef.current) setState("disconnected");
    } catch (caught) {
      const abandonedSession = created?.sessionId;
      if (liveSessionRef.current) liveSessionRef.current = "";
      abortRef.current?.abort(); abortRef.current = null;
      if (abandonedSession && created) await ownerRequest(`/live/sessions/${encodeURIComponent(abandonedSession)}`, { method: "DELETE" }, created.ownerToken).catch(() => undefined);
      sessionOwnerTokenRef.current = "";
      setSessionId(""); setClients([]);
      if (mountedRef.current && !eventController?.signal.aborted) { setState("error"); setError(caught instanceof Error ? caught.message : "Could not connect to the Gateway."); }
    }
  }

  async function stop(): Promise<void> {
    const id = liveSessionRef.current;
    const sessionOwnerToken = sessionOwnerTokenRef.current;
    liveSessionRef.current = "";
    sessionOwnerTokenRef.current = "";
    abortRef.current?.abort(); abortRef.current = null;
    for (const controller of pendingRef.current.values()) controller.abort();
    pendingRef.current.clear(); setActiveRequests([]); setClients([]); setSessionId(""); setState("disabled"); setEnabled(false); setNewToken("");
    if (id && sessionOwnerToken) await ownerRequest(`/live/sessions/${encodeURIComponent(id)}`, { method: "DELETE" }, sessionOwnerToken).catch(() => undefined);
    setOwnerKey("");
  }

  async function grantClient(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!clientName.trim() || !clientCaps.length || !sessionId) { setError("Choose a client name and at least one capability."); return; }
    setError(""); setNewToken("");
    try {
      const grant = await ownerRequest<{ token: string }>(`/live/sessions/${encodeURIComponent(sessionId)}/clients`, {
        method: "POST", body: JSON.stringify({ name: clientName.trim(), capabilities: clientCaps }),
      }, sessionOwnerTokenRef.current);
      setNewToken(grant.token); setClientName(""); setClientCaps([]); await refreshClients();
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Client could not be authorized."); }
  }

  async function revokeClient(clientId: string): Promise<void> {
    try { await ownerRequest(`/live/sessions/${encodeURIComponent(sessionId)}/clients/${encodeURIComponent(clientId)}`, { method: "DELETE" }, sessionOwnerTokenRef.current); await refreshClients(); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "Client could not be revoked."); }
  }

  async function approveProposal(proposal: LiveWorkspaceProposal): Promise<void> {
    if (!canApply) { setError("Save the editor draft before approving a workspace proposal."); return; }
    try {
      const changes: WorkspaceChange[] = [];
      const readSet: FileRevisionExpectation[] = [];
      for (const change of proposal.changes) {
        const actual = await git.read(change.path);
        if (actual.revision.oid !== change.expectedRevision) throw new Error(`The file ${change.path} changed after this proposal was submitted. It remains unapplied.`);
        const expectedRevision = { oid: change.expectedRevision };
        readSet.push({ path: change.path, revision: expectedRevision });
        changes.push({ path: change.path, content: new TextEncoder().encode(change.content), expectedRevision });
      }
      await git.applyChanges(changes, readSet); setProposals(current => current.filter(item => item.id !== proposal.id)); await onWorkspaceChanged();
      setError(`Approved “${proposal.title}”. The changes are in the local worktree and still need a local commit and GitHub publish.`);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Proposal review failed."); }
  }

  const [proposals, setProposals] = useState<LiveWorkspaceProposal[]>([]);

  return <details className="live-mcp-panel" open={enabled || undefined}>
    <summary>Live MCP <span className={`connection-indicator ${state === "connected" ? "connected" : "local-only"}`} aria-label={`MCP ${state}`} /></summary>
    <div className="live-mcp-content">
      <label htmlFor="live-owner-key">Gateway owner key</label>
      <input id="live-owner-key" type="password" autoComplete="off" value={ownerKey} onChange={event => setOwnerKey(event.target.value)} placeholder="Enter the Gateway's live MCP owner key" />
      <label htmlFor="live-gateway-url">Gateway URL</label><input id="live-gateway-url" type="url" value={gatewayUrl} disabled={state === "connected" || state === "connecting"} onChange={event => onGatewayUrlChange(event.target.value)} placeholder="https://gateway.example.com" />
      <fieldset disabled={state === "connected" || state === "connecting"}>
        <legend>Tools published for this workspace</legend>
        {LIVE_MCP_TOOLS.map(tool => <label key={tool} className="capability-choice"><input type="checkbox" checked={selected.includes(tool)} onChange={event => setSelected(current => event.target.checked ? [...current, tool] : current.filter(item => item !== tool))} /> <span>{tool}</span></label>)}
      </fieldset>
      {state === "connected" ? <><p role="status">Live on {endpoint}. Browser tab must stay open.</p><p>Workspace: {workspaceId}</p><button type="button" onClick={() => void stop()}>Stop Live MCP</button>
        <form onSubmit={event => void grantClient(event)}><label htmlFor="mcp-client-name">Authorize an MCP client</label><input id="mcp-client-name" value={clientName} onChange={event => setClientName(event.target.value)} maxLength={128} placeholder="Client name" /><fieldset><legend>Client capabilities</legend>{selected.map(tool => <label key={tool} className="capability-choice"><input type="checkbox" checked={clientCaps.includes(tool)} onChange={event => setClientCaps(current => event.target.checked ? [...current, tool] : current.filter(item => item !== tool))} /> <span>{tool}</span></label>)}</fieldset><button type="submit">Authorize client</button></form>
        {newToken && <div role="alert"><strong>Copy this client token now. It is shown only once.</strong><textarea aria-label="New MCP client token" readOnly value={newToken} /><p>Endpoint: <code>{endpoint}</code></p></div>}
        <ul aria-label="Authorized MCP clients">{clients.map(client => <li key={client.clientId}><span>{client.name} · {client.capabilities.join(", ")}</span><button type="button" onClick={() => void revokeClient(client.clientId)}>Revoke</button></li>)}</ul>
        <p>{activeRequests.length ? `Running: ${activeRequests.map(item => item.tool).join(", ")}` : "No requests running."}</p>
        {recentRequests.length > 0 && <ul aria-label="Recent MCP requests">{recentRequests.map(item => <li key={item.id}>{item.tool}: {item.status}</li>)}</ul>}
      </> : <button type="button" disabled={state === "connecting" || !gatewayUrl} onClick={() => void connect()}>{state === "connecting" ? "Connecting…" : "Enable Live MCP"}</button>}
      {state === "disconnected" && <p role="status">Gateway disconnected. Reconnect to create a new session; authorized clients must pair again.</p>}
      {error && <p role="alert">{error}</p>}
      {proposals.map(proposal => <article key={proposal.id}><h3>{proposal.title}</h3><ul>{proposal.changes.map(change => <li key={change.path}>{change.path} · {change.content.length} characters<pre>{change.content.slice(0, 1200)}{change.content.length > 1200 ? "…" : ""}</pre></li>)}</ul><button type="button" disabled={!canApply} onClick={() => void approveProposal(proposal)}>Review and approve</button><button type="button" onClick={() => setProposals(value => value.filter(item => item.id !== proposal.id))}>Reject</button></article>)}
      {enabled && state !== "connected" && <button type="button" onClick={() => { void stop(); }}>Disable</button>}
    </div>
  </details>;
}
