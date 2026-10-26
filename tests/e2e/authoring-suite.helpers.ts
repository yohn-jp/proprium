import { createHash, createPublicKey, verify } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";
import type { WorkspaceIdentity } from "../../app/src/browser/proprium/git/index.js";

export const officialAuthoringPluginIds = [
  "proprium.narrative", "proprium.knowledge", "proprium.research", "proprium.paired-writing",
  "proprium.diagnostics", "proprium.speaker", "proprium.semantic", "proprium.publishing",
] as const;

interface RegistryEntry {
  readonly id: string;
  readonly version: string;
  readonly manifestPath: string;
  readonly manifestSha256: string;
  readonly manifestSignature: string;
  readonly publisherKey: string;
  readonly dependencies: readonly { readonly id: string; readonly range: string }[];
}
interface RegistryDocument {
  readonly schema: "proprium.registry/v1";
  readonly id: string;
  readonly version: string;
  readonly artifactBase: string;
  readonly plugins: readonly RegistryEntry[];
}
interface PluginArtifact {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly mediaType: string;
}
interface PluginManifest {
  readonly schema: "proprium.plugin/v2";
  readonly id: string;
  readonly version: string;
  readonly abi: "proprium.component/v2";
  readonly entrypoint: string;
  readonly capabilities: readonly string[];
  readonly artifacts: readonly PluginArtifact[];
  readonly actions: readonly { readonly action_id: string }[];
  readonly ui: readonly { readonly id: string; readonly title: string; readonly kind: string }[];
  readonly asset_groups: readonly { readonly manifest_path: string; readonly sha256: string; readonly bytes: number }[];
}

export interface VerifiedAuthoringPlugin {
  readonly id: typeof officialAuthoringPluginIds[number];
  readonly version: string;
  readonly manifestPath: string;
  readonly manifestDigest: string;
  readonly pluginDigest: string;
  readonly capabilities: readonly string[];
  readonly actionIds: readonly string[];
  readonly surfaces: readonly { readonly id: string; readonly title: string; readonly kind: string }[];
}

export interface VerifiedAuthoringRelease {
  readonly directory: string;
  readonly registry: RegistryDocument;
  readonly registryDigest: string;
  readonly registryBytes: Buffer;
  readonly registrySignature: Buffer;
  readonly pinnedPublicKey: Buffer;
  readonly registryUrl: string;
  readonly plugins: readonly VerifiedAuthoringPlugin[];
  readonly allowedArtifactPaths: ReadonlySet<string>;
}

export interface SyntheticWorkReceipt {
  readonly workspace_name: string;
  readonly local_workspace_id: string;
  readonly branch: string;
  readonly scene_count: number;
  readonly file_count: number;
  readonly total_bytes: number;
  readonly long_body_path: string;
  readonly long_body_bytes: number;
  readonly long_body_sha256: string;
}

declare global {
  interface Window {
    propriumHostOpenLocalWorkspace?: (entry: { identity: WorkspaceIdentity; title: string; lastOpened: number }) => Promise<void>;
  }
}

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const ed25519Prefix = Buffer.from("302a300506032b6570032100", "hex");
const stableSemver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;

function compareStableSemver(left: string, right: string): number {
  const a = stableSemver.exec(left);
  const b = stableSemver.exec(right);
  if (!a || !b) throw new Error("Authoring registry selection accepts stable SemVer releases only.");
  for (let index = 1; index <= 3; index += 1) {
    const delta = Number(a[index]) - Number(b[index]);
    if (delta) return delta;
  }
  return 0;
}

function parseJson(bytes: Buffer, label: string): unknown {
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new Error(`${label} is not valid UTF-8 JSON.`); }
}

function publicKey(raw: Uint8Array, label: string) {
  if (raw.byteLength !== 32) throw new Error(`${label} is not a 32-byte Ed25519 public key.`);
  return createPublicKey({ key: Buffer.concat([ed25519Prefix, Buffer.from(raw)]), format: "der", type: "spki" });
}

function safeRelativePath(path: string): boolean {
  return path.length > 0 && !path.startsWith("/") && !path.includes("\\") && !path.includes("\0") &&
    /^[A-Za-z0-9._/-]+$/u.test(path) && path.split("/").every(segment => segment && segment !== "." && segment !== "..");
}

async function readReleaseFile(directory: string, path: string): Promise<Buffer> {
  if (!safeRelativePath(path)) throw new Error(`Unsafe authoring artifact path: ${path}`);
  const filePath = resolve(directory, ...path.split("/"));
  const pathFromRoot = relative(directory, filePath);
  if (pathFromRoot === ".." || pathFromRoot.startsWith(`..${sep}`) || pathFromRoot.startsWith(sep)) {
    throw new Error(`Authoring artifact escaped its release directory: ${path}`);
  }
  const [rootReal, fileReal] = await Promise.all([realpath(directory), realpath(filePath)]);
  const realRelativePath = relative(rootReal, fileReal);
  const fileStat = await lstat(filePath);
  if (realRelativePath === ".." || realRelativePath.startsWith(`..${sep}`) || realRelativePath.startsWith(sep) ||
      !fileStat.isFile() || fileStat.isSymbolicLink()) throw new Error(`Authoring artifact is not a regular in-tree file: ${path}`);
  return readFile(fileReal);
}

function requireDigest(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) throw new Error(`${label} must be a lowercase SHA-256 digest.`);
}

/** Reads the production release directory and independently verifies its signed registry, manifests and WASM Components. */
export async function loadSignedAuthoringRelease(directoryValue: string, publicKeyValue: string, registryUrl: string): Promise<VerifiedAuthoringRelease> {
  if (!directoryValue) throw new Error("Set PROPRIUM_AUTHORING_REGISTRY_DIR to the actual signed authoring registry output directory.");
  if (!publicKeyValue) throw new Error("Set PROPRIUM_AUTHORING_REGISTRY_PUBLIC_KEY to the separately pinned Ed25519 registry public key.");
  const directory = resolve(directoryValue);
  const pinnedPublicKey = Buffer.from(publicKeyValue, "base64");
  const registrySigner = publicKey(pinnedPublicKey, "Pinned registry key");
  const registryBytes = await readReleaseFile(directory, "registry.json");
  const registrySignature = await readReleaseFile(directory, "registry.json.sig");
  if (registrySignature.byteLength !== 64 || !verify(null, registryBytes, registrySigner, registrySignature)) {
    throw new Error("The authoring registry signature does not match the separately pinned public key.");
  }
  const value = parseJson(registryBytes, "Signed registry") as Partial<RegistryDocument>;
  if (value.schema !== "proprium.registry/v1" || typeof value.id !== "string" || typeof value.version !== "string" ||
      !stableSemver.test(value.version) || typeof value.artifactBase !== "string" || !Array.isArray(value.plugins)) {
    throw new Error("The signed authoring registry has an unsupported identity or schema.");
  }
  const artifactBase = new URL(value.artifactBase);
  const loopbackHttp = artifactBase.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(artifactBase.hostname);
  if (artifactBase.href !== value.artifactBase || !artifactBase.pathname.endsWith("/") || artifactBase.search || artifactBase.hash ||
      (!loopbackHttp && artifactBase.protocol !== "https:")) throw new Error("The signed artifact base must be a credential-free HTTPS directory URL.");

  const releaseEntries = new Map<string, RegistryEntry>();
  const seenVersions = new Set<string>();
  for (const entry of value.plugins) {
    if (!entry || typeof entry.id !== "string" || typeof entry.version !== "string" || !stableSemver.test(entry.version)) continue;
    if (!officialAuthoringPluginIds.includes(entry.id as typeof officialAuthoringPluginIds[number])) continue;
    const releaseId = `${entry.id}@${entry.version}`;
    if (seenVersions.has(releaseId)) throw new Error(`Signed registry repeats ${releaseId}.`);
    seenVersions.add(releaseId);
    const previous = releaseEntries.get(entry.id);
    if (!previous || compareStableSemver(entry.version, previous.version) > 0) releaseEntries.set(entry.id, entry);
  }
  const missing = officialAuthoringPluginIds.filter(id => !releaseEntries.has(id));
  if (missing.length) throw new Error(`The signed product registry is missing official authoring releases: ${missing.join(", ")}`);

  const allowedArtifactPaths = new Set<string>();
  const verifiedPlugins: VerifiedAuthoringPlugin[] = [];
  for (const id of officialAuthoringPluginIds) {
    const entry = releaseEntries.get(id)!;
    requireDigest(entry.manifestSha256, `${id} manifest digest`);
    if (!safeRelativePath(entry.manifestPath) || !entry.manifestPath.includes(`/manifest/${entry.manifestSha256}.json`)) {
      throw new Error(`${id}@${entry.version} manifest path is not content addressed.`);
    }
    allowedArtifactPaths.add(entry.manifestPath);
    const manifestBytes = await readReleaseFile(directory, entry.manifestPath);
    if (sha256(manifestBytes) !== entry.manifestSha256) throw new Error(`${id}@${entry.version} manifest digest mismatch.`);
    const publisherRawKey = Buffer.from(entry.publisherKey, "base64");
    const publisherSignature = Buffer.from(entry.manifestSignature, "base64");
    if (publisherSignature.byteLength !== 64 || !verify(null, manifestBytes, publicKey(publisherRawKey, `${id} publisher key`), publisherSignature)) {
      throw new Error(`${id}@${entry.version} publisher signature verification failed.`);
    }
    const manifest = parseJson(manifestBytes, `${id} signed manifest`) as Partial<PluginManifest>;
    if (manifest.schema !== "proprium.plugin/v2" || manifest.id !== id || manifest.version !== entry.version ||
        manifest.abi !== "proprium.component/v2" || typeof manifest.entrypoint !== "string" ||
        !Array.isArray(manifest.capabilities) || !Array.isArray(manifest.artifacts) || !Array.isArray(manifest.actions) ||
        !Array.isArray(manifest.ui) || !Array.isArray(manifest.asset_groups)) {
      throw new Error(`${id}@${entry.version} is not a signed v2 authoring plugin.`);
    }
    const actionIds = manifest.actions.map(action => action?.action_id);
    if (!actionIds.length || actionIds.some(actionId => typeof actionId !== "string" || !actionId) || new Set(actionIds).size !== actionIds.length) {
      throw new Error(`${id}@${entry.version} has missing or duplicate typed action IDs.`);
    }
    const component = manifest.artifacts.find(artifact => artifact.path === manifest.entrypoint && artifact.mediaType === "application/wasm");
    if (!component) throw new Error(`${id}@${entry.version} has no WIT Component entrypoint artifact.`);
    const artifactBytesByPath = new Map<string, Buffer>();
    for (const artifact of manifest.artifacts) {
      requireDigest(artifact.sha256, `${id} artifact digest`);
      if (!safeRelativePath(artifact.path) || !artifact.path.includes(`/${artifact.sha256}/`)) throw new Error(`${id} artifact path is not content addressed.`);
      const bytes = await readReleaseFile(directory, artifact.path);
      if (bytes.byteLength !== artifact.bytes || sha256(bytes) !== artifact.sha256) throw new Error(`${id} artifact digest/length mismatch: ${artifact.path}`);
      allowedArtifactPaths.add(artifact.path);
      artifactBytesByPath.set(artifact.path, bytes);
    }
    const componentBytes = artifactBytesByPath.get(component.path)!;
    if (componentBytes.byteLength < 8 || !componentBytes.subarray(0, 4).equals(Buffer.from([0x00, 0x61, 0x73, 0x6d]))) {
      throw new Error(`${id}@${entry.version} entrypoint is not a WebAssembly Component binary.`);
    }
    for (const group of manifest.asset_groups) {
      requireDigest(group.sha256, `${id} asset manifest digest`);
      const assetManifestBytes = await readReleaseFile(directory, group.manifest_path);
      if (assetManifestBytes.byteLength !== group.bytes || sha256(assetManifestBytes) !== group.sha256) {
        throw new Error(`${id} signed asset-group manifest does not match its digest: ${group.manifest_path}`);
      }
      allowedArtifactPaths.add(group.manifest_path);
      const assetManifest = parseJson(assetManifestBytes, `${id} asset manifest`) as { files?: Array<{ chunks?: Array<{ path: string }> }> };
      for (const file of assetManifest.files ?? []) for (const chunk of file.chunks ?? []) {
        if (!safeRelativePath(chunk.path)) throw new Error(`${id} asset chunk path is unsafe.`);
        allowedArtifactPaths.add(chunk.path);
      }
    }
    verifiedPlugins.push({ id, version: entry.version, manifestPath: entry.manifestPath,
      manifestDigest: entry.manifestSha256, pluginDigest: component.sha256,
      capabilities: [...manifest.capabilities], actionIds: actionIds as string[],
      surfaces: manifest.ui.map(surface => ({ id: surface.id, title: surface.title, kind: surface.kind })) });
  }
  const parsedRegistryUrl = new URL(registryUrl);
  if (parsedRegistryUrl.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(parsedRegistryUrl.hostname) ||
      !parsedRegistryUrl.pathname.endsWith("/plugin-fixture/registry.json")) {
    throw new Error("The authoring Playwright registry URL must be the test-local /plugin-fixture/registry.json endpoint.");
  }
  return { directory, registry: value as RegistryDocument, registryDigest: sha256(registryBytes), registryBytes,
    registrySignature, pinnedPublicKey, registryUrl: parsedRegistryUrl.href, plugins: verifiedPlugins, allowedArtifactPaths };
}

function artifactMime(path: string): string {
  if (path.endsWith(".json")) return "application/json";
  if (path.endsWith(".wasm")) return "application/wasm";
  return "application/octet-stream";
}

/** Serves only the files referenced by the already verified real release; no test-generated signature or WASM enters this route. */
export async function routeSignedAuthoringRelease(page: Page, release: VerifiedAuthoringRelease): Promise<void> {
  const artifactBase = new URL(release.registry.artifactBase);
  const hostOrigin = new URL(release.registryUrl).origin;
  await page.route("**/*", async route => {
    const requestUrl = new URL(route.request().url());
    if (requestUrl.href === release.registryUrl) {
      return route.fulfill({ status: 200, contentType: "application/json", body: release.registryBytes,
        headers: { "cache-control": "no-store" } });
    }
    if (requestUrl.href === `${release.registryUrl}.sig`) {
      return route.fulfill({ status: 200, contentType: "application/octet-stream", body: release.registrySignature,
        headers: { "cache-control": "no-store" } });
    }
    if (requestUrl.origin === artifactBase.origin && requestUrl.pathname.startsWith(artifactBase.pathname)) {
      let relativePath: string;
      try { relativePath = decodeURIComponent(requestUrl.pathname.slice(artifactBase.pathname.length)); }
      catch { return route.fulfill({ status: 400 }); }
      if (!release.allowedArtifactPaths.has(relativePath)) return route.fulfill({ status: 404 });
      try {
        const body = await readReleaseFile(release.directory, relativePath);
        return route.fulfill({ status: 200, contentType: artifactMime(relativePath), body,
          headers: { "access-control-allow-origin": hostOrigin, "cache-control": "public, max-age=300", vary: "Origin" } });
      } catch { return route.fulfill({ status: 404 }); }
    }
    return route.continue();
  });
}

/** Seeds the real Host Browser Git worktree with the Canon's oversized multi-volume synthetic fixture. */
export async function seedSyntheticAuthoringWork(page: Page, workspaceName: string): Promise<SyntheticWorkReceipt> {
  return page.evaluate(async workspaceName => {
    const rawRecent = localStorage.getItem("proprium.host.recent-workspaces.v1");
    if (!rawRecent) throw new Error("The normal Host UI did not persist its newly created local workspace.");
    const recent = JSON.parse(rawRecent) as Array<{ identity: WorkspaceIdentity; title: string; lastOpened: number }>;
    const entry = recent.find(item => item.title === workspaceName);
    if (!entry || typeof entry.identity?.localWorkspaceId !== "string") throw new Error("The normal Host UI did not bind a local workspace identity.");
    if (!window.propriumHostOpenLocalWorkspace) throw new Error("The Host's test-only local workspace reload adapter is unavailable; set VITE_PROPRIUM_E2E=true.");
    const { BrowserLocalGit } = await import(/* @vite-ignore */ new URL("/src/browser/proprium/git/index.ts", location.origin).href);
    const git = new BrowserLocalGit(entry.identity);
    await git.init();
    const changes: Array<{ path: string; content: Uint8Array; expectedRevision: { oid: null } }> = [];
    const paragraphs = "本文は合成フィクスチャです。漢字《かんじ》を含みます。\r\n".repeat(128);
    const longBody = `${paragraphs.repeat(14)}最終行\r\n`;
    const longBodyPath = "manuscript/unusual-location/long-scene-body.md";
    const volumeIds = ["vol-one", "vol-two", "vol-three"];
    const scenesPerVolume = [101, 101, 99];
    let sceneIndex = 0;
    for (let volumeIndex = 0; volumeIndex < volumeIds.length; volumeIndex += 1) {
      const volumeId = volumeIds[volumeIndex]!;
      changes.push({ path: `plot/volumes/${volumeId}/volume.yaml`,
        content: new TextEncoder().encode(`id: ${volumeId}\r\ntype: volume\r\ntitle: Synthetic Volume ${volumeIndex + 1}\r\norder: ${volumeIndex + 1}\r\nunknown_volume_field: preserve-me\r\n`),
        expectedRevision: { oid: null } });
      const chapterCount = volumeIndex === 2 ? 3 : 4;
      const chapterSceneCounts = Array.from({ length: chapterCount }, (_, index) => Math.floor(scenesPerVolume[volumeIndex]! / chapterCount) + (index < scenesPerVolume[volumeIndex]! % chapterCount ? 1 : 0));
      for (let chapterIndex = 0; chapterIndex < chapterCount; chapterIndex += 1) {
        const chapterId = `chapter-${volumeIndex + 1}-${chapterIndex + 1}`;
        changes.push({ path: `plot/volumes/${volumeId}/chapters/${chapterId}/chapter.yaml`,
          content: new TextEncoder().encode(`id: ${chapterId}\r\ntype: chapter\r\ntitle: Synthetic Chapter ${chapterIndex + 1}\r\nvolume: ${volumeId}\r\norder: ${chapterIndex + 1}\r\nunknown_chapter_field: preserve-me\r\n`),
          expectedRevision: { oid: null } });
        for (let inChapter = 0; inChapter < chapterSceneCounts[chapterIndex]!; inChapter += 1) {
          const sceneId = `scene-${String(sceneIndex + 1).padStart(3, "0")}`;
          const manuscriptPath = sceneIndex === 0 ? longBodyPath : `manuscript/${volumeId}/${chapterId}/body-${sceneId}.md`;
          const metadata = `id: ${sceneId}\r\ntype: scene\r\ntitle: Synthetic Scene ${sceneIndex + 1}\r\nvolume: ${volumeId}\r\nchapter: ${chapterId}\r\norder: ${inChapter + 1}\r\nmanuscript: ${manuscriptPath}\r\nunknown_scene_field: keep-${sceneIndex}\r\n`;
          changes.push({ path: `plot/volumes/${volumeId}/chapters/${chapterId}/scenes/${sceneId}.yaml`,
            content: new TextEncoder().encode(metadata), expectedRevision: { oid: null } });
          changes.push({ path: manuscriptPath, content: new TextEncoder().encode(sceneIndex === 0 ? longBody : paragraphs), expectedRevision: { oid: null } });
          sceneIndex += 1;
        }
      }
    }
    if (sceneIndex !== 301) throw new Error(`Synthetic work generated ${sceneIndex} scenes instead of 301.`);
    const totalBytes = changes.reduce((sum, change) => sum + change.content.byteLength, 0);
    for (let index = 0; index < changes.length; index += 256) await git.applyChanges(changes.slice(index, index + 256));
    const persistedFiles = await git.listFiles();
    const longBodyRead = await git.read(longBodyPath);
    git.close();
    if (!longBodyRead.data) throw new Error("Synthetic long manuscript was not persisted to Browser Git.");
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", longBodyRead.data));
    const longBodySha256 = [...digest].map(byte => byte.toString(16).padStart(2, "0")).join("");
    await window.propriumHostOpenLocalWorkspace(entry);
    return {
      workspace_name: workspaceName,
      local_workspace_id: entry.identity.localWorkspaceId as string,
      branch: typeof entry.identity.branch === "string" ? entry.identity.branch : "main",
      scene_count: sceneIndex,
      file_count: persistedFiles.length,
      total_bytes: totalBytes,
      long_body_path: longBodyPath,
      long_body_bytes: longBodyRead.data.byteLength,
      long_body_sha256: longBodySha256,
    };
  }, workspaceName);
}

/** Re-reads fixture bytes from the same production Browser Git worker after a page reload. */
export async function inspectSyntheticAuthoringWork(page: Page, workspaceName: string, longBodyPath: string): Promise<{ file_count: number; scene_count: number; long_body_bytes: number; long_body_sha256: string }> {
  const persisted = await page.evaluate(async ({ workspaceName, longBodyPath }) => {
    const rawRecent = localStorage.getItem("proprium.host.recent-workspaces.v1");
    if (!rawRecent) throw new Error("Host workspace identity did not survive reload.");
    const recent = JSON.parse(rawRecent) as Array<{ identity: WorkspaceIdentity; title: string }>;
    const entry = recent.find(item => item.title === workspaceName);
    if (!entry) throw new Error("Synthetic workspace was not in the Host's persisted recent-workspace list.");
    const { BrowserLocalGit } = await import(/* @vite-ignore */ new URL("/src/browser/proprium/git/index.ts", location.origin).href);
    const git = new BrowserLocalGit(entry.identity);
    await git.init();
    const files = await git.listFiles() as Array<{ path: string }>;
    const longBody = await git.read(longBodyPath);
    git.close();
    if (!longBody.data) throw new Error("Host Browser Git could not re-read the long manuscript after reload.");
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", longBody.data));
    return { file_count: files.length,
      scene_count: files.filter(item => /^plot\/volumes\/[^/]+\/chapters\/[^/]+\/scenes\/[^/]+\.yaml$/u.test(item.path)).length,
      long_body_bytes: longBody.data.byteLength,
      long_body_sha256: [...digest].map(byte => byte.toString(16).padStart(2, "0")).join("") };
  }, { workspaceName, longBodyPath });
  expect(persisted.scene_count).toBe(301);
  expect(persisted.file_count).toBeGreaterThan(256);
  expect(persisted.long_body_bytes).toBeGreaterThan(130 * 1024);
  return persisted;
}
