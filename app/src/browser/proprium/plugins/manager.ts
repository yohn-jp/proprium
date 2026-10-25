import { PluginArtifactError, verifyPluginArtifact, type PluginManifestV1 } from "../plugin-artifact.js";
import { BrowserPluginRuntime } from "../plugin-runtime/runtime.js";
import type { PluginCapability, PluginTranscript, RuntimeContext, RuntimeSnapshot } from "../plugin-runtime/protocol.js";
import { admitRegistry, admitRegistryManifest, compareVersions, PluginRegistryError, registryArtifactURL, registryManifestEntry, registrySignatureUrl, satisfiesVersion, type PluginDependency, type PluginRegistryEntry, type PluginRegistryTrust, type SignedRegistrySnapshot } from "./registry.js";
import { IndexedDbPluginStore, pluginKey, type InstalledPluginRecord, type PluginStore } from "./store.js";

export { PluginRegistryError } from "./registry.js";
export type { PluginCapability, PluginTranscript, RuntimeSnapshot };
export type { PluginRegistryTrust, PluginDependency } from "./registry.js";
export type { PluginStore, InstalledPluginRecord } from "./store.js";

const MAX_SIGNATURE_BYTES = 64;
const MAX_ARTIFACT_BYTES = 128 * 1024 * 1024;

export class PluginManagerError extends Error {
  constructor(readonly code: "not_installed" | "already_active" | "not_active" | "dependency_in_use" | "invalid_plugin" | "network_error" | "storage_error", message: string) {
    super(message);
    this.name = "PluginManagerError";
  }
}

export interface BrowserPluginManagerOptions {
  readonly registries?: readonly PluginRegistryTrust[];
  readonly fetcher?: typeof fetch;
  readonly store?: PluginStore;
}

export interface InstallFromRegistryOptions {
  readonly registryUrl: string;
  readonly pluginId: string;
  /** Exact immutable SemVer. Omit to select the highest stable registry version. */
  readonly version?: string;
}

export interface PluginInstallPreview {
  readonly planId: string;
  readonly intent: "install" | "update";
  readonly registryUrl: string;
  readonly registryDigest: string;
  readonly pluginId: string;
  readonly version: string;
  readonly downloadBytes: number;
  readonly expiresAt: number;
  readonly packages: readonly {
    readonly id: string;
    readonly version: string;
    readonly capabilities: readonly string[];
    readonly dependencies: readonly { readonly id: string; readonly range: string; readonly version: string }[];
    readonly downloadBytes: number;
  }[];
}

export interface EnablePluginOptions {
  readonly pluginId: string;
  readonly version: string;
  readonly workspaceId: string;
  readonly grants: readonly PluginCapability[];
  readonly hostAllowed: readonly PluginCapability[];
  readonly context?: RuntimeContext;
}

export interface InvokePluginOptions {
  readonly pluginId: string;
  readonly request: string;
  readonly snapshot: RuntimeSnapshot;
  readonly isSnapshotCurrent: (snapshotId: string, revision: string) => boolean;
}

export interface InstalledPlugin {
  readonly id: string;
  readonly version: string;
  readonly activeVersion: string | null;
  readonly state: "installed" | "enabled-idle" | "active" | "revoked";
  readonly capabilities: readonly string[];
  readonly dependencies: readonly { readonly id: string; readonly range: string; readonly version: string }[];
  readonly contributions: PluginTranscript["contributions"];
  readonly registryUrl: string;
}

interface ResolvedEntry {
  readonly registry: SignedRegistrySnapshot;
  readonly entry: PluginRegistryEntry;
  readonly trust: PluginRegistryTrust;
  readonly dependencies: readonly { readonly id: string; readonly range: string; readonly version: string }[];
}
interface PreparedPlugin {
  readonly resolved: ResolvedEntry;
  readonly manifestBytes: Uint8Array;
  readonly manifest: PluginManifestV1;
  readonly downloadBytes: number;
}
interface InstallPlanPayload {
  readonly manager: BrowserPluginManager;
  readonly intent: PluginInstallPreview["intent"];
  readonly options: InstallFromRegistryOptions;
  readonly registry: SignedRegistrySnapshot;
  readonly prepared: readonly PreparedPlugin[];
  used: boolean;
}
interface ActivePlugin {
  readonly version: string;
  readonly runtime: BrowserPluginRuntime;
  transcript?: PluginTranscript;
}
interface EnabledPlugin {
  readonly version: string;
  readonly workspaceId: string;
  readonly grants: readonly PluginCapability[];
  readonly hostAllowed: readonly PluginCapability[];
  readonly context: RuntimeContext;
}

const installPlans = new WeakMap<object, InstallPlanPayload>();

async function boundedBytes(response: Response, limit: number): Promise<Uint8Array> {
  if (!response.ok) throw new PluginManagerError("network_error", `Artifact request failed with status ${response.status}`);
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > limit) throw new PluginManagerError("invalid_plugin", "Downloaded plugin resource exceeds its byte limit");
  if (!response.body) {
    const buffer = new Uint8Array(await response.arrayBuffer());
    if (buffer.byteLength > limit) throw new PluginManagerError("invalid_plugin", "Downloaded plugin resource exceeds its byte limit");
    return buffer;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel();
        throw new PluginManagerError("invalid_plugin", "Downloaded plugin resource exceeds its byte limit");
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

function stableVersions(entries: readonly PluginRegistryEntry[], id: string): PluginRegistryEntry[] {
  return entries.filter(entry => entry.id === id && !entry.version.includes("-")).sort((a, b) => compareVersions(b.version, a.version));
}

function activeStateKey(pluginId: string): string { return `active:${pluginId}`; }
function previousStateKey(pluginId: string): string { return `previous:${pluginId}`; }
function latestRegistryStateKey(registryUrl: string): string { return `registry-latest:${registryUrl}`; }

/** Host-owned install and lifecycle coordinator for signed, independently distributed WASM plugins. */
export class BrowserPluginManager {
  private readonly fetcher: typeof fetch;
  private readonly store: PluginStore;
  private readonly trusts: Map<string, PluginRegistryTrust>;
  private readonly active = new Map<string, ActivePlugin>();
  private readonly enabled = new Map<string, EnabledPlugin>();
  private operation = Promise.resolve();
  private closed = false;

  constructor(options: BrowserPluginManagerOptions = {}) {
    this.fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis);
    this.store = options.store ?? new IndexedDbPluginStore();
    this.trusts = new Map((options.registries ?? []).map(trust => [trust.url, Object.freeze({
      url: trust.url,
      publicKey: Uint8Array.from(trust.publicKey),
      artifactOrigins: Object.freeze([...trust.artifactOrigins]),
    })]));
  }

  /** Inspects signed metadata and computes the download/permission summary without fetching WASM/assets. */
  previewInstall(options: InstallFromRegistryOptions): Promise<PluginInstallPreview> {
    return this.serialize(() => this.prepareInstall(options, "install"));
  }

  previewUpdate(options: InstallFromRegistryOptions & { readonly version: string }): Promise<PluginInstallPreview> {
    return this.serialize(() => this.prepareInstall(options, "update"));
  }

  /** Confirms and consumes a previously reviewed, one-use install plan. */
  installFromRegistry(preview: PluginInstallPreview): Promise<InstalledPlugin[]> {
    const payload = this.takePlan(preview, "install");
    return this.serialize(() => this.commitInstall(payload));
  }

  private async prepareInstall(options: InstallFromRegistryOptions, intent: PluginInstallPreview["intent"]): Promise<PluginInstallPreview> {
    this.assertOpen();
    if (intent === "update") {
      const current = await this.currentRecord(options.pluginId);
      if (!current) throw new PluginManagerError("not_installed", `Plugin ${options.pluginId} is not installed`);
      if (current.registryUrl !== options.registryUrl) throw new PluginManagerError("invalid_plugin", "Plugin updates must use the registry that installed the current version");
    }
    const trust = this.requireTrust(options.registryUrl);
    const registry = await this.fetchRegistry(trust);
    await this.enforceRegistryRevocations(registry);
    const root = options.version
      ? registryManifestEntry(registry, options.pluginId, options.version)
      : stableVersions(registry.document.plugins, options.pluginId)[0];
    if (!root) throw new PluginManagerError("invalid_plugin", `Plugin ${options.pluginId}${options.version ? `@${options.version}` : ""} is not listed in the trusted registry`);
    const resolved = new Map<string, ResolvedEntry>();
    await this.resolveDependencies(registry, trust, root, [], resolved);
    const prepared: PreparedPlugin[] = [];
    const packages: Array<PluginInstallPreview["packages"][number]> = [];
    for (const item of resolved.values()) {
      const key = pluginKey(item.entry.id, item.entry.version);
      if (await this.store.getPlugin(key)) {
        const { manifest } = await this.verifyStoredPlugin(key, true);
        packages.push(Object.freeze({ id: item.entry.id, version: item.entry.version, capabilities: manifest.capabilities, dependencies: item.dependencies, downloadBytes: 0 }));
        continue;
      }
      const manifestURL = registryArtifactURL(item.entry.manifestPath, registry, trust);
      const manifestBytes = await this.fetchBytes(manifestURL, 128 * 1024);
      const manifest = await admitRegistryManifest(manifestBytes, item.entry);
      const downloadBytes = manifest.artifacts.reduce((total, artifact) => total + artifact.bytes, 0);
      if (!Number.isSafeInteger(downloadBytes) || downloadBytes > 512 * 1024 * 1024) throw new PluginManagerError("invalid_plugin", "Plugin dependency closure exceeds the Host download limit");
      prepared.push({ resolved: item, manifestBytes, manifest, downloadBytes });
      packages.push(Object.freeze({ id: item.entry.id, version: item.entry.version, capabilities: manifest.capabilities, dependencies: item.dependencies, downloadBytes }));
    }
    const downloadBytes = packages.reduce((total, item) => total + item.downloadBytes, 0);
    if (downloadBytes > 512 * 1024 * 1024) throw new PluginManagerError("invalid_plugin", "Plugin dependency closure exceeds the Host download limit");
    const preview: PluginInstallPreview = Object.freeze({
      planId: crypto.randomUUID(), intent, registryUrl: trust.url, registryDigest: registry.digest,
      pluginId: root.id, version: root.version, downloadBytes, expiresAt: Date.now() + 5 * 60_000,
      packages: Object.freeze(packages),
    });
    installPlans.set(preview, { manager: this, intent, options: { registryUrl: trust.url, pluginId: root.id, version: root.version }, registry, prepared: Object.freeze(prepared), used: false });
    return preview;
  }

  private takePlan(preview: PluginInstallPreview, intent: PluginInstallPreview["intent"]): InstallPlanPayload {
    const payload = preview && typeof preview === "object" ? installPlans.get(preview) : undefined;
    if (!payload || payload.manager !== this || payload.intent !== intent || payload.used || Date.now() > preview.expiresAt) {
      throw new PluginManagerError("invalid_plugin", "A fresh, reviewed plugin installation plan is required");
    }
    payload.used = true;
    return payload;
  }

  private async commitInstall(payload: InstallPlanPayload): Promise<InstalledPlugin[]> {
    this.assertOpen();
    const trust = this.requireTrust(payload.options.registryUrl);
    const currentRegistry = await this.fetchRegistry(trust);
    await this.enforceRegistryRevocations(currentRegistry);
    if (currentRegistry.digest !== payload.registry.digest) throw new PluginManagerError("invalid_plugin", "The signed registry changed after review; request a new plugin preview");
    const staged: InstalledPluginRecord[] = [];
    for (const item of payload.prepared) staged.push(await this.downloadPlugin(item));
    if (staged.length) await this.store.putPlugins(staged);
    for (const item of payload.prepared) {
      const stateKey = activeStateKey(item.resolved.entry.id);
      if (!(await this.store.getState(stateKey))) await this.store.setState(stateKey, item.resolved.entry.version);
    }
    return this.installed();
  }

  /** Confirms a reviewed update plan and switches the active version after full verification. */
  update(preview: PluginInstallPreview): Promise<InstalledPlugin[]> {
    const payload = this.takePlan(preview, "update");
    return this.serialize(async () => {
      this.assertOpen();
      await this.commitInstall(payload);
      const version = payload.options.version!;
      const currentVersion = await this.store.getState(activeStateKey(payload.options.pluginId));
      if (currentVersion && currentVersion !== version) {
        await this.disableInternal(payload.options.pluginId);
        await this.store.setState(previousStateKey(payload.options.pluginId), currentVersion);
      }
      await this.store.setState(activeStateKey(payload.options.pluginId), version);
      return this.installed();
    });
  }

  /** Read only verified installed metadata. No Worker starts during listing. */
  async installed(): Promise<InstalledPlugin[]> {
    try {
      const records = await this.store.listPlugins();
      const result: InstalledPlugin[] = [];
      for (const record of records) {
        if (!record || typeof record.id !== "string" || typeof record.version !== "string" ||
            pluginKey(record.id, record.version) !== record.key || typeof record.registryUrl !== "string") {
          throw new PluginManagerError("storage_error", "Installed plugin record identity is malformed");
        }
        let manifest: PluginManifestV1 | undefined;
        let revoked = false;
        try { ({ manifest, revoked } = await this.verifyStoredPlugin(record.key, false, true)); }
        catch (error) {
          if (!(error instanceof PluginManagerError && error.code === "invalid_plugin") &&
              !(error instanceof PluginRegistryError) && !(error instanceof PluginArtifactError)) throw error;
          revoked = true;
        }
        const activeVersion = await this.store.getState(activeStateKey(record.id)) ?? null;
        const live = this.active.get(record.id);
        const enabled = this.enabled.get(record.id);
        result.push(Object.freeze({
          id: record.id, version: record.version, activeVersion,
          state: revoked ? "revoked" : live?.version === record.version ? "active" : enabled?.version === record.version ? "enabled-idle" : "installed",
          capabilities: manifest?.capabilities ?? [],
          dependencies: Object.freeze(Array.isArray(record.resolvedDependencies) ? record.resolvedDependencies.filter(dependency =>
            dependency && typeof dependency.id === "string" && typeof dependency.range === "string" && typeof dependency.version === "string").map(dependency => ({ ...dependency })) : []),
          contributions: !revoked && live?.version === record.version ? live.transcript?.contributions ?? [] : [],
          registryUrl: record.registryUrl,
        }));
      }
      return result.sort((a, b) => a.id.localeCompare(b.id) || compareVersions(b.version, a.version));
    } catch (error) {
      if (error instanceof Error) throw error;
      throw new PluginManagerError("storage_error", "Installed plugin metadata could not be verified");
    }
  }

  /** Records explicit capability grants. It does not start a Worker until the first invocation. */
  enable(options: EnablePluginOptions): Promise<void> {
    return this.serialize(() => this.enableInternal(options));
  }

  private async enableInternal(options: EnablePluginOptions): Promise<void> {
    this.assertOpen();
    if (this.enabled.has(options.pluginId)) throw new PluginManagerError("already_active", `Plugin ${options.pluginId} is already enabled`);
    const record = await this.requireInstalled(options.pluginId, options.version);
    await this.verifyStoredPlugin(record.key, false);
    const context = options.context ?? { pluginId: options.pluginId, version: options.version, workspaceId: options.workspaceId };
    if (context.pluginId !== options.pluginId || context.version !== options.version || context.workspaceId !== options.workspaceId) {
      throw new PluginManagerError("invalid_plugin", "Plugin activation context does not match the selected version and workspace");
    }
    const currentVersion = await this.store.getState(activeStateKey(options.pluginId));
    if (currentVersion && currentVersion !== options.version) await this.store.setState(previousStateKey(options.pluginId), currentVersion);
    await this.store.setState(activeStateKey(options.pluginId), options.version);
    this.enabled.set(options.pluginId, Object.freeze({
      version: options.version, workspaceId: options.workspaceId,
      grants: Object.freeze([...options.grants]), hostAllowed: Object.freeze([...options.hostAllowed]), context: Object.freeze({ ...context }),
    }));
  }

  /** Runs against a revision-pinned Host snapshot. Plugin changes remain proposals for Host review. */
  async invoke(options: InvokePluginOptions): Promise<PluginTranscript> {
    const active = await this.ensureActive(options.pluginId);
    try {
      const transcript = await active.runtime.invoke(options);
      active.transcript = transcript;
      return transcript;
    } catch (error) {
      if (this.active.get(options.pluginId) === active && active.runtime.state !== "active") {
        this.active.delete(options.pluginId);
        await active.runtime.destroy().catch(() => undefined);
      }
      throw error;
    }
  }

  private ensureActive(pluginId: string): Promise<ActivePlugin> {
    return this.serialize(async () => {
      this.assertOpen();
      const active = this.active.get(pluginId);
      if (active) return active;
      const enabled = this.enabled.get(pluginId);
      if (!enabled) throw new PluginManagerError("not_active", `Plugin ${pluginId} must be enabled before it can run`);
      const record = await this.requireInstalled(pluginId, enabled.version);
      const { manifest, artifacts } = await this.verifyStoredPlugin(record.key, true);
      const entrypoint = artifacts.get(manifest.entrypoint);
      if (!entrypoint) throw new PluginManagerError("invalid_plugin", "Verified plugin entrypoint is missing");
      const runtime = await BrowserPluginRuntime.create(manifest, Uint8Array.from(entrypoint));
      try {
        await runtime.start({ context: enabled.context, userGrants: enabled.grants, hostAllowed: enabled.hostAllowed });
        const instance = { version: enabled.version, runtime };
        this.active.set(pluginId, instance);
        return instance;
      } catch (error) {
        await runtime.destroy().catch(() => undefined);
        throw error;
      }
    });
  }

  disable(pluginId: string, version?: string): Promise<void> {
    return this.serialize(() => this.disableInternal(pluginId, version));
  }

  private async disableInternal(pluginId: string, version?: string): Promise<void> {
    const active = this.active.get(pluginId);
    const enabled = this.enabled.get(pluginId);
    if (version && enabled && version !== enabled.version) throw new PluginManagerError("not_active", `Plugin ${pluginId}@${version} is not enabled`);
    if (!active && !enabled) return;
    this.active.delete(pluginId);
    this.enabled.delete(pluginId);
    if (active) await active.runtime.destroy();
  }

  /** Reverts the active pin to the last verified version retained by the Host. */
  rollback(pluginId: string): Promise<InstalledPlugin[]> {
    return this.serialize(() => this.rollbackInternal(pluginId));
  }

  private async rollbackInternal(pluginId: string): Promise<InstalledPlugin[]> {
    this.assertOpen();
    await this.disableInternal(pluginId);
    const previous = await this.store.getState(previousStateKey(pluginId));
    if (!previous) throw new PluginManagerError("not_installed", `Plugin ${pluginId} has no retained version to roll back to`);
    const record = await this.requireInstalled(pluginId, previous);
    await this.verifyStoredPlugin(record.key, true);
    const current = await this.store.getState(activeStateKey(pluginId));
    await this.store.setState(activeStateKey(pluginId), previous);
    await this.store.setState(previousStateKey(pluginId), current);
    return this.installed();
  }

  uninstall(pluginId: string, version: string): Promise<InstalledPlugin[]> {
    return this.serialize(() => this.uninstallInternal(pluginId, version));
  }

  private async uninstallInternal(pluginId: string, version: string): Promise<InstalledPlugin[]> {
    this.assertOpen();
    const key = pluginKey(pluginId, version);
    const records = await this.store.listPlugins();
    const dependent = records.find(record => record.key !== key && record.resolvedDependencies.some(dependency => dependency.id === pluginId && dependency.version === version));
    if (dependent) throw new PluginManagerError("dependency_in_use", `${dependent.id}@${dependent.version} requires ${pluginId}@${version}`);
    await this.disableInternal(pluginId, version);
    await this.store.deletePlugin(key);
    if (await this.store.getState(activeStateKey(pluginId)) === version) {
      const previous = await this.store.getState(previousStateKey(pluginId));
      const previousRecord = previous ? await this.store.getPlugin(pluginKey(pluginId, previous)) : undefined;
      if (previousRecord) {
        await this.store.setState(activeStateKey(pluginId), previous);
        await this.store.setState(previousStateKey(pluginId), undefined);
      } else {
        await this.store.setState(activeStateKey(pluginId), undefined);
        await this.store.setState(previousStateKey(pluginId), undefined);
      }
    }
    if (await this.store.getState(previousStateKey(pluginId)) === version) await this.store.setState(previousStateKey(pluginId), undefined);
    return this.installed();
  }

  dispose(): Promise<void> {
    return this.serialize(async () => {
      if (this.closed) return;
      this.closed = true;
      const live = [...this.active.values()];
      this.active.clear();
      this.enabled.clear();
      await Promise.all(live.map(item => item.runtime.destroy()));
    });
  }

  private async resolveDependencies(
    registry: SignedRegistrySnapshot,
    trust: PluginRegistryTrust,
    entry: PluginRegistryEntry,
    stack: readonly string[],
    result: Map<string, ResolvedEntry>,
  ): Promise<readonly { readonly id: string; readonly range: string; readonly version: string }[]> {
    const key = pluginKey(entry.id, entry.version);
    if (stack.includes(key)) throw new PluginManagerError("invalid_plugin", `Plugin dependency cycle includes ${key}`);
    const previous = result.get(key);
    if (previous) return previous.dependencies;
    const nextStack = [...stack, key];
    const dependencies: Array<{ id: string; range: string; version: string }> = [];
    for (const dependency of entry.dependencies) {
      const installed = (await this.store.listPlugins())
        .filter(record => record.id === dependency.id && record.registryUrl === trust.url && satisfiesVersion(record.version, dependency.range))
        .sort((a, b) => compareVersions(b.version, a.version))[0];
      if (installed) {
        await this.verifyStoredPlugin(installed.key, true);
        dependencies.push({ id: dependency.id, range: dependency.range, version: installed.version });
        continue;
      }
      const candidate = registry.document.plugins
        .filter(item => item.id === dependency.id && satisfiesVersion(item.version, dependency.range))
        .sort((a, b) => compareVersions(b.version, a.version))[0];
      if (!candidate) throw new PluginManagerError("invalid_plugin", `No version of dependency ${dependency.id} satisfies ${dependency.range}`);
      await this.resolveDependencies(registry, trust, candidate, nextStack, result);
      dependencies.push({ id: dependency.id, range: dependency.range, version: candidate.version });
    }
    result.set(key, { registry, entry, trust, dependencies: Object.freeze(dependencies) });
    return dependencies;
  }

  private async downloadPlugin(item: PreparedPlugin): Promise<InstalledPluginRecord> {
    const { registry, entry, trust } = item.resolved;
    const { manifestBytes, manifest } = item;
    const artifacts: Array<{ path: string; bytes: Uint8Array }> = [];
    let total = 0;
    for (const descriptor of manifest.artifacts) {
      if (descriptor.bytes > MAX_ARTIFACT_BYTES) throw new PluginManagerError("invalid_plugin", `Artifact ${descriptor.path} exceeds the Host download limit`);
      const url = registryArtifactURL(descriptor.path, registry, trust);
      const bytes = await this.fetchBytes(url, descriptor.bytes);
      await verifyPluginArtifact(manifest, descriptor.path, bytes);
      total += bytes.byteLength;
      if (total > 512 * 1024 * 1024) throw new PluginManagerError("invalid_plugin", "Plugin bundle exceeds the Host download limit");
      artifacts.push({ path: descriptor.path, bytes });
    }
    return Object.freeze({
      key: pluginKey(entry.id, entry.version), id: entry.id, version: entry.version,
      registryUrl: registry.url, registryDigest: registry.digest,
      manifestBytes, manifestSha256: entry.manifestSha256,
      manifestSignature: entry.manifestSignature, publisherKey: entry.publisherKey,
      dependencies: entry.dependencies.map(dependency => ({ ...dependency })),
      resolvedDependencies: item.resolved.dependencies.map(dependency => ({ ...dependency })), artifacts,
      installedAt: Date.now(),
    });
  }

  private async verifyStoredPlugin(
    key: string,
    withArtifacts = false,
    allowRevoked = false,
    visiting = new Set<string>(),
  ): Promise<{ manifest: PluginManifestV1; artifacts: Map<string, Uint8Array>; revoked: boolean }> {
    if (visiting.has(key)) throw new PluginManagerError("invalid_plugin", `Installed plugin dependency cycle includes ${key}`);
    visiting.add(key);
    const record = await this.requireInstalledByKey(key);
    const trust = this.requireTrust(record.registryUrl);
    const snapshot = await this.store.getRegistry(record.registryUrl, record.registryDigest);
    if (!snapshot) throw new PluginManagerError("invalid_plugin", "Signed registry proof for this installed version is missing");
    const registry = await admitRegistry(snapshot.bytes, snapshot.signature, trust);
    if (registry.digest !== record.registryDigest) throw new PluginManagerError("invalid_plugin", "Stored registry digest does not match its signed bytes");
    const entry = registryManifestEntry(registry, record.id, record.version);
    if (!entry || entry.manifestSha256 !== record.manifestSha256 || entry.manifestSignature !== record.manifestSignature || entry.publisherKey !== record.publisherKey) {
      throw new PluginManagerError("invalid_plugin", "Installed plugin publisher proof does not match the signed registry");
    }
    const latestDigest = await this.store.getState(latestRegistryStateKey(record.registryUrl));
    let revoked = false;
    if (latestDigest && latestDigest !== record.registryDigest) {
      const latestSnapshot = await this.store.getRegistry(record.registryUrl, latestDigest);
      if (!latestSnapshot) throw new PluginManagerError("invalid_plugin", "Latest signed registry proof is missing");
      const latest = await admitRegistry(latestSnapshot.bytes, latestSnapshot.signature, trust);
      const latestEntry = registryManifestEntry(latest, record.id, record.version);
      if (!latestEntry || latestEntry.manifestSha256 !== entry.manifestSha256 ||
          latestEntry.manifestSignature !== entry.manifestSignature || latestEntry.publisherKey !== entry.publisherKey ||
          latestEntry.dependencies.length !== record.dependencies.length || latestEntry.dependencies.some((dependency, index) => {
            const stored = record.dependencies[index];
            return !stored || stored.id !== dependency.id || stored.range !== dependency.range;
          })) {
        if (!allowRevoked) throw new PluginManagerError("invalid_plugin", `Plugin ${record.id}@${record.version} was removed or revoked by the latest signed registry`);
        revoked = true;
      }
    }
    if (record.dependencies.length !== entry.dependencies.length || entry.dependencies.some((dependency, index) => {
      const stored = record.dependencies[index];
      return !stored || stored.id !== dependency.id || stored.range !== dependency.range;
    }) || record.resolvedDependencies.length !== entry.dependencies.length || record.resolvedDependencies.some((dependency, index) => {
      const declared = entry.dependencies[index];
      return !declared || dependency.id !== declared.id || dependency.range !== declared.range ||
        !satisfiesVersion(dependency.version, declared.range) || !registryManifestEntry(registry, dependency.id, dependency.version);
    })) {
      throw new PluginManagerError("invalid_plugin", "Installed plugin dependency lock differs from signed registry metadata");
    }
    for (const dependency of record.resolvedDependencies) {
      const dependencyRecord = await this.store.getPlugin(pluginKey(dependency.id, dependency.version));
      if (!dependencyRecord) {
        throw new PluginManagerError("invalid_plugin", `Locked dependency ${dependency.id}@${dependency.version} is not installed`);
      }
      await this.verifyStoredPlugin(dependencyRecord.key, withArtifacts, false, visiting);
    }
    const manifest = await admitRegistryManifest(record.manifestBytes, entry);
    const artifactMap = new Map<string, Uint8Array>();
    if (withArtifacts) {
      for (const descriptor of manifest.artifacts) {
        const artifact = record.artifacts.find(item => item.path === descriptor.path);
        if (!artifact) throw new PluginManagerError("invalid_plugin", `Installed plugin artifact ${descriptor.path} is missing`);
        await verifyPluginArtifact(manifest, descriptor.path, artifact.bytes);
        artifactMap.set(descriptor.path, Uint8Array.from(artifact.bytes));
      }
      if (artifactMap.size !== manifest.artifacts.length || record.artifacts.length !== manifest.artifacts.length) {
        throw new PluginManagerError("invalid_plugin", "Installed plugin contains unexpected artifacts");
      }
    }
    visiting.delete(key);
    return { manifest, artifacts: artifactMap, revoked };
  }

  private async fetchRegistry(trust: PluginRegistryTrust): Promise<SignedRegistrySnapshot> {
    const raw = await this.fetchBytes(trust.url, 1024 * 1024);
    const signature = await this.fetchBytes(registrySignatureUrl(trust.url), MAX_SIGNATURE_BYTES);
    const registry = await admitRegistry(raw, signature, trust);
    const latestDigest = await this.store.getState(latestRegistryStateKey(trust.url));
    if (latestDigest) {
      const latestSnapshot = await this.store.getRegistry(trust.url, latestDigest);
      if (!latestSnapshot) throw new PluginManagerError("invalid_plugin", "Latest signed registry proof is missing");
      const latest = await admitRegistry(latestSnapshot.bytes, latestSnapshot.signature, trust);
      if (latest.digest !== latestDigest) throw new PluginManagerError("invalid_plugin", "Latest signed registry digest does not match its stored state");
      if (registry.digest !== latest.digest) {
        const order = compareVersions(registry.document.version, latest.document.version);
        if (order < 0) throw new PluginManagerError("invalid_plugin", "Signed registry version rollback is rejected");
        if (order === 0) throw new PluginManagerError("invalid_plugin", "Conflicting signed registry bytes reuse an observed registry version");
      }
    }
    await this.store.putRegistry(registry);
    await this.store.setState(latestRegistryStateKey(trust.url), registry.digest);
    return registry;
  }

  private async enforceRegistryRevocations(registry: SignedRegistrySnapshot): Promise<void> {
    for (const [pluginId, active] of [...this.active]) {
      const record = await this.store.getPlugin(pluginKey(pluginId, active.version));
      if (!record || record.registryUrl !== registry.url) continue;
      try { await this.verifyStoredPlugin(record.key, true); }
      catch {
        this.active.delete(pluginId);
        await active.runtime.destroy();
      }
    }
  }

  private async fetchBytes(url: URL | string, limit: number): Promise<Uint8Array> {
    let response: Response;
    try {
      response = await this.fetcher(String(url), { method: "GET", mode: "cors", credentials: "omit", redirect: "error", cache: "no-store" });
    } catch (error) {
      throw new PluginManagerError("network_error", error instanceof Error ? error.message : "Plugin distribution request failed");
    }
    return boundedBytes(response, limit);
  }

  private requireTrust(url: string): PluginRegistryTrust {
    const trust = this.trusts.get(url);
    if (!trust) throw new PluginManagerError("invalid_plugin", `Registry ${url} is not pinned by the Host`);
    return trust;
  }

  private assertOpen(): void {
    if (this.closed) throw new PluginManagerError("not_active", "Plugin manager has been disposed");
  }

  private async requireInstalled(pluginId: string, version: string): Promise<InstalledPluginRecord> {
    return this.requireInstalledByKey(pluginKey(pluginId, version));
  }

  private async requireInstalledByKey(key: string): Promise<InstalledPluginRecord> {
    const record = await this.store.getPlugin(key);
    if (!record) throw new PluginManagerError("not_installed", `Plugin ${key} is not installed`);
    if (record.key !== key || pluginKey(record.id, record.version) !== key || !record.registryUrl || !record.registryDigest || !(record.manifestBytes instanceof Uint8Array)) {
      throw new PluginManagerError("invalid_plugin", "Installed plugin record is malformed");
    }
    return record;
  }

  private async currentRecord(pluginId: string): Promise<InstalledPluginRecord | undefined> {
    const version = await this.store.getState(activeStateKey(pluginId));
    return version ? this.store.getPlugin(pluginKey(pluginId, version)) : undefined;
  }

  private serialize<T>(action: () => Promise<T>): Promise<T> {
    const next = this.operation.then(action, action);
    this.operation = next.then(() => undefined, () => undefined);
    return next;
  }
}
