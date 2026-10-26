import type { ActionDescriptor, ActionError, ActionRequest, ActionResult, Caller, JsonSchema, Scope, Snapshot } from "./types.js";
import { assertActionRequest, assertDescriptor, assertResult, assertValue } from "./schema.js";

export type ActionAvailability = "ready" | "disabled" | "dependency_unavailable" | "capability_denied" | "incompatible";
export interface VerifiedActionSet {
  plugin_id: string; version: string; manifest_digest: string; enabled: boolean; activation_epoch: number;
  descriptors: readonly ActionDescriptor[]; dependencies: readonly string[]; grants: readonly string[]; host_capabilities: readonly string[];
}
/** Construct this only in trusted Host UI or authenticated Gateway code. */
export interface TrustedActionPrincipal {
  caller: "ui" | "mcp"; actor_id: string; selected_scope?: Scope; repository_id?: number; branch?: string;
  request_id: string; user_gesture_token?: unknown;
}
export interface InvocationContext {
  caller: Caller; caller_plugin_id?: string; actor_id: string; scope: Scope; snapshot: Snapshot;
  staging_snapshot?: string; request_id: string; deadline_at: number; user_gesture_verified: boolean;
  activation_epoch: number; grants: readonly string[]; host_capabilities: readonly string[];
  signal: AbortSignal; call_stack: readonly string[];
}
export interface InvocationAuthority {
  issue(principal: TrustedActionPrincipal, plugin_id: string, action_id: string): Promise<InvocationContext>;
  issueChild(parent: InvocationContext, caller_plugin_id: string, target_plugin_id: string, action_id: string,
    staging_snapshot?: string): Promise<InvocationContext>;
  assertCurrent(context: InvocationContext): Promise<void>;
}
export interface RuntimeHostCall { call_id: string; operation: string; payload: Record<string, unknown> }
export interface RuntimeInvokeOptions {
  request: ActionRequest; caller: Caller; user_gesture?: boolean; activation_epoch: number; deadline_at: number;
  granted_capabilities: readonly string[]; validate_schema: (schema: JsonSchema, value: unknown, phase?: string) => void;
  is_snapshot_current: () => Promise<void>; resolve_host_call: (call: RuntimeHostCall) => Promise<unknown>;
}
export interface ActionRuntime { invoke(options: RuntimeInvokeOptions): Promise<ActionResult> }
export interface HostOperationContext extends InvocationContext { plugin_id: string; descriptor: ActionDescriptor; request: ActionRequest }
export interface HostCapabilityPorts {
  identityRead?(payload: Record<string, unknown>, context: HostOperationContext): Promise<unknown>;
  fileList?(payload: Record<string, unknown>, context: HostOperationContext): Promise<unknown>;
  fileRead?(payload: Record<string, unknown>, context: HostOperationContext): Promise<unknown>;
  validateStage?(snapshot_id: string, context: HostOperationContext): Promise<void>;
  navigate?(payload: Record<string, unknown>, context: HostOperationContext): Promise<unknown>;
  propose?(payload: Record<string, unknown>, context: HostOperationContext): Promise<unknown>;
  stage?(payload: Record<string, unknown>, context: HostOperationContext): Promise<unknown>;
  timestamp?(payload: Record<string, unknown>, context: HostOperationContext): Promise<unknown>;
  assetRead?(payload: Record<string, unknown>, context: HostOperationContext): Promise<unknown>;
  cacheGet?(payload: Record<string, unknown>, context: HostOperationContext): Promise<unknown>;
  cachePut?(payload: Record<string, unknown>, context: HostOperationContext): Promise<unknown>;
  cacheEvict?(payload: Record<string, unknown>, context: HostOperationContext): Promise<unknown>;
  preferencesRead?(payload: Record<string, unknown>, context: HostOperationContext): Promise<unknown>;
  artifactCreate?(payload: Record<string, unknown>, context: HostOperationContext): Promise<unknown>;
  artifactAppend?(payload: Record<string, unknown>, context: HostOperationContext): Promise<unknown>;
  artifactSeal?(payload: Record<string, unknown>, context: HostOperationContext): Promise<unknown>;
  artifactDiscard?(payload: Record<string, unknown>, context: HostOperationContext): Promise<unknown>;
  proposalList?(payload: Record<string, unknown>, context: HostOperationContext): Promise<unknown>;
  proposalStatus?(payload: Record<string, unknown>, context: HostOperationContext): Promise<unknown>;
  proposalObservations?(payload: Record<string, unknown>, context: HostOperationContext): Promise<unknown>;
  proposalInspect?(payload: Record<string, unknown>, context: HostOperationContext): Promise<unknown>;
  proposalContentRead?(payload: Record<string, unknown>, context: HostOperationContext): Promise<unknown>;
  capabilitiesQuery?(payload: Record<string, unknown>, context: HostOperationContext): Promise<unknown>;
}
export interface ActionSchemaValidator {
  assertDescriptor(value: unknown): asserts value is ActionDescriptor; assertRequest(value: unknown): asserts value is ActionRequest;
  assertResult(value: unknown): asserts value is ActionResult; assertValue(schema: JsonSchema, value: unknown, phase?: string): void;
}
export interface IdempotencyKey { workspace_id: string; plugin_id: string; action_id: string; key: string }
export type IdempotencyClaim = { kind: "owner" } | { kind: "completed"; result: ActionResult } | { kind: "pending" } | { kind: "conflict" };
export interface ActionIdempotencyStore {
  claim(key: IdempotencyKey, digest: string): Promise<IdempotencyClaim>;
  complete(key: IdempotencyKey, digest: string, result: ActionResult): Promise<void>;
  failBeforeEffects(key: IdempotencyKey, digest: string, error: ActionError): Promise<void>;
}
export interface ActionDispatcherOptions {
  installed(plugin_id: string): Promise<VerifiedActionSet | undefined>; authority: InvocationAuthority; runtime: ActionRuntime;
  capabilities: HostCapabilityPorts; idempotency: ActionIdempotencyStore; schemas?: ActionSchemaValidator;
  randomId?: () => string; now?: () => number;
}
export interface ActionCall { plugin_id: string; action_id: string; input: Record<string, unknown>; idempotency_key?: string }
export interface ActionListRequest { plugin_id: string; cursor?: string; limit?: number }
export interface ActionListItem { descriptor: ActionDescriptor; availability: ActionAvailability; reason?: string }
export interface ActionListResult { items: readonly ActionListItem[]; next_cursor: string | null }

const MAX_JOBS = 4;
const MAX_CURSOR_TOKENS = 4096;
const MAX_DEADLINE_MS = 120_000;
const IDENTIFIER = /^[a-z][a-z0-9-]{0,62}\.[a-z][a-z0-9.-]{0,126}$/u;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const OPERATION_CAPABILITY: Readonly<Record<string, string>> = Object.freeze({
  "workspace.identity.read": "workspace.identity.read", "workspace.file.list": "workspace.file.read",
  "workspace.file.read": "workspace.file.read", "workspace.navigation": "workspace.navigation",
  "workspace.change.propose": "workspace.change.propose", "workspace.change.stage": "workspace.change.stage",
  "workspace.change.timestamp": "workspace.change.timestamp", "workspace.asset.read": "workspace.asset.read",
  "workspace.derived.cache.get": "workspace.derived.cache", "workspace.derived.cache.put": "workspace.derived.cache",
  "workspace.derived.cache.evict": "workspace.derived.cache", "plugin.preferences.read": "plugin.preferences",
  "artifact.create": "artifact.create", "artifact.append": "artifact.append", "artifact.seal": "artifact.seal",
  "artifact.discard": "artifact.discard", "workspace.change.list": "workspace.change.propose",
  "workspace.change.status": "workspace.change.propose", "workspace.change.observations": "workspace.change.propose",
  "workspace.change.inspect": "workspace.change.propose", "workspace.change.content.read": "workspace.change.propose",
  "workspace.capabilities.query": "workspace.capabilities.query", "workspace.plugin.invoke": "workspace.plugin.invoke",
  "actions.list": "workspace.plugin.invoke",
});

export class ActionDispatchError extends Error {
  constructor(readonly code: string, message: string, readonly retryable = false, readonly details?: Record<string, unknown>) {
    super(message); this.name = "ActionDispatchError";
  }
  result(request: ActionRequest): ActionResult {
    return { request_id: request.request_id, scope: request.scope, snapshot: request.snapshot, ok: false,
      error: { code: this.code, message: this.message, retryable: this.retryable, ...(this.details ? { details: this.details } : {}) } };
  }
}
function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  const object = value as Record<string, unknown>;
  return "{" + Object.keys(object).sort().map(key => JSON.stringify(key) + ":" + canonicalJson(object[key])).join(",") + "}";
}
function sameJson(a: unknown, b: unknown): boolean { return canonicalJson(a) === canonicalJson(b); }
async function digest(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(value));
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(hash, value => value.toString(16).padStart(2, "0")).join("");
}
function randomUUID(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), value => value.toString(16).padStart(2, "0")).join("");
}
function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new ActionDispatchError("invalid_input", label + " contains an undeclared field");
}
function requireContext(value: InvocationContext): void {
  if (!value || !["ui", "mcp", "plugin"].includes(value.caller) || !value.actor_id || !value.scope?.workspace_id ||
      !value.scope.generation || !value.snapshot?.id || !TOKEN.test(value.request_id) || !Number.isSafeInteger(value.deadline_at) ||
      value.deadline_at <= 0 || !Number.isSafeInteger(value.activation_epoch) || value.activation_epoch < 1 ||
      !(value.signal instanceof AbortSignal) || !Array.isArray(value.grants) || !Array.isArray(value.host_capabilities)) {
    throw new ActionDispatchError("invalid_input", "Host did not issue a valid action context");
  }
}

/** Typed action entry point shared by the normal Host UI and fixed MCP plugin_call. */
export class AuthoringActionDispatcher {
  private readonly active = new Set<string>();
  private readonly jobs = new Map<string, number>();
  private readonly cursors = new Map<string, { plugin_id: string; offset: number; digest: string; epoch: number; caller: Caller; caller_plugin_id?: string }>();
  private readonly random: () => string;
  private readonly now: () => number;
  private readonly schemas: ActionSchemaValidator;
  constructor(private readonly options: ActionDispatcherOptions) {
    this.random = options.randomId ?? randomUUID; this.now = options.now ?? Date.now;
    this.schemas = options.schemas ?? {
      assertRequest: assertActionRequest, assertDescriptor, assertResult, assertValue,
    };
  }

  /** Metadata reads admitted signed declarations without creating or activating a Worker. */
  async list(request: ActionListRequest, principal: TrustedActionPrincipal): Promise<ActionListResult> {
    this.assertPrincipal(principal);
    if (!isRecord(request) || !IDENTIFIER.test(request.plugin_id)) throw new ActionDispatchError("invalid_input", "Plugin ID is malformed");
    exactKeys(request, ["plugin_id", "cursor", "limit"], "Action metadata request");
    const limit = request.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new ActionDispatchError("invalid_input", "Action page limit must be from 1 to 100");
    const source = await this.options.installed(request.plugin_id);
    if (!source) throw new ActionDispatchError("plugin_unavailable", "Plugin is not installed");
    this.assertInstalled(source, request.plugin_id);
    const manifestDigest = await digest({ id: source.plugin_id, version: source.version, digest: source.manifest_digest,
      epoch: source.activation_epoch, descriptors: source.descriptors });
    let offset = 0;
    if (request.cursor !== undefined) {
      const cursor = this.cursors.get(request.cursor);
      if (!cursor || cursor.plugin_id !== request.plugin_id || cursor.digest !== manifestDigest ||
          cursor.epoch !== source.activation_epoch || cursor.caller !== principal.caller) {
        throw new ActionDispatchError("snapshot_stale", "Action cursor is stale or out of scope");
      }
      offset = cursor.offset; this.cursors.delete(request.cursor);
    }
    const declared = source.descriptors.filter(item => item.callers.includes(principal.caller));
    const items = await Promise.all(declared.slice(offset, offset + limit).map(item => this.metadata(source, item)));
    let next_cursor: string | null = null;
    if (offset + items.length < declared.length) {
      if (this.cursors.size >= MAX_CURSOR_TOKENS) this.cursors.delete(this.cursors.keys().next().value!);
      next_cursor = this.random();
      this.cursors.set(next_cursor, { plugin_id: source.plugin_id, offset: offset + items.length,
        digest: manifestDigest, epoch: source.activation_epoch, caller: principal.caller });
    }
    return { items, next_cursor };
  }

  async invoke(call: ActionCall, principal: TrustedActionPrincipal): Promise<ActionResult> {
    const fallback = this.fallback(call, principal);
    try {
      this.assertPrincipal(principal);
      if (!isRecord(call) || !IDENTIFIER.test(call.plugin_id) || !IDENTIFIER.test(call.action_id) || !isRecord(call.input)) {
        throw new ActionDispatchError("invalid_input", "Action request is malformed");
      }
      exactKeys(call, ["plugin_id", "action_id", "input", "idempotency_key"], "Action request");
      const source = await this.options.installed(call.plugin_id);
      if (!source) throw new ActionDispatchError("plugin_unavailable", "Plugin is not installed");
      this.assertInstalled(source, call.plugin_id);
      if (!source.enabled) throw new ActionDispatchError("plugin_unavailable", "Plugin is disabled", true);
      const descriptor = source.descriptors.find(item => item.action_id === call.action_id);
      if (!descriptor) throw new ActionDispatchError("invalid_input", "Action is not declared by the signed manifest");
      this.schemas.assertValue(descriptor.input_schema, call.input, "input");
      if (!descriptor.callers.includes(principal.caller)) throw new ActionDispatchError("capability_denied", "Action does not admit this caller");
      const context = await this.options.authority.issue(principal, call.plugin_id, call.action_id);
      requireContext(context);
      if (context.caller !== principal.caller || context.actor_id !== principal.actor_id) throw new ActionDispatchError("capability_denied", "Host context differs from authenticated caller");
      if ((principal.selected_scope && !sameJson(context.scope, principal.selected_scope)) ||
          (principal.repository_id !== undefined && context.scope.repository_id !== principal.repository_id) ||
          (principal.branch !== undefined && context.scope.branch !== principal.branch)) {
        throw new ActionDispatchError(principal.caller === "mcp" ? "repository_not_active" : "snapshot_stale",
          "Host selected workspace does not match the authenticated request");
      }
      const inputKey = typeof call.input.idempotency_key === "string" ? call.input.idempotency_key : undefined;
      if (call.idempotency_key !== undefined && inputKey !== undefined && call.idempotency_key !== inputKey) {
        throw new ActionDispatchError("invalid_input", "Envelope and action idempotency keys differ");
      }
      return await this.dispatchAuthorized({ ...call, idempotency_key: call.idempotency_key ?? inputKey }, descriptor, source, context, []);
    } catch (error) { return this.errorResult(error, fallback); }
  }

  private async dispatchAuthorized(call: ActionCall, descriptor: ActionDescriptor, source: VerifiedActionSet,
    context: InvocationContext, ancestors: readonly string[]): Promise<ActionResult> {
    requireContext(context);
    const frame = call.plugin_id + ":" + call.action_id;
    if (ancestors.includes(frame)) throw new ActionDispatchError("capability_denied", "Recursive plugin action calls are forbidden");
    const stack = [...ancestors, frame]; const current = { ...context, call_stack: stack };
    if (context.signal.aborted) throw new ActionDispatchError("cancelled", "Action cancelled", true);
    const now = this.now();
    if (now >= context.deadline_at) throw new ActionDispatchError("timeout", "Action deadline expired", true);
    if (!source.enabled || source.activation_epoch !== context.activation_epoch) throw new ActionDispatchError("plugin_unavailable", "Plugin activation changed", true);
    if (descriptor.requires_user_gesture && (context.caller !== "ui" || !context.user_gesture_verified)) {
      throw new ActionDispatchError("capability_denied", "Action requires a fresh Host-verified user gesture");
    }
    if (context.caller === "plugin" && (!context.caller_plugin_id ||
        (descriptor.caller_plugins && !descriptor.caller_plugins.includes(context.caller_plugin_id)))) {
      throw new ActionDispatchError("capability_denied", "Calling plugin is not declared by the action");
    }
    const grants = this.grants(source, context);
    for (const name of descriptor.required_capabilities) if (!grants.has(name)) {
      throw new ActionDispatchError("capability_denied", "Required capability is not granted", false, { capability: name });
    }
    await this.options.authority.assertCurrent(current);
    this.acquire(call.plugin_id, context.scope.workspace_id);
    let idKey: IdempotencyKey | undefined; let bodyDigest: string | undefined; let reserved = false; let submitted = false;
    try {
      if (descriptor.effect === "propose") {
        if (!call.idempotency_key || !TOKEN.test(call.idempotency_key)) throw new ActionDispatchError("invalid_input", "Proposal action requires a stable idempotency key");
        idKey = { workspace_id: context.scope.workspace_id, plugin_id: call.plugin_id, action_id: call.action_id, key: call.idempotency_key };
        bodyDigest = await digest({ scope: context.scope, snapshot: context.snapshot, input: call.input });
        const claim = await this.options.idempotency.claim(idKey, bodyDigest);
        if (claim.kind === "conflict") throw new ActionDispatchError("idempotency_conflict", "Idempotency key has a different request digest");
        if (claim.kind === "pending") throw new ActionDispatchError("external_state_unknown", "Matching proposal outcome is unresolved", true);
        if (claim.kind === "completed") return { ...claim.result, request_id: context.request_id };
        reserved = true;
      }
      const request: ActionRequest = { schema_version: 1, request_id: context.request_id, plugin_id: call.plugin_id,
        action_id: call.action_id, scope: context.scope, snapshot: context.snapshot, input: call.input,
        deadline_ms: Math.max(1, Math.min(MAX_DEADLINE_MS, context.deadline_at - now)),
        ...(call.idempotency_key ? { idempotency_key: call.idempotency_key } : {}) };
      this.schemas.assertRequest(request);
      const result = await this.options.runtime.invoke({ request, caller: context.caller, user_gesture: context.user_gesture_verified,
        activation_epoch: context.activation_epoch, deadline_at: now + request.deadline_ms, granted_capabilities: [...grants],
        validate_schema: (schema, value, phase) => this.schemas.assertValue(schema, value, phase),
        is_snapshot_current: () => this.options.authority.assertCurrent(current),
        resolve_host_call: hostCall => {
          if (hostCall.operation === "workspace.change.propose") submitted = true;
          return this.hostCall(hostCall, request, descriptor, source, current, stack);
        } });
      this.schemas.assertResult(result);
      if (result.request_id !== request.request_id || !sameJson(result.scope, request.scope) || !sameJson(result.snapshot, request.snapshot)) {
        throw new ActionDispatchError("invalid_input", "Plugin result identity differs from its Host request");
      }
      if (result.ok) this.schemas.assertValue(descriptor.output_schema, result.value, "output");
      if (idKey && bodyDigest) {
        if (result.ok) {
          try { await this.options.idempotency.complete(idKey, bodyDigest, result); }
          catch { throw new ActionDispatchError("storage_unknown", "Proposal receipt could not be durably recorded", true); }
        } else if (!submitted) {
          try { await this.options.idempotency.failBeforeEffects(idKey, bodyDigest, result.error); }
          catch { throw new ActionDispatchError("storage_unknown", "Proposal failure could not be durably recorded", true); }
        } else throw new ActionDispatchError("external_state_unknown", "Proposal was submitted but its receipt is unresolved", true);
      }
      return result;
    } catch (error) {
      if (submitted) throw new ActionDispatchError("external_state_unknown",
        "Proposal submission may have succeeded; resolve its Host receipt before retrying", true);
      if (reserved && !submitted && idKey && bodyDigest) await this.options.idempotency.failBeforeEffects(idKey, bodyDigest, {
        code: error instanceof ActionDispatchError ? error.code : "guest_trap",
        message: error instanceof Error ? error.message : "Proposal failed before submission",
        retryable: error instanceof ActionDispatchError && error.retryable });
      throw error;
    } finally { this.release(call.plugin_id, context.scope.workspace_id); }
  }

  private async hostCall(call: RuntimeHostCall, request: ActionRequest, descriptor: ActionDescriptor,
    source: VerifiedActionSet, context: InvocationContext, stack: readonly string[]): Promise<unknown> {
    if (!isRecord(call) || !TOKEN.test(call.call_id) || typeof call.operation !== "string" || !isRecord(call.payload)) {
      throw new ActionDispatchError("invalid_input", "Guest Host continuation is malformed");
    }
    const capability = OPERATION_CAPABILITY[call.operation];
    if (!capability || !descriptor.required_capabilities.includes(capability) || !this.grants(source, context).has(capability)) {
      throw new ActionDispatchError("capability_denied", "Host operation is undeclared or ungranted", false, { operation: call.operation });
    }
    if (context.signal.aborted) throw new ActionDispatchError("cancelled", "Action cancelled", true);
    if (this.now() >= context.deadline_at) throw new ActionDispatchError("timeout", "Action deadline expired", true);
    if (call.operation === "workspace.navigation" && (context.caller !== "ui" || !context.user_gesture_verified)) {
      throw new ActionDispatchError("capability_denied", "Navigation requires a Host UI gesture");
    }
    this.validateHostPayload(call.operation, call.payload);
    if (call.operation === "workspace.plugin.invoke") return this.invokeDependency(call.payload, source, context, stack);
    if (call.operation === "actions.list") return this.listDependency(call.payload, source);
    this.assertBoundPayload(call.operation, call.payload, request);
    await this.options.authority.assertCurrent(context);
    const hostContext: HostOperationContext = { ...context, plugin_id: source.plugin_id, descriptor, request };
    const payload = this.bindIdentity(call.operation, call.payload, request, context);
    if (call.operation === "workspace.change.stage" && source.plugin_id !== "proprium.paired-writing") {
      throw new ActionDispatchError("capability_denied", "Only Paired Writing can create compiler staging leases");
    }
    if ((call.operation === "workspace.file.list" || call.operation === "workspace.file.read") && typeof call.payload.snapshot === "string") {
      if (!context.staging_snapshot || call.payload.snapshot !== context.staging_snapshot || !this.options.capabilities.validateStage) {
        throw new ActionDispatchError("snapshot_stale", "Staging read lease is unissued or unavailable", true);
      }
      await this.options.capabilities.validateStage(context.staging_snapshot, hostContext);
    }
    switch (call.operation) {
      case "workspace.identity.read": return this.port("identityRead", payload, hostContext);
      case "workspace.file.list": return this.port("fileList", payload, hostContext);
      case "workspace.file.read": return this.port("fileRead", payload, hostContext);
      case "workspace.navigation": return this.port("navigate", payload, hostContext);
      case "workspace.change.propose":
        if (descriptor.effect !== "propose") throw new ActionDispatchError("capability_denied", "Read actions cannot submit changes");
        return this.port("propose", payload, hostContext);
      case "workspace.change.stage": return this.port("stage", payload, hostContext);
      case "workspace.change.timestamp":
        if (!request.idempotency_key) throw new ActionDispatchError("invalid_input", "Stable timestamp requires an idempotency key");
        return this.port("timestamp", payload, hostContext);
      case "workspace.asset.read": return this.port("assetRead", payload, hostContext);
      case "workspace.derived.cache.get": return this.port("cacheGet", payload, hostContext);
      case "workspace.derived.cache.put": return this.port("cachePut", payload, hostContext);
      case "workspace.derived.cache.evict": return this.port("cacheEvict", payload, hostContext);
      case "plugin.preferences.read": return this.port("preferencesRead", payload, hostContext);
      case "artifact.create": return this.port("artifactCreate", payload, hostContext);
      case "artifact.append": return this.port("artifactAppend", payload, hostContext);
      case "artifact.seal": return this.port("artifactSeal", payload, hostContext);
      case "artifact.discard": return this.port("artifactDiscard", payload, hostContext);
      case "workspace.change.list": return this.port("proposalList", payload, hostContext);
      case "workspace.change.status": return this.port("proposalStatus", payload, hostContext);
      case "workspace.change.observations": return this.port("proposalObservations", payload, hostContext);
      case "workspace.change.inspect": return this.port("proposalInspect", payload, hostContext);
      case "workspace.change.content.read": return this.port("proposalContentRead", payload, hostContext);
      case "workspace.capabilities.query": return this.port("capabilitiesQuery", payload, hostContext);
      default: throw new ActionDispatchError("capability_denied", "Host operation is unsupported");
    }
  }

  private async invokeDependency(payload: Record<string, unknown>, source: VerifiedActionSet,
    context: InvocationContext, ancestors: readonly string[]): Promise<unknown> {
    exactKeys(payload, ["plugin_id", "action_id", "input"], "Nested action");
    if (typeof payload.plugin_id !== "string" || typeof payload.action_id !== "string" || !isRecord(payload.input)) {
      throw new ActionDispatchError("invalid_input", "Nested action is malformed");
    }
    if (!source.dependencies.includes(payload.plugin_id)) throw new ActionDispatchError("dependency_unavailable", "Target is not a declared dependency");
    const target = await this.options.installed(payload.plugin_id);
    if (!target || !target.enabled) throw new ActionDispatchError("dependency_unavailable", "Dependency is unavailable");
    this.assertInstalled(target, target.plugin_id);
    const descriptor = target.descriptors.find(item => item.action_id === payload.action_id);
    if (!descriptor) throw new ActionDispatchError("dependency_unavailable", "Dependency action is undeclared");
    if (!descriptor.callers.includes("plugin") || (descriptor.caller_plugins && !descriptor.caller_plugins.includes(source.plugin_id))) {
      throw new ActionDispatchError("capability_denied", "Dependency action does not admit this caller");
    }
    const staged = typeof payload.input.staging_snapshot === "string" ? payload.input.staging_snapshot : undefined;
    if (payload.input.staging_snapshot !== undefined && (!staged || staged.length > 256)) throw new ActionDispatchError("invalid_input", "Staging lease identity is invalid");
    const ownerCompile = source.plugin_id === "proprium.paired-writing" && descriptor.action_id.endsWith(".changes.compile") &&
      (target.plugin_id === "proprium.narrative" || target.plugin_id === "proprium.knowledge");
    if (staged && !ownerCompile) throw new ActionDispatchError("capability_denied", "Staging leases are restricted to Paired owner compilers");
    const child = await this.options.authority.issueChild(context, source.plugin_id, target.plugin_id, descriptor.action_id, staged);
    requireContext(child);
    if (child.caller !== "plugin" || child.caller_plugin_id !== source.plugin_id ||
        child.actor_id !== context.actor_id || !sameJson(child.scope, context.scope) ||
        !sameJson(child.snapshot, context.snapshot) || child.staging_snapshot !== staged) {
      throw new ActionDispatchError("capability_denied", "Dependency call changed the Host-issued scope, revision or staging lease");
    }
    const result = await this.dispatchAuthorized({ plugin_id: target.plugin_id, action_id: descriptor.action_id, input: payload.input },
      descriptor, target, child, ancestors);
    if (!result.ok) throw result.error;
    return result.value;
  }
  private async listDependency(payload: Record<string, unknown>, source: VerifiedActionSet): Promise<ActionListResult> {
    exactKeys(payload, ["plugin_id", "cursor", "limit"], "Action metadata");
    if (typeof payload.plugin_id !== "string" || !source.dependencies.includes(payload.plugin_id)) throw new ActionDispatchError("dependency_unavailable", "Metadata is limited to dependencies");
    const target = await this.options.installed(payload.plugin_id);
    if (!target) throw new ActionDispatchError("dependency_unavailable", "Dependency is not installed");
    this.assertInstalled(target, target.plugin_id);
    const limit = payload.limit === undefined ? 50 : payload.limit;
    if (!Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > 100) throw new ActionDispatchError("invalid_input", "Metadata limit is invalid");
    const items = await Promise.all(target.descriptors.filter(item => item.callers.includes("plugin") &&
      (!item.caller_plugins || item.caller_plugins.includes(source.plugin_id))).slice(0, limit as number).map(item => this.metadata(target, item)));
    return { items, next_cursor: null };
  }
  private assertBoundPayload(operation: string, payload: Record<string, unknown>, request: ActionRequest): void {
    if (operation === "workspace.file.list" || operation === "workspace.file.read") {
      if (!sameJson(payload.snapshot, request.snapshot) && typeof payload.snapshot !== "string") throw new ActionDispatchError("snapshot_stale", "File read snapshot differs from Host request");
    }
    if (operation === "workspace.change.propose") {
      const changeset = payload.changeset;
      if (!isRecord(changeset) || !sameJson(changeset.scope, request.scope) || !sameJson(changeset.snapshot, request.snapshot)) {
        throw new ActionDispatchError("snapshot_stale", "ChangeSet scope and snapshot differ from Host request");
      }
    }
    if (operation === "workspace.change.stage" && !sameJson(payload.base_snapshot, request.snapshot)) throw new ActionDispatchError("snapshot_stale", "Stage lease base differs from Host snapshot");
  }
  private validateHostPayload(operation: string, payload: Record<string, unknown>): void {
    const shapes: Readonly<Record<string, readonly string[]>> = {
      "workspace.identity.read": ["paths"], "workspace.file.list": ["snapshot", "prefix", "cursor", "limit"],
      "workspace.file.read": ["snapshot", "path", "offset", "length"], "workspace.navigation": ["target", "expected_context", "intent"],
      "workspace.change.propose": ["changeset"], "workspace.change.stage": ["base_snapshot", "previous_stage", "units"],
      "workspace.change.timestamp": [], "workspace.asset.read": ["group_id", "file_path", "offset", "length"],
      "workspace.derived.cache.get": ["key"], "workspace.derived.cache.put": ["key", "value"],
      "workspace.derived.cache.evict": ["key"], "plugin.preferences.read": ["key", "schema_version"],
      "artifact.create": ["media_type", "filename"], "artifact.append": ["artifact_id", "sequence", "bytes"],
      "artifact.seal": ["artifact_id", "sha256", "total_bytes"], "artifact.discard": ["artifact_id"],
      "workspace.change.list": ["cursor", "limit", "status"], "workspace.change.status": ["proposal_id"],
      "workspace.change.observations": ["proposal_id", "cursor", "limit"],
      "workspace.change.inspect": ["proposal_id", "cursor", "limit", "include_source"],
      "workspace.change.content.read": ["proposal_id", "ref", "offset", "length"],
      "workspace.capabilities.query": ["capability_id"], "actions.list": ["plugin_id", "cursor", "limit"],
      "workspace.plugin.invoke": ["plugin_id", "action_id", "input"],
    };
    const allowed = shapes[operation];
    if (!allowed) throw new ActionDispatchError("capability_denied", "Host operation is outside v2 registry");
    exactKeys(payload, allowed, "Host operation " + operation);
    const str = (key: string, max = 1024) => { const value = payload[key]; if (value !== undefined && (typeof value !== "string" || value.length > max)) throw new ActionDispatchError("invalid_input", operation + " " + key + " is invalid"); };
    const num = (key: string, min: number, max: number) => { const value = payload[key]; if (value !== undefined && (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max)) throw new ActionDispatchError("invalid_input", operation + " " + key + " is out of range"); };
    if (operation === "workspace.identity.read" && payload.paths !== undefined &&
        (!Array.isArray(payload.paths) || payload.paths.length > 100 ||
          payload.paths.some(value => typeof value !== "string" || !this.safePath(value)))) {
      throw new ActionDispatchError("invalid_input", "Identity provenance paths are invalid");
    }
    if (operation === "workspace.file.list") { if (!isRecord(payload.snapshot) && typeof payload.snapshot !== "string") throw new ActionDispatchError("invalid_input", "Host snapshot required"); str("prefix"); str("cursor", 512); num("limit", 1, 256); }
    if (operation === "workspace.file.read") { if ((!isRecord(payload.snapshot) && typeof payload.snapshot !== "string") || typeof payload.path !== "string" || !this.safePath(payload.path)) throw new ActionDispatchError("invalid_path", "File read path or snapshot invalid"); num("offset", 0, Number.MAX_SAFE_INTEGER); num("length", 1, 256 * 1024); }
    if (operation === "workspace.change.propose" && !isRecord(payload.changeset)) throw new ActionDispatchError("invalid_input", "ChangeSet required");
    if (operation === "workspace.change.stage") { if (!isRecord(payload.base_snapshot)) throw new ActionDispatchError("invalid_input", "Original Host snapshot required"); str("previous_stage", 256); if (!Array.isArray(payload.units)) throw new ActionDispatchError("invalid_input", "Stage units required"); }
    if (operation === "workspace.change.timestamp" && Object.keys(payload).length !== 0) throw new ActionDispatchError("invalid_input", "Timestamp request is empty");
    if (operation === "workspace.asset.read") {
      str("group_id", 128);
      if (typeof payload.file_path !== "string" || !this.safePath(payload.file_path)) throw new ActionDispatchError("invalid_path", "Asset path is invalid");
      num("offset", 0, Number.MAX_SAFE_INTEGER); num("length", 1, 65_536);
    }
    if (operation.startsWith("workspace.derived.cache.") && !isRecord(payload.key)) throw new ActionDispatchError("invalid_input", "Cache key required");
    if (operation === "artifact.create") { str("media_type", 256); str("filename", 256); }
    if (operation === "artifact.append") { str("artifact_id", 256); num("sequence", 0, Number.MAX_SAFE_INTEGER); if (!Array.isArray(payload.bytes) || payload.bytes.length > 65_536 || payload.bytes.some(value => !Number.isInteger(value) || (value as number) < 0 || (value as number) > 255)) throw new ActionDispatchError("invalid_input", "Artifact chunk exceeds RPC budget"); }
    if (operation === "artifact.seal") { str("artifact_id", 256); num("total_bytes", 0, 128 * 1024 * 1024); if (typeof payload.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(payload.sha256)) throw new ActionDispatchError("invalid_input", "Artifact digest is invalid"); }
    if (operation.startsWith("artifact.") && operation !== "artifact.create" && operation !== "artifact.append" && operation !== "artifact.seal") str("artifact_id", 256);
    if (operation.startsWith("workspace.change.")) { str("proposal_id", 256); str("cursor", 512); str("ref", 512); num("limit", 1, operation === "workspace.change.inspect" ? 50 : 100); num("offset", 0, Number.MAX_SAFE_INTEGER); num("length", 1, 256 * 1024); if (payload.include_source !== undefined && typeof payload.include_source !== "boolean") throw new ActionDispatchError("invalid_input", "include_source must be boolean"); }
    if (operation === "workspace.plugin.invoke" && (typeof payload.plugin_id !== "string" || !IDENTIFIER.test(payload.plugin_id) || typeof payload.action_id !== "string" || !IDENTIFIER.test(payload.action_id) || !isRecord(payload.input))) throw new ActionDispatchError("invalid_input", "Nested action is malformed");
    if (operation === "actions.list" && (typeof payload.plugin_id !== "string" || !IDENTIFIER.test(payload.plugin_id))) throw new ActionDispatchError("invalid_input", "Metadata plugin ID is malformed");
  }
  private bindIdentity(operation: string, payload: Record<string, unknown>, request: ActionRequest,
    context: InvocationContext): Record<string, unknown> {
    const bound = { ...payload };
    if (operation === "workspace.identity.read" || operation.startsWith("workspace.file.") || operation.startsWith("workspace.change.")) bound.scope = request.scope;
    if (operation === "workspace.identity.read" || operation.startsWith("workspace.file.")) bound.snapshot = request.snapshot;
    if (operation.startsWith("artifact.")) { bound.scope = request.scope; bound.snapshot = request.snapshot; }
    if (operation.startsWith("workspace.derived.cache.")) { if (isRecord(payload.key)) bound.key = { ...payload.key, plugin_id: request.plugin_id, snapshot: request.snapshot }; else bound.plugin_id = request.plugin_id; }
    if (operation.startsWith("plugin.preferences.")) { bound.plugin_id = request.plugin_id; bound.user_partition = context.actor_id; }
    return bound;
  }
  private port<K extends keyof HostCapabilityPorts>(key: K, payload: Record<string, unknown>, context: HostOperationContext): Promise<unknown> {
    const handler = this.options.capabilities[key] as ((payload: Record<string, unknown>, context: HostOperationContext) => Promise<unknown>) | undefined;
    if (!handler) throw new ActionDispatchError("missing_capability", "Host capability is unavailable", true, { capability: String(key) });
    return handler(payload, context);
  }
  private grants(source: VerifiedActionSet, context: InvocationContext): Set<string> {
    const user = new Set(context.caller === "plugin" ? context.grants : source.grants);
    const host = new Set(context.caller === "plugin" ? context.host_capabilities : source.host_capabilities);
    return new Set([...user].filter(item => source.grants.includes(item) && host.has(item) && source.host_capabilities.includes(item)));
  }
  private acquire(plugin: string, workspace: string): void {
    if (this.active.has(plugin)) throw new ActionDispatchError("capacity", "Plugin already has an active action", true);
    const count = this.jobs.get(workspace) ?? 0; if (count >= MAX_JOBS) throw new ActionDispatchError("capacity", "Workspace action limit reached", true);
    this.active.add(plugin); this.jobs.set(workspace, count + 1);
  }
  private release(plugin: string, workspace: string): void { this.active.delete(plugin); const n = Math.max(0, (this.jobs.get(workspace) ?? 1) - 1); if (n) this.jobs.set(workspace, n); else this.jobs.delete(workspace); }
  private async metadata(source: VerifiedActionSet, descriptor: ActionDescriptor): Promise<ActionListItem> {
    if (!source.enabled) return { descriptor, availability: "disabled", reason: "Plugin is disabled" };
    for (const id of source.dependencies) { const dep = await this.options.installed(id); if (!dep || !dep.enabled) return { descriptor, availability: "dependency_unavailable", reason: "A dependency is not enabled" }; }
    const missing = descriptor.required_capabilities.find(item => !source.grants.includes(item) || !source.host_capabilities.includes(item));
    if (missing) return { descriptor, availability: "capability_denied", reason: "Capability " + missing + " is not granted" };
    return { descriptor, availability: "ready" };
  }
  private assertInstalled(source: VerifiedActionSet, id: string): void {
    if (!isRecord(source) || source.plugin_id !== id || !IDENTIFIER.test(id) || !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/u.test(source.version) ||
        !/^[a-f0-9]{64}$/u.test(source.manifest_digest) || !Number.isSafeInteger(source.activation_epoch) || source.activation_epoch < 1 ||
        !Array.isArray(source.descriptors) || !Array.isArray(source.dependencies) || !Array.isArray(source.grants) || !Array.isArray(source.host_capabilities)) {
      throw new ActionDispatchError("incompatible_abi", "Admitted plugin action metadata is malformed");
    }
    const seen = new Set<string>();
    for (const item of source.descriptors) { this.schemas.assertDescriptor(item); if (item.plugin_id !== id || seen.has(item.action_id)) throw new ActionDispatchError("incompatible_abi", "Manifest action identity is duplicate or foreign"); seen.add(item.action_id); }
  }
  private safePath(path: string): boolean { return path.length > 0 && path.length <= 1024 && !path.startsWith("/") && !path.includes("\\") && !path.includes("\0") && path.split("/").every(part => part && part !== "." && part !== ".." && part !== ".git"); }
  private assertPrincipal(principal: TrustedActionPrincipal): void { if (!principal || !["ui", "mcp"].includes(principal.caller) || !principal.actor_id || !TOKEN.test(principal.request_id)) throw new ActionDispatchError("capability_denied", "Authenticated Host caller is invalid"); }
  private fallback(call: ActionCall, principal: TrustedActionPrincipal): ActionRequest {
    return { schema_version: 1, request_id: principal?.request_id || "unavailable", plugin_id: call?.plugin_id || "unavailable.plugin",
      action_id: call?.action_id || "unavailable.action", scope: principal?.selected_scope ?? { workspace_id: "unavailable", repository_id: principal?.repository_id ?? null, branch: principal?.branch ?? "", generation: "unavailable" },
      snapshot: { id: "unavailable", local_commit: null, worktree_generation: "unavailable", draft_generation: null }, input: {}, deadline_ms: 1 };
  }
  private errorResult(error: unknown, request: ActionRequest): ActionResult {
    if (error instanceof ActionDispatchError) return error.result(request);
    const item = error as { code?: unknown; message?: unknown; retryable?: unknown; details?: unknown } | null;
    return { request_id: request.request_id, scope: request.scope, snapshot: request.snapshot, ok: false,
      error: { code: typeof item?.code === "string" ? item.code : "guest_trap", message: typeof item?.message === "string" ? item.message.slice(0, 512) : "Action dispatch failed", retryable: item?.retryable === true, ...(isRecord(item?.details) ? { details: item.details } : {}) } };
  }
}
