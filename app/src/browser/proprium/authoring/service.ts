import type { ActionRequest, ActionResult, Scope, Snapshot, SurfaceDeclaration, ArtifactMetadata,
  CacheKey, ChangeSet as WireChangeSet, ChangeUnit as WireChangeUnit } from "./types.js";
import { AuthoringSnapshotReader, type SnapshotLease, type SnapshotPort, type SnapshotPage, type SnapshotFile,
  type SnapshotRange } from "./snapshots.js";
import { BrowserGitSnapshotPort } from "../git/authoring-snapshot-port.js";
import { BrowserLocalGit } from "../git/index.js";
import type { RemoteConfirmedFiles, WorkspaceIdentity } from "../git/protocol.js";
import { BrowserPluginManager, type InstalledPlugin, type ResolvedAssetGroup } from "../plugins/manager.js";
import { AuthoringActionDispatcher, type ActionIdempotencyStore, type IdempotencyKey, type IdempotencyClaim,
  type HostOperationContext, type InvocationContext, type TrustedActionPrincipal, type StageLeaseInvocation } from "./actions.js";
import type { ActionRuntime, VerifiedActionSet } from "./actions.js";
import { IndexedDbBrokerStore, DerivedCacheBroker, FreshGestureAuthority, PluginPreferencesBroker, ArtifactBroker } from "./brokers.js";
import { AssetGroupBroker, IndexedDbAssetGroupStore, type AssetCapacityInput, type AssetCapacityMeasurement,
  type AssetArtifactSource, type AssetReadRequest, type AssetCapacityConsent, type AssetAdmissionResult,
  type AssetTransferProgress } from "./assets.js";
import { ChangeWriter, type ChangeSet as WriterChangeSet, type WriterCaller, type WriterProposalRecord,
  type ProposalInspection, type ProposalState, type WriterSnapshot, type WriterReadRevision,
  type WriterUnit } from "./writer.js";
import { IndexedDbWriterJournalStore } from "./store.js";
import { BrowserGitWriterWorkspace } from "./writer-browser.js";
import { ChangeStageStore, type ChangeStageContext, type ChangeStageRead } from "./stages.js";

export interface AuthoringWorkspaceSelection {
  readonly git: BrowserLocalGit;
  readonly identity: WorkspaceIdentity;
  /** Host-issued value incremented whenever workspace, branch or repository binding changes. */
  readonly generation: string;
}
export interface AuthoringEditorState {
  readonly path: string | null;
  readonly dirty: boolean;
  readonly draft_generation: string | null;
  readonly composing: boolean;
}
export type AuthoringPrincipal = TrustedActionPrincipal;
export interface AuthoringGesturePort {
  issue(event: Event): object;
  consume(token: object): boolean;
}
export interface AuthoringNavigationTarget {
  readonly path?: string;
  readonly panel_id?: string;
  readonly span?: { path?: string; revision?: string; start: number; end: number; quote?: string };
}
export interface AuthoringSnapshotContext {
  readonly scope: Scope;
  readonly snapshot: Snapshot;
  readonly lease: SnapshotLease;
  readonly reader: AuthoringSnapshotReader;
}
export interface HostInvocationContext extends AuthoringSnapshotContext {
  readonly caller: "ui" | "mcp" | "plugin";
  readonly caller_plugin_id?: string;
  readonly actor_id: string;
  readonly request_id: string;
  readonly deadline_at: number;
  readonly user_gesture_verified: boolean;
  readonly activation_epoch: number;
  readonly invocation_id: string;
  readonly grants: readonly string[];
  readonly host_capabilities: readonly string[];
  readonly signal: AbortSignal;
  readonly call_stack: readonly string[];
}
export interface BrowserAuthoringAuthority {
  issue(principal: AuthoringPrincipal, plugin_id: string, action_id: string): Promise<HostInvocationContext>;
  issueChild(parent: InvocationContext, caller_plugin_id: string, target_plugin_id: string, action_id: string,
    staging_snapshot?: string): Promise<HostInvocationContext>;
  assertCurrent(context: InvocationContext): Promise<void>;
  isSnapshotCurrent(context: InvocationContext): boolean;
}
export interface AuthoringServiceBackends {
  /** Host capability routes use these same authorities as UI action calls. */
  readonly identityRead?: (context: AuthoringSnapshotContext, paths: readonly string[]) => Promise<unknown>;
  readonly repositorySnapshotRead?: (payload: Record<string, unknown>, context: AuthoringHostOperationContext) =>
    Promise<AuthoringSnapshotContext>;
  readonly propose?: (request: ActionRequest, changeset: unknown, context: AuthoringHostOperationContext) => Promise<unknown>;
  readonly stage?: (request: ActionRequest, payload: Record<string, unknown>, context: AuthoringHostOperationContext) => Promise<unknown>;
  readonly cacheGet?: (pluginId: string, payload: Record<string, unknown>) => Promise<unknown>;
  readonly cachePut?: (pluginId: string, payload: Record<string, unknown>) => Promise<unknown>;
  readonly cacheEvict?: (pluginId: string, payload: Record<string, unknown>) => Promise<unknown>;
  readonly preferenceRead?: (pluginId: string, payload: Record<string, unknown>) => Promise<unknown>;
  readonly preferenceWrite?: (pluginId: string, payload: Record<string, unknown>, gesture: object) => Promise<unknown>;
  readonly artifactCreate?: (pluginId: string, request: ActionRequest, payload: Record<string, unknown>) => Promise<unknown>;
  readonly artifactAppend?: (pluginId: string, payload: Record<string, unknown>) => Promise<unknown>;
  readonly artifactSeal?: (pluginId: string, payload: Record<string, unknown>) => Promise<unknown>;
  readonly artifactDiscard?: (pluginId: string, payload: Record<string, unknown>) => Promise<unknown>;
  readonly proposalRead?: (operation: string, request: ActionRequest, payload: Record<string, unknown>) => Promise<unknown>;
  readonly capabilitiesQuery?: (payload: Record<string, unknown>, context: AuthoringHostOperationContext) => Promise<unknown>;
  readonly changeTimestamp?: (request: ActionRequest) => Promise<unknown>;
  readonly assetRead?: (pluginId: string, caller: "ui" | "mcp" | "plugin", scope: Scope, payload: AssetReadRequest) => Promise<unknown>;
  readonly readOverlay?: (scope: Scope, base: Snapshot, token: string, callerChain: readonly string[],
    invocationId: string) => Promise<AuthoringSnapshotContext | undefined>;
  readonly releaseInvocation?: (context: StageLeaseInvocation) => Promise<void> | void;
  readonly navigate?: (target: AuthoringNavigationTarget, intent: "open" | "reveal", expected: {
    scope: Scope; snapshot: Snapshot; editor: AuthoringEditorState;
  }) => Promise<void>;
}
export interface BrowserAuthoringServiceOptions {
  readonly selectWorkspace: () => AuthoringWorkspaceSelection | null;
  readonly editorState: () => AuthoringEditorState;
  readonly manager: Pick<BrowserPluginManager, "installed" | "verifiedActionSet" | "authoringRuntime">;
  readonly idempotency: ActionIdempotencyStore;
  readonly gestures: AuthoringGesturePort;
  readonly backends: AuthoringServiceBackends;
  readonly getRemoteConfirmed?: (paths: readonly string[]) => Promise<RemoteConfirmedFiles>;
  readonly gestureClaimsEvent?: (event: Event) => void;
  readonly createRequestId?: () => string;
  readonly actorId?: () => string;
  readonly assetInspector?: (pluginId: string, groupId: string, signal?: AbortSignal) => ReturnType<AssetGroupBroker["inspect"]>;
  readonly assetAdmitter?: (gesture: object, pluginId: string, groupId: string,
    consent: AssetCapacityConsent, signal?: AbortSignal,
    onProgress?: (progress: AssetTransferProgress) => void) => Promise<AssetAdmissionResult>;
  readonly externalSignal?: (requestId: string) => AbortSignal | undefined;
  readonly writer?: ChangeWriter;
  readonly artifactHandle?: (pluginId: string, artifactId: string, scope: Scope, snapshot: Snapshot) => Promise<AuthoringHostArtifact | undefined>;
  readonly disposeBackends?: () => Promise<void> | void;
}

export interface AuthoringHostArtifact {
  readonly metadata: ArtifactMetadata;
  readChunk(offset: number, length?: number): Promise<{
    readonly offset: number; readonly total_bytes: number; readonly bytes: Uint8Array;
    readonly sha256: string; readonly next_offset: number | null;
  }>;
  previewText(maxBytes?: number): Promise<{ readonly text: string; readonly truncated: boolean }>;
  readAll(event: Event, maxBytes?: number): Promise<Blob>;
}

export interface CreateBrowserAuthoringServiceOptions {
  readonly manager: BrowserPluginManager;
  readonly git: BrowserLocalGit;
  readonly workspace: WorkspaceIdentity;
  readonly generation: string;
  readonly getEditorState: () => AuthoringEditorState;
  readonly getRemoteConfirmed?: (paths: readonly string[]) => Promise<RemoteConfirmedFiles>;
  readonly onNavigate: (target: AuthoringNavigationTarget, intent: "open" | "reveal", expected: {
    scope: Scope; snapshot: Snapshot; editor: AuthoringEditorState;
  }) => Promise<void>;
  readonly onMutationBusy: (busy: boolean) => void;
  /** Host-owned selector resolver. It succeeds only for an explicitly selected and granted read binding. */
  readonly resolveRepositorySnapshot?: (selector: Record<string, unknown>, context: AuthoringHostOperationContext) =>
    Promise<AuthoringSnapshotContext>;
  readonly assertForeignRead?: (scope: Scope, snapshot: Snapshot, path: string, revision: string | null) => Promise<void>;
  readonly measureAssetCapacity?: (input: AssetCapacityInput) => Promise<AssetCapacityMeasurement>;
  readonly validatePreference?: (pluginId: string, key: string, schemaVersion: number, value: unknown) => boolean;
  readonly queryCapabilities?: (payload: Record<string, unknown>, context: AuthoringHostOperationContext) => Promise<unknown>;
  readonly createRequestId?: () => string;
  readonly actorId?: () => string;
}

export interface UiActionWithArtifact {
  readonly action_result: ActionResult;
  readonly artifact?: AuthoringHostArtifact;
}
export interface AuthoringSurfaceRegistration {
  readonly pluginId: string;
  readonly pluginVersion: string;
  readonly manifestDigest?: string;
  readonly surface: SurfaceDeclaration;
  readonly availability: "ready" | "disabled" | "dependency_unavailable" | "capability_denied" | "incompatible";
  readonly reason?: string;
}
export interface AuthoringHostPort {
  request<T = unknown>(operation: string, payload: Record<string, unknown>, request: ActionRequest,
    pluginId: string, gesture?: object): Promise<T>;
}
export type AuthoringHostOperationContext = HostOperationContext;
export interface BrowserAuthoringCapabilityPorts {
  identityRead(payload: Record<string, unknown>, context: AuthoringHostOperationContext): Promise<unknown>;
  repositorySnapshotRead(payload: Record<string, unknown>, context: AuthoringHostOperationContext): Promise<unknown>;
  fileList(payload: Record<string, unknown>, context: AuthoringHostOperationContext): Promise<unknown>;
  fileRead(payload: Record<string, unknown>, context: AuthoringHostOperationContext): Promise<unknown>;
  navigate(payload: Record<string, unknown>, context: AuthoringHostOperationContext): Promise<void>;
  propose(payload: Record<string, unknown>, context: AuthoringHostOperationContext): Promise<unknown>;
  stage(payload: Record<string, unknown>, context: AuthoringHostOperationContext): Promise<unknown>;
  cacheGet(payload: Record<string, unknown>, context: AuthoringHostOperationContext): Promise<unknown>;
  cachePut(payload: Record<string, unknown>, context: AuthoringHostOperationContext): Promise<unknown>;
  cacheEvict(payload: Record<string, unknown>, context: AuthoringHostOperationContext): Promise<unknown>;
  preferencesRead(payload: Record<string, unknown>, context: AuthoringHostOperationContext): Promise<unknown>;
  artifactCreate(payload: Record<string, unknown>, context: AuthoringHostOperationContext): Promise<unknown>;
  artifactAppend(payload: Record<string, unknown>, context: AuthoringHostOperationContext): Promise<unknown>;
  artifactSeal(payload: Record<string, unknown>, context: AuthoringHostOperationContext): Promise<unknown>;
  artifactDiscard(payload: Record<string, unknown>, context: AuthoringHostOperationContext): Promise<unknown>;
  proposalList(payload: Record<string, unknown>, context: AuthoringHostOperationContext): Promise<unknown>;
  proposalStatus(payload: Record<string, unknown>, context: AuthoringHostOperationContext): Promise<unknown>;
  proposalObservations(payload: Record<string, unknown>, context: AuthoringHostOperationContext): Promise<unknown>;
  proposalInspect(payload: Record<string, unknown>, context: AuthoringHostOperationContext): Promise<unknown>;
  proposalContentRead(payload: Record<string, unknown>, context: AuthoringHostOperationContext): Promise<unknown>;
  capabilitiesQuery(payload: Record<string, unknown>, context: AuthoringHostOperationContext): Promise<unknown>;
  timestamp(payload: Record<string, unknown>, context: AuthoringHostOperationContext): Promise<unknown>;
  assetRead(payload: Record<string, unknown>, context: AuthoringHostOperationContext): Promise<unknown>;
  releaseInvocation(context: StageLeaseInvocation): Promise<void>;
  validateStage(snapshotId: string, context: AuthoringHostOperationContext): Promise<void>;
}

const ID = () => crypto.randomUUID();
const ACTION_PAGE = 50;

/**
 * Host facade shared by the recovered Desktop/Mobile surfaces and the existing
 * Gateway plugin_call adapter. It owns selection, saved-byte snapshots, gesture
 * capture, and the one action dispatcher; plugin IDs never select a repository.
 */
export class BrowserAuthoringService {
  private readonly dispatcher: AuthoringActionDispatcher;
  private readonly leases = new Map<string, AuthoringSnapshotContext>();
  private readonly preferenceGestures = new Map<string, object>();
  private readonly consumedEvents = new WeakSet<Event>();
  private readonly nextRequestId: () => string;
  private readonly requestLeases = new Map<string, AuthoringSnapshotContext>();
  private readonly foreignLeases = new Map<string, Map<string, AuthoringSnapshotContext>>();
  private readonly invocationStageLeases = new Map<string, Set<string>>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly abortListeners = new Map<string, { signal: AbortSignal; listener: () => void }>();
  private readonly uiProposalRetryKeys = new Map<string, string>();
  private readonly verifiedUiContinuations = new Set<string>();
  private actionSnapshotQueue: Promise<unknown> = Promise.resolve();
  private disposed = false;
  private retainedActionSnapshot: AuthoringSnapshotContext | null = null;

  constructor(private readonly options: BrowserAuthoringServiceOptions) {
    this.nextRequestId = options.createRequestId ?? ID;
    this.dispatcher = new AuthoringActionDispatcher({
      installed: pluginId => options.manager.verifiedActionSet(pluginId),
      authority: this.authority,
      runtime: { invoke: invoke => options.manager.authoringRuntime(invoke.request.plugin_id).invoke(invoke) },
      capabilities: this.capabilityPorts(),
      idempotency: options.idempotency,
    });
  }

  async listSurfaces(): Promise<AuthoringSurfaceRegistration[]> {
    const installed = await this.options.manager.installed();
    const registrations: AuthoringSurfaceRegistration[] = [];
    for (const plugin of installed) {
      const manifest = plugin.manifest;
      if (!manifest || manifest.schema !== "proprium.plugin/v2") continue;
      const available = plugin.state === "enabled-idle" || plugin.state === "active";
      for (const surface of plugin.surfaces) {
        registrations.push(Object.freeze({ pluginId: plugin.id, pluginVersion: plugin.version,
        manifestDigest: (plugin as InstalledPlugin & { manifestDigest?: string }).manifestDigest,
        surface, availability: available ? "ready" : "disabled",
          ...(!available ? { reason: "Enable this signed plugin from the Plugin Registry to use its authoring actions." } : {}) }));
      }
    }
    return registrations;
  }

  /** Captures the browser's real trusted event before any asynchronous work. */
  async invokeUi(event: Event, pluginId: string, actionId: string, input: Record<string, unknown>, followNavigation = false): Promise<ActionResult> {
    const principal = this.makePrincipal("ui", event);
    if (followNavigation) {
      if (!principal.user_gesture_token || !this.options.gestures.consume(principal.user_gesture_token as object)) throw deniedGesture();
      this.verifiedUiContinuations.add(principal.request_id);
    }
    try {
      let idempotencyKey = typeof input.idempotency_key === "string" ? input.idempotency_key : undefined;
      let retryIdentity: string | undefined;
      const descriptor = (await this.options.manager.verifiedActionSet(pluginId))?.descriptors.find(item => item.action_id === actionId);
      if (!idempotencyKey && descriptor?.effect === "propose") {
        retryIdentity = canonicalJson({ pluginId, actionId, input });
        idempotencyKey = this.uiProposalRetryKeys.get(retryIdentity) ?? this.nextRequestId();
        this.uiProposalRetryKeys.set(retryIdentity, idempotencyKey);
      }
      const result = await this.dispatcher.invoke({ plugin_id: pluginId, action_id: actionId, input,
        ...(idempotencyKey ? { idempotency_key: idempotencyKey } : {}) }, principal);
      if (result.ok && retryIdentity) this.uiProposalRetryKeys.delete(retryIdentity);
      if (followNavigation && result.ok && isRecord(result.value) && isRecord(result.value.navigation)) {
        const navigation = result.value.navigation;
        const expected = navigation.expected_context;
        if (!isRecord(expected) || !sameScope(expected.scope as unknown as Scope, result.scope) ||
            !sameJson(expected.snapshot, result.snapshot) || !isRecord(navigation.target) ||
            typeof navigation.target.path !== "string" || !["open", "reveal"].includes(String(navigation.intent))) throw invalid("Navigation intent has no matching action snapshot");
        await this.navigateHost(navigation.target as unknown as AuthoringNavigationTarget, navigation.intent as "open" | "reveal", {
          schema_version: 1, request_id: result.request_id, plugin_id: pluginId, action_id: actionId,
          scope: result.scope, snapshot: result.snapshot, input, deadline_ms: 30_000,
        });
      }
      return result;
    } finally { await this.releaseRequest(principal.request_id); this.preferenceGestures.delete(principal.request_id); this.verifiedUiContinuations.delete(principal.request_id); }
  }

  /** Runs the normal UI action through the same dispatcher as MCP and admits a host-owned result artifact. */
  async invokeUiWithArtifacts(event: Event, pluginId: string, actionId: string,
    input: Record<string, unknown>): Promise<UiActionWithArtifact> {
    const action_result = await this.invokeUi(event, pluginId, actionId, input, true);
    if (!action_result.ok || !isRecord(action_result.value) || typeof action_result.value.artifact_id !== "string" ||
        !this.options.artifactHandle) return { action_result };
    try {
      const artifact = await this.options.artifactHandle(pluginId, action_result.value.artifact_id,
        action_result.scope, action_result.snapshot);
      return artifact ? { action_result, artifact } : { action_result };
    } catch { return { action_result }; }
  }

  /** Background UI reads (such as editor term resolution) carry no gesture grant. */
  async invokeRead(pluginId: string, actionId: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<ActionResult> {
    if (signal?.aborted) return Promise.reject(Object.assign(new Error("Action was cancelled"), { code: "cancelled" }));
    const principal = this.makePrincipal("ui");
    try {
      if (signal) {
        const controller = new AbortController();
        this.controllers.set(principal.request_id, controller);
        const abort = () => controller.abort(signal.reason);
        this.abortListeners.set(principal.request_id, { signal, listener: abort });
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      }
      return await this.dispatcher.invoke({ plugin_id: pluginId, action_id: actionId, input }, principal);
    }
    finally { await this.releaseRequest(principal.request_id); }
  }

  /** Gateway code passes an authenticated Host principal created at the Access boundary. */
  async invokeMcp(pluginId: string, actionId: string, input: Record<string, unknown>, actorId: string,
    requestId = this.nextRequestId(), idempotencyKey?: string, signal?: AbortSignal): Promise<ActionResult> {
    const principal: AuthoringPrincipal = { caller: "mcp", actor_id: actorId, request_id: requestId,
      selected_scope: this.scope(this.requireSelection()) };
    if (signal) {
      const controller = new AbortController();
      this.controllers.set(requestId, controller);
      const listener = () => controller.abort(signal.reason);
      this.abortListeners.set(requestId, { signal, listener });
      signal.addEventListener("abort", listener, { once: true });
      if (signal.aborted) listener();
    }
    try { return await this.dispatcher.invoke({ plugin_id: pluginId, action_id: actionId, input,
      ...(idempotencyKey ? { idempotency_key: idempotencyKey } : {}) }, principal); }
    finally { await this.releaseRequest(principal.request_id); }
  }

  async actions(pluginId: string, caller: "ui" | "mcp" = "ui", cursor?: string, limit = ACTION_PAGE) {
    const principal = this.makePrincipal(caller);
    return this.dispatcher.list({ plugin_id: pluginId, ...(cursor ? { cursor } : {}), limit }, principal);
  }

  async listProposals(cursor?: string, limit = 50, status?: ProposalState) {
    const scope = this.scope(this.requireSelection());
    return this.requireWriter().list(scope, cursor, limit, status);
  }

  async proposalStatus(proposalId: string): Promise<WriterProposalRecord> {
    return this.requireWriter().status(this.scope(this.requireSelection()), proposalId);
  }

  async inspectProposal(proposalId: string, cursor?: string, limit = 20, includeSource = false): Promise<ProposalInspection> {
    return this.requireWriter().inspect(this.scope(this.requireSelection()), proposalId, cursor, limit, includeSource);
  }

  async readProposalContent(proposalId: string, ref: string, offset = 0, length = 65_536) {
    return this.requireWriter().read_content(this.scope(this.requireSelection()), proposalId, ref, offset, length);
  }

  async applyProposal(event: Event, proposalId: string, unitIds: readonly string[]): Promise<WriterProposalRecord> {
    const gesture = this.issueTrustedEvent(event);
    if (!this.options.gestures.consume(gesture)) throw deniedGesture();
    return this.requireWriter().apply(this.scope(this.requireSelection()), proposalId, unitIds, "ui", true);
  }

  async rejectProposal(event: Event, proposalId: string): Promise<WriterProposalRecord> {
    const gesture = this.issueTrustedEvent(event);
    if (!this.options.gestures.consume(gesture)) throw deniedGesture();
    return this.requireWriter().reject(this.scope(this.requireSelection()), proposalId, "ui", true);
  }

  async recoverProposal(): Promise<WriterProposalRecord | null> {
    return this.requireWriter().recover(this.scope(this.requireSelection()));
  }

  inspectAssetGroup(pluginId: string, groupId: string, signal?: AbortSignal) {
    if (!this.options.assetInspector) return Promise.reject(missing("workspace.asset.inspect"));
    return this.options.assetInspector(pluginId, groupId, signal);
  }

  admitAssetGroup(event: Event, pluginId: string, groupId: string,
    consent: AssetCapacityConsent, signal?: AbortSignal,
    onProgress?: (progress: AssetTransferProgress) => void) {
    if (!this.options.assetAdmitter) return Promise.reject(missing("workspace.asset.admit"));
    let gesture: object;
    try { gesture = this.issueTrustedEvent(event); } catch (error) { return Promise.reject(error); }
    return this.options.assetAdmitter(gesture, pluginId, groupId, consent, signal, onProgress);
  }

  /** Release ephemeral reader leases and abort outstanding UI reads. The shared manager is Host-owned. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    for (const controller of this.controllers.values()) controller.abort();
    for (const listener of this.abortListeners.values()) listener.signal.removeEventListener("abort", listener.listener);
    this.abortListeners.clear();
    this.controllers.clear();
    await this.actionSnapshotQueue;
    const contexts = [...this.leases.values()];
    this.leases.clear(); this.foreignLeases.clear(); this.requestLeases.clear();
    await Promise.allSettled(contexts.map(context => context.reader.release(context.lease)));
    await this.options.disposeBackends?.();
  }

  async navigate(event: Event, target: AuthoringNavigationTarget, intent: "open" | "reveal"): Promise<void> {
    const gesture = this.issueTrustedEvent(event);
    if (!this.options.gestures.consume(gesture)) throw Object.assign(new Error("Navigation needs a fresh user action"), { code: "capability_denied" });
    const selection = this.requireSelection();
    const context = await this.pin(selection);
    try {
      const editor = this.options.editorState();
      if (editor.composing) throw Object.assign(new Error("Finish text composition before opening another document"), { code: "dirty_draft" });
      const path = target.path ?? target.span?.path;
      if (path) {
        const stat = await this.snapshotStat(context, path);
        if (!stat) throw Object.assign(new Error("Navigation target is missing from this snapshot"), { code: "file_not_found" });
        if (target.span && target.span.path && target.span.path !== path) throw invalid("Source span path differs from its navigation target");
        if (target.span?.revision && target.span.revision !== stat.revision) throw Object.assign(new Error("Source span belongs to a stale revision"), { code: "snapshot_stale" });
        if (target.span) {
          if (target.span.end < target.span.start || target.span.end - target.span.start > 4096) throw invalid("Source span is invalid or too large");
          const quote = await this.readUtf16Span(context, path, target.span.start, target.span.end);
          if (typeof target.span.quote === "string" && quote !== target.span.quote) throw Object.assign(new Error("Source quote no longer matches its revision"), { code: "snapshot_stale" });
        }
      }
      if (!this.options.backends.navigate) throw Object.assign(new Error("Workspace navigation is unavailable"), { code: "missing_capability" });
      await this.options.backends.navigate(target, intent, { scope: context.scope, snapshot: context.snapshot, editor });
      if (!sameScope(context.scope, this.scope(this.requireSelection()))) throw staleScope();
    } finally { await this.release(context); }
  }

  /** Route invoked by the trusted action dispatcher after its capability checks. */
  readonly hostPort: AuthoringHostPort = { request: (operation, payload, request, pluginId, gesture) =>
    this.hostRequest(operation, payload, request, pluginId, gesture) };

  async pinCurrent(): Promise<AuthoringSnapshotContext> { return this.pin(this.requireSelection()); }
  async release(context: AuthoringSnapshotContext): Promise<void> {
    const key = snapshotKey(context.scope, context.snapshot);
    const saved = this.leases.get(key);
    if (saved) { this.leases.delete(key); await saved.reader.release(saved.lease); }
  }

  private async hostRequest<T>(operation: string, payload: Record<string, unknown>, request: ActionRequest,
    pluginId: string, gesture?: object, operationContext?: AuthoringHostOperationContext): Promise<T> {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw invalid("Host payload must be an object");
    const context = this.findLease(request.scope, request.snapshot);
    await this.assertCurrent(context);
    switch (operation) {
      case "workspace.identity.read": {
        if (!this.options.backends.identityRead) throw missing(operation);
        return await this.options.backends.identityRead(context, Array.isArray(payload.paths) ? payload.paths as string[] : []) as T;
      }
      case "workspace.repository.snapshot.read": {
        if (!this.options.backends.repositorySnapshotRead || !operationContext) throw missing(operation);
        const foreign = await this.options.backends.repositorySnapshotRead(payload, operationContext);
        if (!sameSnapshotSelector(payload, foreign)) throw Object.assign(new Error("Host read binding differs from its selected workspace snapshot"), { code: "repository_unavailable" });
        const key = `${operationContext.invocation_id}\u0000${foreign.snapshot.id}`;
        let invocationLeases = this.foreignLeases.get(operationContext.invocation_id);
        if (!invocationLeases) this.foreignLeases.set(operationContext.invocation_id, invocationLeases = new Map());
        const prior = invocationLeases.get(key);
        if (prior && (!sameScope(prior.scope, foreign.scope) || !sameJson(prior.snapshot, foreign.snapshot))) {
          throw Object.assign(new Error("Foreign snapshot ID collides with an existing lease"), { code: "ambiguous_identity" });
        }
        invocationLeases.set(key, foreign);
        this.leases.set(snapshotKey(foreign.scope, foreign.snapshot), foreign);
        await this.assertCurrent(foreign);
        return { scope: foreign.scope, snapshot: foreign.snapshot } as T;
      }
      case "workspace.file.list": {
        const boundScope = isScope(payload.scope) ? payload.scope : request.scope;
        const pinned = await this.resolveReadContext(boundScope, request.snapshot, payload.snapshot, operationContext);
        const page = await pinned.reader.list(pinned.lease, { prefix: optionalString(payload.prefix) ?? "",
          cursor: optionalString(payload.cursor) ?? null, limit: optionalNumber(payload.limit) ?? 128 });
        return { entries: page.items, next_cursor: page.next_cursor } as T;
      }
      case "workspace.file.read": {
        const boundScope = isScope(payload.scope) ? payload.scope : request.scope;
        const pinned = await this.resolveReadContext(boundScope, request.snapshot, payload.snapshot, operationContext);
        const path = requiredString(payload.path, "path");
        const range = await pinned.reader.read(pinned.lease, path, { offset: optionalNumber(payload.offset) ?? 0,
          length: Math.min(optionalNumber(payload.length) ?? 65_536, 65_536) });
        return { revision: range.revision, total_bytes: range.total_bytes, offset: range.offset,
          bytes: [...range.bytes], next_offset: range.next_offset } as T;
      }
      case "workspace.change.propose": {
        if (!this.options.backends.propose) throw missing(operation);
        if (!operationContext) throw missing(operation);
        return await this.options.backends.propose(request, payload.changeset, operationContext) as T;
      }
      case "workspace.change.stage":
        if (!this.options.backends.stage) throw missing(operation);
        {
          if (!operationContext) throw missing(operation);
          const value = await this.options.backends.stage(request, payload, operationContext) as { staging_snapshot?: unknown };
          if (typeof value?.staging_snapshot !== "string" || value.staging_snapshot.length > 256) throw Object.assign(new Error("Host staging did not return an opaque lease"), { code: "storage_unknown" });
          return value as T;
        }
      case "workspace.derived.cache.get": return await this.requireBackend(operation, this.options.backends.cacheGet)(pluginId, payload) as T;
      case "workspace.derived.cache.put": return await this.requireBackend(operation, this.options.backends.cachePut)(pluginId, payload) as T;
      case "workspace.derived.cache.evict": return await this.requireBackend(operation, this.options.backends.cacheEvict)(pluginId, payload) as T;
      case "plugin.preferences.read": return await this.requireBackend(operation, this.options.backends.preferenceRead)(pluginId, payload) as T;
      case "artifact.create": return await this.requireBackend(operation, this.options.backends.artifactCreate)(pluginId, request, payload) as T;
      case "artifact.append": return await this.requireBackend(operation, this.options.backends.artifactAppend)(pluginId, payload) as T;
      case "artifact.seal": return await this.requireBackend(operation, this.options.backends.artifactSeal)(pluginId, payload) as T;
      case "artifact.discard": return await this.requireBackend(operation, this.options.backends.artifactDiscard)(pluginId, payload) as T;
      case "workspace.change.list": case "workspace.change.status": case "workspace.change.observations":
      case "workspace.change.inspect": case "workspace.change.content.read":
        if (!this.options.backends.proposalRead) throw missing(operation);
        return await this.options.backends.proposalRead(operation, request, payload) as T;
      case "workspace.capabilities.query":
        if (!this.options.backends.capabilitiesQuery) throw missing(operation);
        if (!operationContext) throw missing(operation);
        return await this.options.backends.capabilitiesQuery(payload, operationContext) as T;
      case "workspace.change.timestamp":
        if (!this.options.backends.changeTimestamp || !request.idempotency_key) throw missing(operation);
        return await this.options.backends.changeTimestamp(request) as T;
      case "workspace.asset.read":
        if (!this.options.backends.assetRead) throw missing(operation);
        return await this.options.backends.assetRead(pluginId, operationContext?.caller ?? "ui", request.scope, payload as unknown as AssetReadRequest) as T;
      default: throw Object.assign(new Error("Host operation is not available in Proprium"), { code: "capability_denied" });
    }
  }

  /** The returned implementation is passed to AuthoringActionDispatcher. */
  capabilityPorts(): BrowserAuthoringCapabilityPorts {
    const routed = (operation: string, handler: (payload: Record<string, unknown>, context: AuthoringHostOperationContext) => Promise<unknown>) =>
      (payload: Record<string, unknown>, context: AuthoringHostOperationContext) => handler(payload, context);
    const route = (operation: string, payload: Record<string, unknown>, context: AuthoringHostOperationContext) =>
      this.hostRequest(operation, payload, context.request, context.plugin_id, this.preferenceGestures.get(context.request.request_id), context);
    return {
      identityRead: routed("workspace.identity.read", (p, c) => route("workspace.identity.read", p, c)),
      repositorySnapshotRead: routed("workspace.repository.snapshot.read", (p, c) => route("workspace.repository.snapshot.read", p, c)),
      fileList: routed("workspace.file.list", (p, c) => route("workspace.file.list", p, c)),
      fileRead: routed("workspace.file.read", (p, c) => route("workspace.file.read", p, c)),
      navigate: async (payload, context) => {
        if (context.caller !== "ui" || !context.user_gesture_verified) throw Object.assign(new Error("Navigation needs author approval"), { code: "capability_denied" });
        const expected = payload.expected_context;
        if (!expected || typeof expected !== "object" ||
            JSON.stringify((expected as Record<string, unknown>).scope) !== JSON.stringify(context.request.scope) ||
            JSON.stringify((expected as Record<string, unknown>).snapshot) !== JSON.stringify(context.request.snapshot)) {
          throw Object.assign(new Error("Navigation context is stale"), { code: "snapshot_stale" });
        }
        await this.navigateHost(payload.target as AuthoringNavigationTarget, payload.intent as "open" | "reveal", context.request);
      },
      propose: routed("workspace.change.propose", (p, c) => route("workspace.change.propose", p, c)),
      stage: routed("workspace.change.stage", (p, c) => route("workspace.change.stage", p, c)),
      cacheGet: routed("workspace.derived.cache.get", (p, c) => route("workspace.derived.cache.get", p, c)),
      cachePut: routed("workspace.derived.cache.put", (p, c) => route("workspace.derived.cache.put", p, c)),
      cacheEvict: routed("workspace.derived.cache.evict", (p, c) => route("workspace.derived.cache.evict", p, c)),
      preferencesRead: routed("plugin.preferences.read", (p, c) => route("plugin.preferences.read", p, c)),
      artifactCreate: routed("artifact.create", (p, c) => route("artifact.create", p, c)),
      artifactAppend: routed("artifact.append", (p, c) => route("artifact.append", p, c)),
      artifactSeal: routed("artifact.seal", (p, c) => route("artifact.seal", p, c)),
      artifactDiscard: routed("artifact.discard", (p, c) => route("artifact.discard", p, c)),
      proposalList: routed("workspace.change.list", (p, c) => route("workspace.change.list", p, c)),
      proposalStatus: routed("workspace.change.status", (p, c) => route("workspace.change.status", p, c)),
      proposalObservations: routed("workspace.change.observations", (p, c) => route("workspace.change.observations", p, c)),
      proposalInspect: routed("workspace.change.inspect", (p, c) => route("workspace.change.inspect", p, c)),
      proposalContentRead: routed("workspace.change.content.read", (p, c) => route("workspace.change.content.read", p, c)),
      capabilitiesQuery: routed("workspace.capabilities.query", (p, c) => route("workspace.capabilities.query", p, c)),
      timestamp: routed("workspace.change.timestamp", (p, c) => route("workspace.change.timestamp", p, c)),
      assetRead: routed("workspace.asset.read", (p, c) => route("workspace.asset.read", p, c)),
      releaseInvocation: async context => {
        await this.options.backends.releaseInvocation?.(context);
        const leases = this.foreignLeases.get(context.invocation_id);
        this.foreignLeases.delete(context.invocation_id);
        if (leases) for (const lease of leases.values()) await this.release(lease);
        const stageKeys = this.invocationStageLeases.get(context.invocation_id);
        this.invocationStageLeases.delete(context.invocation_id);
        if (stageKeys) for (const key of stageKeys) {
          const stage = this.leases.get(key);
          if (stage) await this.release(stage);
        }
      },
      validateStage: async (snapshotId, context) => {
        const result = await this.resolveReadContext(context.request.scope, context.request.snapshot, snapshotId, context);
        await result.reader.list(result.lease, { prefix: "", limit: 1 });
      },
    };
  }

  private async navigateHost(target: AuthoringNavigationTarget, intent: "open" | "reveal", request: ActionRequest): Promise<void> {
    const context = this.findLease(request.scope, request.snapshot);
    await this.assertCurrent(context);
    const editor = this.options.editorState();
    if (editor.composing) throw Object.assign(new Error("Finish text composition before navigation"), { code: "dirty_draft" });
    const path = target.path ?? target.span?.path;
    if (path) {
      const file = await this.snapshotStat(context, path);
      if (!file) throw Object.assign(new Error("Navigation target is absent from the pinned snapshot"), { code: "file_not_found" });
      if (target.span?.revision && target.span.revision !== file.revision) throw Object.assign(new Error("Navigation source is stale"), { code: "snapshot_stale" });
      if (target.span) {
        if (target.span.start < 0 || target.span.end < target.span.start || target.span.end - target.span.start > 4096) throw invalid("Source span is malformed");
        const quote = await this.readUtf16Span(context, path, target.span.start, target.span.end);
        if (target.span.quote !== undefined && target.span.quote !== quote) throw Object.assign(new Error("Navigation evidence changed"), { code: "snapshot_stale" });
      }
    }
    if (!this.options.backends.navigate) throw missing("workspace.navigation");
    await this.options.backends.navigate(target, intent, { scope: request.scope, snapshot: request.snapshot, editor });
  }

  private async assertInvocationCurrent(context: InvocationContext): Promise<void> {
    const saved = this.findLease(context.scope, context.snapshot);
    await this.assertCurrent(saved);
  }

  private async resolveReadContext(scope: Scope, base: Snapshot, selector: unknown,
    operationContext?: AuthoringHostOperationContext): Promise<AuthoringSnapshotContext> {
    if (selector && typeof selector === "object") {
      if (sameScope(scope, operationContext?.request.scope ?? scope) && sameJson(selector, base)) {
        return this.findLease(scope, base);
      }
      const id = isRecord(selector) && typeof selector.id === "string" ? selector.id : "";
      if (id && operationContext?.staging_snapshot === id && sameBaseSnapshot(selector, base)) {
        return this.resolveStageContext(scope, base, id, operationContext);
      }
      const foreign = operationContext && this.foreignLeases.get(operationContext.invocation_id)?.get(`${operationContext.invocation_id}\u0000${id}`);
      if (foreign && sameScope(foreign.scope, scope) && sameJson(foreign.snapshot, selector)) return foreign;
      throw Object.assign(new Error("Requested repository snapshot has no current Host lease"), { code: "snapshot_stale" });
    }
    if (typeof selector === "string" && selector && selector === operationContext?.staging_snapshot && operationContext) {
      return this.resolveStageContext(scope, base, selector, operationContext);
    }
    throw Object.assign(new Error("Pinned or staging snapshot lease is missing"), { code: "snapshot_stale" });
  }

  private async resolveStageContext(scope: Scope, base: Snapshot, selector: string,
    operationContext: AuthoringHostOperationContext): Promise<AuthoringSnapshotContext> {
    if (!this.options.backends.readOverlay) throw Object.assign(new Error("Staging snapshot reader is unavailable"), { code: "snapshot_stale" });
    const callerChain = operationContext.call_stack;
    const overlay = await this.options.backends.readOverlay(scope, base, selector, callerChain, operationContext.invocation_id);
    if (!overlay || !sameScope(overlay.scope, scope) || overlay.snapshot.id !== selector ||
        overlay.snapshot.local_commit !== base.local_commit || overlay.snapshot.worktree_generation !== base.worktree_generation ||
        overlay.snapshot.draft_generation !== base.draft_generation) {
      throw Object.assign(new Error("Staging lease differs from its original workspace base"), { code: "snapshot_stale" });
    }
    this.leases.set(snapshotKey(overlay.scope, overlay.snapshot), overlay);
    const invocationId = operationContext.invocation_id;
    const stagedKeys = this.invocationStageLeases.get(invocationId) ?? new Set<string>();
    stagedKeys.add(snapshotKey(overlay.scope, overlay.snapshot));
    this.invocationStageLeases.set(invocationId, stagedKeys);
    await overlay.reader.list(overlay.lease, { prefix: "", limit: 1 });
    return overlay;
  }

  private async readUtf16Span(context: AuthoringSnapshotContext, path: string, start: number, end: number): Promise<string> {
    const stat = await this.snapshotStat(context, path);
    if (!stat) throw Object.assign(new Error("Evidence file is missing"), { code: "file_not_found" });
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let text = "";
    for (let offset = 0; offset < stat.byte_length;) {
      const length = Math.min(65_536, stat.byte_length - offset);
      const range = await context.reader.read(context.lease, path, { offset, length });
      if (range.revision !== stat.revision || range.offset !== offset || range.bytes.byteLength !== length) {
        throw Object.assign(new Error("Source changed while reading evidence"), { code: "snapshot_stale" });
      }
      text += decoder.decode(range.bytes, { stream: offset + length < stat.byte_length });
      offset += length;
    }
    if (stat.byte_length === 0) text += decoder.decode();
    if (start < 0 || end < start || end > text.length) throw Object.assign(new Error("UTF-16 source span exceeds the document"), { code: "invalid_input" });
    return text.slice(start, end);
  }

  private async pin(selection: AuthoringWorkspaceSelection): Promise<AuthoringSnapshotContext> {
    const scope = this.scope(selection);
    const reader = new AuthoringSnapshotReader(new BrowserGitSnapshotPort(selection.git, selection.identity));
    let lease = await reader.pin(scope, false);
    const remote = await this.options.getRemoteConfirmed?.([]);
    if (remote) lease = Object.freeze({ ...lease,
      snapshot: Object.freeze({ ...lease.snapshot, remote_commit: remote.remote_commit }) });
    const context: AuthoringSnapshotContext = Object.freeze({ scope, snapshot: lease.snapshot, lease, reader });
    this.leases.set(snapshotKey(scope, lease.snapshot), context);
    return context;
  }
  private async assertCurrent(context: AuthoringSnapshotContext): Promise<void> {
    const current = this.requireSelection();
    if (!sameScope(context.scope, this.scope(current)) && !this.isForeignLease(context)) {
      throw Object.assign(new Error("Workspace selection changed"), { code: "snapshot_stale" });
    }
    const saved = this.findLease(context.scope, context.snapshot);
    await saved.reader.assertCurrent(saved.lease);
  }
  private findLease(scope: Scope, snapshot: Snapshot): AuthoringSnapshotContext {
    const direct = this.leases.get(snapshotKey(scope, snapshot));
    const found = direct ?? [...this.foreignLeases.values()].flatMap(items => [...items.values()]).find(item =>
      sameScope(item.scope, scope) && sameJson(item.snapshot, snapshot));
    if (!found) throw Object.assign(new Error("Snapshot is no longer owned by the active Host"), { code: "snapshot_stale" });
    return found;
  }
  private isForeignLease(context: AuthoringSnapshotContext): boolean {
    return [...this.foreignLeases.values()].some(items => [...items.values()].includes(context));
  }
  private isSnapshotCurrent(context: InvocationContext): boolean {
    const selected = this.options.selectWorkspace();
    if (!selected) return false;
    const currentScope = this.scope(selected);
    if (!sameScope(currentScope, context.scope) && ![...this.foreignLeases.values()].some(items =>
      [...items.values()].some(lease => sameScope(lease.scope, context.scope) && sameJson(lease.snapshot, context.snapshot)))) return false;
    const lease = this.leases.get(snapshotKey(context.scope, context.snapshot));
    return !!lease && lease.snapshot.id === context.snapshot.id;
  }
  private requireSelection(): AuthoringWorkspaceSelection {
    const value = this.options.selectWorkspace();
    if (!value || !value.generation) throw Object.assign(new Error("No active authoring workspace"), { code: "repository_not_active" });
    return value;
  }
  private scope(value: AuthoringWorkspaceSelection): Scope {
    return { workspace_id: value.identity.localWorkspaceId,
      repository_id: value.identity.provider === "local" ? null : value.identity.repositoryId,
      branch: value.identity.branch, generation: value.generation };
  }
  private makePrincipal(caller: "ui" | "mcp", event?: Event): AuthoringPrincipal {
    const selection = this.requireSelection();
    const request_id = this.nextRequestId();
    let user_gesture_token: unknown;
    if (caller === "ui" && event?.isTrusted) {
      try { user_gesture_token = this.issueTrustedEvent(event); }
      catch { user_gesture_token = undefined; }
    }
    return { caller, actor_id: this.options.actorId?.() ?? (caller === "mcp" ? "gateway" : "local"),
      selected_scope: this.scope(selection), request_id, ...(user_gesture_token ? { user_gesture_token } : {}) };
  }

  private issueTrustedEvent(event: Event): object {
    if (!event?.isTrusted || this.consumedEvents.has(event)) {
      throw Object.assign(new Error("A new trusted user action is required"), { code: "capability_denied" });
    }
    this.consumedEvents.add(event);
    this.options.gestureClaimsEvent?.(event);
    return this.options.gestures.issue(event);
  }

  /** The action broker and workers share this single scope/snapshot authority. */
  readonly authority: BrowserAuthoringAuthority = {
    issue: async (principal, plugin_id, action_id) => {
      const selected = this.requireSelection();
      const scope = this.scope(selected);
      if (!principal.selected_scope || !sameScope(principal.selected_scope, scope)) throw staleScope();
      const installed = await this.options.manager.verifiedActionSet(plugin_id);
      if (!installed?.activation_epoch) throw Object.assign(new Error("Plugin is unavailable or disabled"), { code: "plugin_unavailable" });
      const obtain = async () => {
        this.requireSelection();
        let current = this.retainedActionSnapshot;
        if (current) {
          try { await this.assertCurrent(current); }
          catch (error) {
            if ((error as { code?: string }).code !== "snapshot_stale") throw error;
            this.retainedActionSnapshot = null;
            if (![...this.requestLeases.values()].includes(current)) await this.release(current);
            current = null;
          }
        }
        if (!current) {
          current = await this.pin(selected);
          if (this.disposed) { await this.release(current); throw staleScope(); }
          this.retainedActionSnapshot = current;
        }
        return current;
      };
      const pending = this.actionSnapshotQueue.then(obtain, obtain);
      this.actionSnapshotQueue = pending.then(() => undefined, () => undefined);
      const pinned = await pending;
      this.requestLeases.set(principal.request_id, pinned);
      const controller = this.controllers.get(principal.request_id) ?? new AbortController();
      this.controllers.set(principal.request_id, controller);
      const user_gesture_verified = this.verifiedUiContinuations.has(principal.request_id) || (!!principal.user_gesture_token && this.options.gestures.consume(principal.user_gesture_token as object));
      return Object.freeze({ ...pinned, caller: principal.caller, actor_id: principal.actor_id,
        request_id: principal.request_id, invocation_id: principal.request_id, deadline_at: Date.now() + 30_000, user_gesture_verified,
        activation_epoch: installed.activation_epoch, grants: installed.grants,
        host_capabilities: installed.host_capabilities, signal: controller.signal, call_stack: Object.freeze([`${plugin_id}:${action_id}`]) });
    },
    issueChild: async (parent, caller_plugin_id, target_plugin_id, action_id, staging_snapshot) => {
      await this.assertInvocationCurrent(parent);
      const installed = await this.options.manager.verifiedActionSet(target_plugin_id);
      if (!installed?.activation_epoch) throw Object.assign(new Error("Dependency is unavailable or disabled"), { code: "dependency_unavailable" });
      const saved = this.findLease(parent.scope, parent.snapshot);
      return Object.freeze({ ...saved,
        caller: "plugin", caller_plugin_id, actor_id: parent.actor_id, request_id: this.nextRequestId(),
        invocation_id: parent.invocation_id ?? parent.request_id, ...(staging_snapshot ? { staging_snapshot } : {}),
        deadline_at: parent.deadline_at, user_gesture_verified: false, activation_epoch: installed.activation_epoch,
        grants: installed.grants, host_capabilities: installed.host_capabilities, signal: parent.signal,
        call_stack: Object.freeze([...parent.call_stack, `${target_plugin_id}:${action_id}`]) });
    },
    assertCurrent: context => this.assertInvocationCurrent(context),
    isSnapshotCurrent: context => this.isSnapshotCurrent(context),
  };

  private async releaseRequest(requestId: string): Promise<void> {
    const context = this.requestLeases.get(requestId);
    this.controllers.get(requestId)?.abort();
    this.controllers.delete(requestId);
    const listener = this.abortListeners.get(requestId);
    if (listener) listener.signal.removeEventListener("abort", listener.listener);
    this.abortListeners.delete(requestId);
    this.requestLeases.delete(requestId);
    if (context && context !== this.retainedActionSnapshot && ![...this.requestLeases.values()].includes(context)) await this.release(context);
  }
  private requireBackend<K extends keyof AuthoringServiceBackends>(operation: string,
    handler: AuthoringServiceBackends[K]): (...args: unknown[]) => Promise<unknown> {
    if (typeof handler !== "function") throw missing(operation);
    return handler as (...args: unknown[]) => Promise<unknown>;
  }

  private async snapshotStat(context: AuthoringSnapshotContext, path: string) {
    const page = await context.reader.list(context.lease, { prefix: path, limit: 2 });
    return page.items.find(item => item.path === path) ?? null;
  }

  private requireWriter(): ChangeWriter {
    if (!this.options.writer) throw missing("workspace.change.review");
    return this.options.writer;
  }
}

/**
 * Production Host composition. Every persistence boundary is the browser's durable
 * implementation; the only mutation path is ChangeWriter -> BrowserLocalGit.
 */
export function createBrowserAuthoringService(options: CreateBrowserAuthoringServiceOptions): BrowserAuthoringService {
  if (!options.manager || !options.git || !options.workspace || !options.generation ||
      typeof options.getEditorState !== "function" || typeof options.onNavigate !== "function" ||
      typeof options.onMutationBusy !== "function") throw invalid("Browser authoring Host dependencies are incomplete");

  const brokerStore = new IndexedDbBrokerStore();
  const hostIdentity = new IndexedDbHostIdentityStore();
  const freshGestures = new FreshGestureAuthority();
  const claimedEvents = new WeakSet<Event>();
  const claimTrustedEvent = (event: Event): void => {
    if (!event?.isTrusted || claimedEvents.has(event)) throw deniedGesture();
    claimedEvents.add(event);
  };
  const gestures: AuthoringGesturePort = {
    issue: event => freshGestures.issue(event),
    consume: token => freshGestures.consume(token),
  };
  const workspaceSelection = (): AuthoringWorkspaceSelection => ({ git: options.git, identity: options.workspace, generation: options.generation });
  const scopeFor = (selection = workspaceSelection()): Scope => ({
    workspace_id: selection.identity.localWorkspaceId,
    repository_id: selection.identity.provider === "local" ? null : selection.identity.repositoryId,
    branch: selection.identity.branch,
    generation: selection.generation,
  });
  let remoteHead: string | null = null;
  const readRemote = options.getRemoteConfirmed ?? ((paths: readonly string[]) => options.git.readConfirmedRemoteFiles(paths));
  const writerWorkspace = new BrowserGitWriterWorkspace(options.git, options.workspace, {
    selected_scope: () => scopeFor(),
    remote_commit: () => remoteHead,
    is_editor_dirty: () => options.getEditorState().dirty,
    assert_foreign_read: options.assertForeignRead,
    with_editor_write_guard: async <T>(scope: Scope, operation: () => Promise<T>, recovery: boolean): Promise<T> => {
      if (JSON.stringify(scopeFor()) !== JSON.stringify(scope)) throw staleScope();
      if (!recovery && options.getEditorState().dirty) throw Object.assign(new Error("Save or keep the current draft before applying a proposal"), { code: "dirty_draft" });
      options.onMutationBusy(true);
      try {
        if (JSON.stringify(scopeFor()) !== JSON.stringify(scope)) throw staleScope();
        return await operation();
      } finally { options.onMutationBusy(false); }
    },
  });

  const artifacts = new ArtifactBroker(brokerStore);
  const cache = new DerivedCacheBroker(brokerStore);
  const preferences = new PluginPreferencesBroker(brokerStore, freshGestures,
    (pluginId, key, schemaVersion, value) => options.validatePreference?.(pluginId, key, schemaVersion, value) ?? false);
  const basePort = {
    assert_snapshot: (scope: Scope, snapshot: WriterSnapshot) => writerWorkspace.assert_snapshot(scope, snapshot),
    assert_read_set: (scope: Scope, snapshot: WriterSnapshot, readSet: WriterChangeSet["read_set"]) => writerWorkspace.assert_read_set(scope, snapshot, readSet),
    read: (scope: Scope, snapshot: WriterSnapshot, path: string) => writerWorkspace.read(scope, snapshot, path),
    stat: async (scope: Scope, snapshot: WriterSnapshot, path: string) => {
      await writerWorkspace.assert_snapshot(scope, snapshot);
      return options.git.statAuthoringSnapshot(snapshot.id, path);
    },
    list: async (scope: Scope, snapshot: WriterSnapshot, prefix: string, cursor: string | null, limit: number) => {
      await writerWorkspace.assert_snapshot(scope, snapshot);
      return options.git.listAuthoringSnapshot(snapshot.id, prefix, cursor, limit);
    },
  };
  const stages = new ChangeStageStore(basePort);

  const artifactReader = async (scope: Scope, snapshot: Snapshot, artifactId: string, producerPluginId: string): Promise<Uint8Array> => {
    const metadata = await artifacts.hostMetadata(producerPluginId, artifactId, scope, snapshot);
    if (metadata.total_bytes > 64 * 1024 * 1024) throw Object.assign(new Error("Artifact exceeds the proposal content limit"), { code: "capacity" });
    const bytes = new Uint8Array(metadata.total_bytes);
    for (let offset = 0; offset < metadata.total_bytes;) {
      const chunk = await artifacts.readSealedChunk(producerPluginId, artifactId, offset, Math.min(256 * 1024, metadata.total_bytes - offset));
      if (chunk.total_bytes !== metadata.total_bytes || chunk.sha256 !== metadata.sha256 || !chunk.bytes.byteLength) {
        throw Object.assign(new Error("Sealed artifact changed during proposal admission"), { code: "storage_unknown" });
      }
      bytes.set(chunk.bytes, offset); offset += chunk.bytes.byteLength;
    }
    if (await sha256Bytes(bytes) !== metadata.sha256) throw Object.assign(new Error("Sealed artifact digest changed during proposal admission"), { code: "storage_unknown" });
    return bytes;
  };
  const writer = new ChangeWriter({
    journal: new IndexedDbWriterJournalStore(), workspace: writerWorkspace, resolve_artifact: artifactReader,
    new_proposal_id: ID,
  });

  const assetReaders = new Map<string, { readonly key: string; readonly read: ResolvedAssetGroup["readObject"] }>();
  const assetSource: AssetArtifactSource = {
    readObject: async (path, maxBytes, signal) => {
      const known = assetReaders.get(path);
      if (known) return known.read(path, maxBytes, signal);
      const installed = await options.manager.installed();
      let match: ResolvedAssetGroup | undefined;
      for (const item of installed) {
        const groups = item.manifest?.schema === "proprium.plugin/v2" ? item.manifest.asset_groups : [];
        for (const group of groups) {
          if (group.manifest_path !== path) continue;
          const resolved = await options.manager.resolveAssetGroup(item.id, group.id);
          if (!resolved) continue;
          if (match && (match.ref.sha256 !== resolved.ref.sha256 || match.ref.bytes !== resolved.ref.bytes)) {
            throw Object.assign(new Error("Asset manifest path is ambiguous across admitted registries"), { code: "provider_unavailable" });
          }
          match = resolved;
        }
      }
      if (!match) throw Object.assign(new Error("Asset object is outside currently admitted manifest paths"), { code: "provider_unavailable" });
      const bytes = await match.readObject(path, maxBytes, signal);
      assetReaders.set(path, { key: `${match.plugin_id}\u0000${match.ref.id}`, read: match.readObject });
      try {
        const manifest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as { files?: Array<{ chunks?: Array<{ path?: unknown }> }> };
        for (const file of Array.isArray(manifest.files) ? manifest.files : []) {
          for (const chunk of Array.isArray(file?.chunks) ? file.chunks : []) {
            if (typeof chunk?.path !== "string" || !safeAssetPath(chunk.path)) continue;
            const prior = assetReaders.get(chunk.path);
            const key = `${match.plugin_id}\u0000${match.ref.id}`;
            if (prior && prior.key !== key) assetReaders.delete(chunk.path);
            else assetReaders.set(chunk.path, { key, read: match.readObject });
          }
        }
      } catch { /* The broker validates UTF-8 and the signed manifest digest before parsing it. */ }
      return bytes;
    },
  };
  const assetBroker = new AssetGroupBroker({
    resolver: { resolve: async (pluginId, groupId) => (await options.manager.resolveAssetGroup(pluginId, groupId))?.ref },
    source: assetSource,
    store: new IndexedDbAssetGroupStore(),
    capacity: { measure: input => options.measureAssetCapacity?.(input) ?? Promise.resolve({
      device_supported: false, available_storage_bytes: null, device_requirements: [], memory_required_bytes: null,
      reason: "Host device capacity policy is not configured",
    }) },
    gestures: freshGestures,
  });

  const backends: AuthoringServiceBackends = {
    identityRead: async (context, paths) => {
      const remote = await readRemote(paths);
      remoteHead = remote.remote_commit;
      return { scope: context.scope, snapshot: context.snapshot, device_id: await hostIdentity.deviceId(), legacy_project_ids: [],
        publication: { remote_commit: remote.remote_commit, files: remote.files } };
    },
    repositorySnapshotRead: options.resolveRepositorySnapshot,
    propose: async (request, rawSet, context) => {
      if (!request.idempotency_key || !isRecord(rawSet)) throw invalid("Proposals require a Host-bound ChangeSet and idempotency key");
      const sourceBytes = new TextEncoder().encode(canonicalJson(request.input));
      const sourceDigest = await sha256Bytes(sourceBytes);
      const set = writerChangeSet(rawSet, request, request.input, sourceDigest);
      const requestDigest = await digest(request.input, request.scope, request.snapshot);
      const hostCaller: Omit<WriterCaller, "submitted_at"> = {
        caller: context.caller, producer_plugin_id: request.plugin_id, action_id: request.action_id,
        scope: request.scope, idempotency_key: request.idempotency_key,
        source_payload: sourceBytes, request_digest: requestDigest,
      };
      const admission = await writer.propose(set, hostCaller, set.read_set);
      for (const artifactId of contentArtifactIds(set)) {
        await artifacts.retainForProposal(request.plugin_id, artifactId, admission.proposal_id);
      }
      return admission;
    },
    stage: async (request, payload, context) => {
      if (!isRecord(payload.base_snapshot) || !Array.isArray(payload.units)) throw invalid("Staging request is malformed");
      const result = await stages.stage({ scope: request.scope, caller_chain: context.call_stack,
        invocation_id: context.invocation_id }, {
        base_snapshot: payload.base_snapshot as unknown as WriterSnapshot,
        ...(typeof payload.previous_stage === "string" ? { previous_stage: payload.previous_stage } : {}),
        units: payload.units.map(decodeWriterUnit),
      });
      return result;
    },
    cacheGet: async (pluginId, payload) => cache.get(pluginId, payload.key as CacheKey),
    cachePut: async (pluginId, payload) => cache.put(pluginId, payload.key as CacheKey, payload.value),
    cacheEvict: async (pluginId, payload) => cache.evict(pluginId, payload.key as CacheKey | undefined),
    preferenceRead: async (pluginId, payload) => preferences.read(pluginId,
      requiredString(payload.user_partition, "user_partition"), requiredString(payload.key, "key"),
      requiredInteger(payload.schema_version, "schema_version")),
    artifactCreate: async (pluginId, request, payload) => artifacts.create(pluginId, {
      media_type: requiredString(payload.media_type, "media_type"), filename: requiredString(payload.filename, "filename"),
      scope: request.scope, snapshot: request.snapshot,
    }),
    artifactAppend: async (pluginId, payload) => artifacts.append(pluginId, requiredString(payload.artifact_id, "artifact_id"),
      requiredInteger(payload.sequence, "sequence"), payload.bytes as number[]),
    artifactSeal: async (pluginId, payload) => artifacts.seal(pluginId, requiredString(payload.artifact_id, "artifact_id"),
      requiredString(payload.sha256, "sha256"), requiredInteger(payload.total_bytes, "total_bytes")),
    artifactDiscard: async (pluginId, payload) => artifacts.discard(pluginId, requiredString(payload.artifact_id, "artifact_id")),
    proposalRead: async (operation, request, payload) => {
      const scope = request.scope;
      switch (operation) {
        case "workspace.change.list": return writer.list(scope, optionalString(payload.cursor), optionalNumber(payload.limit) ?? 50, optionalString(payload.status) as ProposalState | undefined);
        case "workspace.change.status": return writer.status(scope, requiredString(payload.proposal_id, "proposal_id"));
        case "workspace.change.observations": return writer.observations(scope, requiredString(payload.proposal_id, "proposal_id"), optionalString(payload.cursor), optionalNumber(payload.limit) ?? 50);
        case "workspace.change.inspect": {
          const inspected = await writer.inspect(scope, requiredString(payload.proposal_id, "proposal_id"), optionalString(payload.cursor), optionalNumber(payload.limit) ?? 20, payload.include_source === true);
          return { ...inspected, ...(inspected.source_payload ? { source_payload: [...inspected.source_payload] } : {}) };
        }
        case "workspace.change.content.read": {
          const chunk = await writer.read_content(scope, requiredString(payload.proposal_id, "proposal_id"), requiredString(payload.ref, "ref"), optionalNumber(payload.offset) ?? 0, optionalNumber(payload.length) ?? 65_536);
          return { ...chunk, bytes: [...chunk.bytes] };
        }
        default: throw missing(operation);
      }
    },
    capabilitiesQuery: options.queryCapabilities,
    changeTimestamp: request => {
      if (!request.idempotency_key) throw invalid("Stable idempotency key is required for a timestamp");
      return writer.timestamp(request.scope, request.plugin_id, request.action_id, request.idempotency_key);
    },
    assetRead: (pluginId, caller, scope, payload) => assetBroker.read(pluginId, caller, scope, payload),
    readOverlay: async (scope, base, token, callerChain, invocationId) => {
      const overlay = stages.readOverlay(scope, base as WriterSnapshot, token, callerChain, invocationId);
      const snapshot = Object.freeze({ ...base, id: token });
      const port = new StageSnapshotPort(stages, scope, base as WriterSnapshot, token, callerChain, invocationId, overlay.reader);
      const reader = new AuthoringSnapshotReader(port);
      const lease: SnapshotLease = Object.freeze({ scope: Object.freeze({ ...scope }), snapshot,
        host_token: Object.freeze({ stage: token, invocation_id: invocationId }) });
      return Object.freeze({ scope, snapshot, lease, reader });
    },
    releaseInvocation: context => { stages.releaseInvocation(context); },
    navigate: options.onNavigate,
  };

  const artifactHandle = async (pluginId: string, artifactId: string, scope: Scope, snapshot: Snapshot): Promise<AuthoringHostArtifact | undefined> => {
    const metadata = await artifacts.hostMetadata(pluginId, artifactId, scope, snapshot);
    const readChunk = async (offset: number, length = 256 * 1024) => {
      const current = await artifacts.hostMetadata(pluginId, artifactId, scope, snapshot);
      if (!sameJson(current, metadata)) throw Object.assign(new Error("Host artifact changed after result admission"), { code: "storage_unknown" });
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0 || length > 256 * 1024) throw invalid("Artifact read range is invalid");
      const chunk = await artifacts.readSealedChunk(pluginId, artifactId, offset, length);
      return { offset, total_bytes: chunk.total_bytes, bytes: chunk.bytes, sha256: chunk.sha256, next_offset: chunk.next_offset };
    };
    const previewText = async (maxBytes = 1024 * 1024) => {
      if (!metadata.media_type.startsWith("text/") && metadata.media_type !== "application/json" && metadata.media_type.endsWith("+json") === false) {
        throw Object.assign(new Error("Only text artifacts can be previewed as text"), { code: "invalid_input" });
      }
      if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > 2 * 1024 * 1024) throw invalid("Artifact preview bound is invalid");
      const amount = Math.min(metadata.total_bytes, maxBytes);
      const bytes = new Uint8Array(amount);
      for (let offset = 0; offset < amount;) {
        const item = await readChunk(offset, Math.min(256 * 1024, amount - offset));
        if (!item.bytes.byteLength) break;
        bytes.set(item.bytes, offset); offset += item.bytes.byteLength;
      }
      let text: string;
      try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
      catch { throw Object.assign(new Error("Artifact preview is not valid UTF-8 text"), { code: "invalid_encoding" }); }
      return { text, truncated: amount < metadata.total_bytes };
    };
    const readAll = async (event: Event, maxBytes = 128 * 1024 * 1024) => {
      claimTrustedEvent(event);
      const token = freshGestures.issue(event);
      if (!freshGestures.consume(token)) throw deniedGesture();
      if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > 128 * 1024 * 1024 || metadata.total_bytes > maxBytes) throw Object.assign(new Error("Artifact exceeds the Host read bound"), { code: "capacity" });
      const bytes = new Uint8Array(metadata.total_bytes);
      for (let offset = 0; offset < metadata.total_bytes;) {
        const chunk = await readChunk(offset, Math.min(256 * 1024, metadata.total_bytes - offset));
        if (!chunk.bytes.byteLength || chunk.offset !== offset || chunk.total_bytes !== metadata.total_bytes || chunk.sha256 !== metadata.sha256) throw Object.assign(new Error("Artifact bytes changed during Host read"), { code: "storage_unknown" });
        bytes.set(chunk.bytes, offset); offset += chunk.bytes.byteLength;
      }
      if (await sha256Bytes(bytes) !== metadata.sha256) throw Object.assign(new Error("Artifact digest changed during Host read"), { code: "storage_unknown" });
      return new Blob([bytes.buffer as ArrayBuffer], { type: metadata.media_type });
    };
    return Object.freeze({ metadata, readChunk, previewText, readAll });
  };

  const service = new BrowserAuthoringService({
    selectWorkspace: workspaceSelection, editorState: options.getEditorState, manager: options.manager,
    idempotency: new IndexedDbActionIdempotencyStore(), gestures,
    getRemoteConfirmed: async paths => {
      const remote = await readRemote(paths); remoteHead = remote.remote_commit; return remote;
    },
    gestureClaimsEvent: claimTrustedEvent,
    createRequestId: options.createRequestId, actorId: options.actorId,
    writer, artifactHandle,
    assetInspector: async (pluginId, groupId, signal) => assetBroker.inspect(pluginId, groupId, scopeFor(), signal),
    assetAdmitter: async (gesture, pluginId, groupId, consent, signal, onProgress) => assetBroker.admit(pluginId, groupId, {
      scope: scopeFor(), manifest_sha256: consent.manifest_sha256, capacity_consent: consent,
      gesture, signal, on_progress: onProgress,
    }),
    backends,
    disposeBackends: async () => {
      for (const plugin of await options.manager.installed()) await artifacts.releaseTemporary(plugin.id).catch(() => undefined);
    },
  });
  return service;
}

/** IndexedDB-backed action envelope idempotency; a lost completion remains pending, never replayed. */
export class IndexedDbActionIdempotencyStore implements ActionIdempotencyStore {
  private database?: Promise<IDBDatabase>;
  constructor(private readonly databaseName = "proprium-authoring-action-idempotency-v1") {}
  private open(): Promise<IDBDatabase> {
    if (this.database) return this.database;
    this.database = new Promise((resolve, reject) => {
      if (typeof indexedDB === "undefined") { reject(storageUnknown("IndexedDB is unavailable for action idempotency")); return; }
      const request = indexedDB.open(this.databaseName, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains("requests")) request.result.createObjectStore("requests", { keyPath: "key" });
      };
      request.onsuccess = () => { request.result.onversionchange = () => request.result.close(); resolve(request.result); };
      request.onerror = () => reject(storageUnknown("Action idempotency storage could not be opened"));
      request.onblocked = () => reject(storageUnknown("Action idempotency storage upgrade is blocked"));
    });
    return this.database;
  }
  async claim(key: IdempotencyKey, digestValue: string): Promise<IdempotencyClaim> {
    const db = await this.open(); let transaction: IDBTransaction;
    try { transaction = db.transaction("requests", "readwrite", { durability: "strict" }); }
    catch { throw storageUnknown("Browser cannot provide durable action idempotency writes"); }
    const store = transaction.objectStore("requests"); const id = idempotencyStorageKey(key);
    const req = store.get(id) as IDBRequest<StoredIdempotency | undefined>;
    return new Promise((resolve, reject) => {
      let claim: IdempotencyClaim = { kind: "pending" };
      req.onsuccess = () => {
        const prior = req.result;
        if (prior && prior.digest !== digestValue) claim = { kind: "conflict" };
        else if (prior?.status === "complete" && prior.result) claim = { kind: "completed", result: prior.result };
        else if (prior) claim = { kind: "pending" };
        else { claim = { kind: "owner" }; store.put({ key: id, digest: digestValue, status: "pending" } satisfies StoredIdempotency); }
      };
      req.onerror = () => reject(storageUnknown("Action idempotency record could not be read"));
      transaction.oncomplete = () => resolve(claim);
      transaction.onerror = () => reject(storageUnknown("Action idempotency transaction failed"));
      transaction.onabort = () => reject(storageUnknown("Action idempotency transaction was interrupted"));
    });
  }
  async complete(key: IdempotencyKey, digestValue: string, result: ActionResult): Promise<void> {
    await this.update(key, prior => {
      if (!prior || prior.digest !== digestValue || prior.status !== "pending") throw storageUnknown("Action idempotency completion has no matching pending claim");
      return { ...prior, status: "complete", result: structuredClone(result) };
    });
  }
  async failBeforeEffects(key: IdempotencyKey, digestValue: string, _error: import("./types.js").ActionError): Promise<void> {
    await this.update(key, prior => {
      if (!prior || prior.digest !== digestValue || prior.status !== "pending") throw storageUnknown("Action idempotency failure has no matching pending claim");
      return null;
    });
  }
  private async update(key: IdempotencyKey, update: (prior: StoredIdempotency | undefined) => StoredIdempotency | null): Promise<void> {
    const db = await this.open(); let transaction: IDBTransaction;
    try { transaction = db.transaction("requests", "readwrite", { durability: "strict" }); }
    catch { throw storageUnknown("Browser cannot provide durable action idempotency writes"); }
    const store = transaction.objectStore("requests"); const id = idempotencyStorageKey(key);
    const req = store.get(id) as IDBRequest<StoredIdempotency | undefined>;
    return new Promise((resolve, reject) => {
      req.onsuccess = () => {
        try { const next = update(req.result); if (next) store.put(next); else store.delete(id); }
        catch (error) { try { transaction.abort(); } catch { /* already complete */ } reject(error); }
      };
      req.onerror = () => reject(storageUnknown("Action idempotency record could not be read"));
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(storageUnknown("Action idempotency transaction failed"));
      transaction.onabort = () => reject(storageUnknown("Action idempotency transaction was interrupted"));
    });
  }
}

interface StoredIdempotency { key: string; digest: string; status: "pending" | "complete"; result?: ActionResult }

class StageSnapshotPort implements SnapshotPort {
  constructor(private readonly store: ChangeStageStore, private readonly scope: Scope, private readonly base: WriterSnapshot,
    private readonly token: string, private readonly chain: readonly string[], private readonly invocationId: string,
    private readonly overlay: ReturnType<ChangeStageStore["readOverlay"]>["reader"]) {}
  async pin(): Promise<SnapshotLease> { throw Object.assign(new Error("Stage snapshots are only issued from an existing Host overlay"), { code: "capability_denied" }); }
  async assert_current(lease: SnapshotLease): Promise<void> {
    this.assertLease(lease);
    this.store.assertStage(this.token, this.scope, this.base, this.chain, this.invocationId);
  }
  async list(lease: SnapshotLease, query: { prefix: string; cursor: string | null; limit: number }): Promise<SnapshotPage> {
    await this.assert_current(lease);
    const page = await this.overlay.list(query);
    return { items: page.items.map(file => ({ path: file.path, revision: file.revision, byte_length: file.byte_length, media_type: file.media_type })), next_cursor: page.next_cursor };
  }
  async stat(lease: SnapshotLease, path: string): Promise<SnapshotFile | null> {
    await this.assert_current(lease);
    const file = await this.overlay.stat(path);
    return file ? { path: file.path, revision: file.revision, byte_length: file.byte_length, media_type: file.media_type } : null;
  }
  async read_range(lease: SnapshotLease, path: string, offset: number, length: number): Promise<SnapshotRange> {
    await this.assert_current(lease);
    const result = await this.overlay.read(path, { offset, length });
    if (!result.bytes || result.revision === null) throw Object.assign(new Error("File is absent from the staged view"), { code: "file_not_found" });
    return { bytes: result.bytes, total_bytes: result.total_bytes, offset: result.offset, revision: result.revision };
  }
  async release(lease: SnapshotLease): Promise<void> { this.assertLease(lease); }
  private assertLease(lease: SnapshotLease): void {
    if (!lease || lease.host_token === undefined || !sameScope(lease.scope, this.scope) || lease.snapshot.id !== this.token ||
        !sameBaseSnapshot(lease.snapshot, this.base)) throw Object.assign(new Error("Staging snapshot lease is stale"), { code: "snapshot_stale" });
  }
}

class IndexedDbHostIdentityStore {
  private database?: Promise<IDBDatabase>;
  constructor(private readonly name = "proprium-host-device-identity-v1") {}
  async deviceId(): Promise<string> {
    const db = await this.open(); const tx = db.transaction("identity", "readwrite", { durability: "strict" });
    const store = tx.objectStore("identity"); const req = store.get("device_id") as IDBRequest<{ key: string; value: string } | undefined>;
    return new Promise((resolve, reject) => {
      let value: string | undefined;
      req.onsuccess = () => {
        value = req.result?.value;
        if (!value) { value = ID(); store.put({ key: "device_id", value }); }
      };
      req.onerror = () => reject(storageUnknown("Host device identity could not be read"));
      tx.oncomplete = () => resolve(value!);
      tx.onerror = () => reject(storageUnknown("Host device identity transaction failed"));
      tx.onabort = () => reject(storageUnknown("Host device identity transaction was interrupted"));
    });
  }
  private open(): Promise<IDBDatabase> {
    if (this.database) return this.database;
    this.database = new Promise((resolve, reject) => {
      if (typeof indexedDB === "undefined") { reject(storageUnknown("IndexedDB is unavailable for Host device identity")); return; }
      const request = indexedDB.open(this.name, 1);
      request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains("identity")) request.result.createObjectStore("identity", { keyPath: "key" }); };
      request.onsuccess = () => { request.result.onversionchange = () => request.result.close(); resolve(request.result); };
      request.onerror = () => reject(storageUnknown("Host device identity storage could not be opened"));
      request.onblocked = () => reject(storageUnknown("Host device identity storage upgrade is blocked"));
    });
    return this.database;
  }
}

function snapshotKey(scope: Scope, snapshot: Snapshot): string { return `${JSON.stringify(scope)}\u0000${snapshot.id}`; }
function sameScope(a: Scope, b: Scope): boolean { return canonicalJson(a) === canonicalJson(b); }
function exactSnapshot(payload: Record<string, unknown>, expected: Snapshot): void {
  if (!payload.snapshot || JSON.stringify(payload.snapshot) !== JSON.stringify(expected)) throw Object.assign(new Error("File read requested a different snapshot"), { code: "snapshot_stale" });
}
function optionalString(value: unknown): string | undefined { return typeof value === "string" ? value : undefined; }
function optionalNumber(value: unknown): number | undefined { return Number.isSafeInteger(value) ? value as number : undefined; }
function requiredInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw invalid(`${name} must be a non-negative safe integer`);
  return value as number;
}
function requiredString(value: unknown, name: string): string { if (typeof value !== "string") throw invalid(`${name} is required`); return value; }
function invalid(message: string): Error { return Object.assign(new Error(message), { code: "invalid_input" }); }
function missing(operation: string): Error { return Object.assign(new Error(`Host capability ${operation} is unavailable`), { code: "missing_capability" }); }
function staleScope(): Error { return Object.assign(new Error("Workspace selection changed"), { code: "snapshot_stale" }); }
function deniedGesture(): Error { return Object.assign(new Error("A fresh trusted Host user gesture is required"), { code: "capability_denied" }); }
function storageUnknown(message: string): Error { return Object.assign(new Error(message), { code: "storage_unknown" }); }
function isRecord(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function isScope(value: unknown): value is Scope {
  if (!isRecord(value)) return false;
  return typeof value.workspace_id === "string" &&
    (value.repository_id === null || Number.isSafeInteger(value.repository_id)) &&
    typeof value.branch === "string" && typeof value.generation === "string";
}
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
}
function sameJson(left: unknown, right: unknown): boolean { return canonicalJson(left) === canonicalJson(right); }
function sameSnapshotSelector(payload: Record<string, unknown>, context: AuthoringSnapshotContext): boolean {
  return payload.workspace_id === context.scope.workspace_id && payload.repository_id === context.scope.repository_id &&
    payload.branch === context.scope.branch && payload.snapshot_id === context.snapshot.id;
}
function sameBaseSnapshot(candidate: unknown, base: Snapshot): boolean {
  if (!isRecord(candidate) || typeof candidate.id !== "string") return false;
  return sameJson({ ...candidate, id: base.id }, base);
}
function safeAssetPath(path: string): boolean {
  return path.length > 0 && path.length <= 256 && /^[A-Za-z0-9._/-]+$/u.test(path) &&
    !path.startsWith("/") && path.split("/").every(part => part.length > 0 && part !== "." && part !== "..");
}
function writerChangeSet(raw: Record<string, unknown>, request: ActionRequest, sourcePayload: unknown,
  sourcePayloadDigest: string): WriterChangeSet {
  const allowed = ["id", "idempotency_key", "scope", "snapshot", "title", "reason", "read_set", "units", "evidence", "source_payload", "source_payload_digest", "domain_evidence"];
  if (Object.keys(raw).some(key => !allowed.includes(key)) || !Array.isArray(raw.read_set) || !Array.isArray(raw.units) || !Array.isArray(raw.evidence)) {
    throw invalid("ChangeSet shape is invalid");
  }
  const units = raw.units.map(decodeWriterUnit);
  return {
    id: typeof raw.id === "string" ? raw.id : "host-pending",
    idempotency_key: request.idempotency_key ?? (typeof raw.idempotency_key === "string" ? raw.idempotency_key : ""),
    scope: request.scope, snapshot: request.snapshot,
    title: requiredString(raw.title, "changeset.title"), reason: requiredString(raw.reason, "changeset.reason"),
    read_set: raw.read_set as WriterChangeSet["read_set"], units,
    evidence: raw.evidence as WriterChangeSet["evidence"],
    source_payload: structuredClone(sourcePayload), source_payload_digest: sourcePayloadDigest,
    ...(Array.isArray(raw.domain_evidence) ? { domain_evidence: raw.domain_evidence } : {}),
  };
}
function decodeWriterUnit(value: unknown): WriterUnit {
  if (!isRecord(value) || !Array.isArray(value.operations) || !Array.isArray(value.depends_on)) throw invalid("ChangeSet unit is malformed");
  const operations = value.operations.map(operation => {
    if (!isRecord(operation)) throw invalid("ChangeSet operation is malformed");
    const result = { ...operation };
    if (Array.isArray(result.content)) {
      if (result.content.some(byte => !Number.isInteger(byte) || (byte as number) < 0 || (byte as number) > 255)) throw invalid("ChangeSet content bytes are malformed");
      result.content = Uint8Array.from(result.content as number[]);
    }
    return result;
  });
  return { ...value, operations, depends_on: value.depends_on as string[] } as unknown as WriterUnit;
}
function contentArtifactIds(set: WriterChangeSet): string[] {
  const ids = new Set<string>();
  for (const unit of set.units) for (const operation of unit.operations) if (operation.content_artifact) ids.add(operation.content_artifact);
  return [...ids];
}
function idempotencyStorageKey(key: IdempotencyKey): string {
  return JSON.stringify([key.workspace_id, key.plugin_id, key.action_id, key.key]);
}
async function sha256Bytes(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes)));
  return Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("");
}
async function digest(input: unknown, scope: Scope, snapshot: Snapshot): Promise<string> {
  return sha256Bytes(new TextEncoder().encode(canonicalJson({ scope, snapshot, input })));
}
