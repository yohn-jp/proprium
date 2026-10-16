import { createHash, randomUUID } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import {
  MAX_PROPOSAL_EVIDENCE_BYTES,
  assertChangeOperation,
  assertProjectPath,
  snapshotKey,
  type Approval,
  type ChangeOperation,
  type ChangeProposal,
  type CheckpointReceipt,
  type FileChange,
  type FileRevision,
  type MutationCoordinator,
  type ProposalEvidence,
  type ReconcileResult,
  type RemoteObservation,
  type RepositoryIdentity,
  type SnapshotId,
  type SnapshotReader,
} from "@scriptorium/contracts";

const execFile = promisify(execFileCallback);
const DEFAULT_BRANCH = "main";
const MAX_HISTORY = 100;
const GIT_TIMEOUT_MS = 120_000;

export interface Project {
  id: string;
  url: string;
  branch: string;
}

export interface TreeScene {
  id: string;
  title: string;
}

export interface TreeChapter {
  id: string;
  title: string;
  scenes: TreeScene[];
}

export interface TreeVolume {
  id: string;
  title: string;
  chapters: TreeChapter[];
}

export interface Tree {
  title: string;
  volumes: TreeVolume[];
}

export interface Scene {
  id: string;
  title: string;
  text: string;
  revision: string;
}

export interface Commit {
  hash: string;
  date: string;
  message: string;
}

export interface ManuscriptSnapshotMeta {
  id: string;
  sceneId: string;
  manuscriptId: string;
  createdAt: number;
  charCount: number;
  source: "git";
  branch?: string;
  label?: string;
  trigger?: "manual" | "submit" | "idle";
}

export interface ManuscriptSnapshot extends ManuscriptSnapshotMeta {
  /** Legacy editor body with YAML frontmatter removed. */
  body: string;
  /** Exact historical Markdown bytes decoded as UTF-8, including frontmatter. */
  document: { path: string; content: string; revision: string };
}

export interface ProposalStatus {
  proposal: ChangeProposal;
  state: "proposed" | "partially_approved" | "approved" | "checkpointed";
  approvedOperationIds: string[];
  checkpoints: CheckpointReceipt[];
  publishedOperationIds: string[];
  stale: boolean;
}

export interface LiteralSearchResult {
  id: string;
  type: "scene" | "chapter" | "volume" | "manuscript";
  name?: string;
  snippet?: string;
  filePath: string;
  score: number;
  field?: "body" | "name";
  /** Match offsets are UTF-16 code units within the reported field. */
  offset?: number;
  length?: number;
}

export interface SceneWritingStats {
  sceneId: string;
  charCount: number;
  pages400: number;
  status?: string;
}

export interface ChapterWritingStats {
  chapterId: string;
  charCount: number;
  pages400: number;
  scenes: SceneWritingStats[];
}

export interface VolumeWritingStats {
  volumeId: string;
  charCount: number;
  pages400: number;
  chapters: ChapterWritingStats[];
}

export interface WritingStats {
  totalCharCount: number;
  totalPages400: number;
  volumes: VolumeWritingStats[];
  sceneById: Record<string, SceneWritingStats>;
}

export type HierarchyKind = "volume" | "chapter" | "scene";

export type CreateHierarchyInput =
  | { kind: "volume"; id: string; title: string }
  | { kind: "chapter"; id: string; title: string; volumeId: string }
  | { kind: "scene"; id: string; title: string; volumeId: string; chapterId: string; manuscriptBody?: string };

export type HierarchyTarget =
  | { kind: "volume"; id: string }
  | { kind: "chapter"; id: string; volumeId: string }
  | { kind: "scene"; id: string; volumeId: string; chapterId: string };

export type ReorderHierarchyInput =
  | { kind: "volume"; orderedIds: string[] }
  | { kind: "chapter"; volumeId: string; orderedIds: string[] }
  | { kind: "scene"; volumeId: string; chapterId: string; orderedIds: string[] };

export interface BuiltChangeOperation {
  snapshot: SnapshotId;
  operation: ChangeOperation;
}

export interface SyncStatus {
  branch: string;
  head: string;
  ahead: number;
  behind: number;
  dirty: boolean;
}

export class CoreError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CoreError";
  }
}

export interface CoreStoreOptions {
  dataDir: string;
  githubToken?: string;
  /** Allows local filesystem remotes for isolated tests and development. */
  allowLocalRemotes?: boolean;
  /** Optional fetch implementation for controlled GitHub API tests. */
  fetch?: typeof fetch;
  /** Maximum normal-push attempts after a remote race. Defaults to three. */
  maxPushRetries?: number;
}

interface ProjectRecord extends Project {
  directory: string;
  emptyRemote: boolean;
  identity?: RepositoryIdentity;
}

interface SceneRecord {
  id: string;
  title: string;
  yamlPath: string;
  manuscriptPath: string;
  yamlText: string;
  yamlData: Record<string, unknown>;
}

interface VolumeHierarchyRecord {
  id: string;
  title: string;
  directory: string;
  path: string;
  revision: string | null;
  data: Record<string, unknown>;
}

interface ChapterHierarchyRecord {
  id: string;
  title: string;
  directory: string;
  path: string;
  revision: string | null;
  volumeId: string;
  data: Record<string, unknown>;
}

interface SceneHierarchyRecord {
  id: string;
  title: string;
  path: string;
  revision: string;
  data: Record<string, unknown>;
  volumeId: string;
  chapterId: string;
}

interface FrontmatterDocument {
  prefix: string;
  body: string;
  data: Record<string, unknown>;
}

interface OperationMetadata {
  version: 1;
  sequence: number;
  digest: string;
  operation: ChangeOperation;
  authorScope?: string;
  hierarchyRevision?: string;
  proposalId?: string;
}

interface PublicationMetadata {
  version: 1;
  batchId: string;
  digest: string;
  operations: Array<{ operationId: string; generation: number; digest: string; receipt: CheckpointReceipt }>;
}

interface ProposalMetadata {
  version: 1;
  proposalId: string;
  digest: string;
  proposal: ChangeProposal;
}

interface ProposalJournal {
  version: 1;
  repository: RepositoryIdentity;
  proposals: ChangeProposal[];
}

interface StoredOperation extends OperationMetadata {
  path: string;
  commit: string;
  receipt: CheckpointReceipt;
}

const OPERATION_DIRECTORY = "meta/scriptorium/operations/v1";
const PUBLICATION_DIRECTORY = "meta/scriptorium/publications/v1";
const PROPOSAL_DIRECTORY = "meta/scriptorium/proposals/v1";
const MAX_PROPOSAL_BYTES = 8 * 1024 * 1024;
const MAX_PROPOSAL_JOURNAL_BYTES = 8 * 1024 * 1024;
const MAX_PUSH_ATTEMPTS = 3;

function coreError(status: number, code: string, message: string): CoreError {
  return new CoreError(status, code, message);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function titleOf(data: Record<string, unknown>, fallback: string): string {
  if (typeof data.title === "string" && data.title.trim()) return data.title.trim();
  if (typeof data.name === "string" && data.name.trim()) return data.name.trim();
  return fallback;
}

function sortByOrderAndTitle<T extends { id: string; title: string; order?: number }>(items: T[]): T[] {
  return items.sort((a, b) => {
    const aOrder = typeof a.order === "number" && Number.isFinite(a.order) ? a.order : 0;
    const bOrder = typeof b.order === "number" && Number.isFinite(b.order) ? b.order : 0;
    if (aOrder !== bOrder) return aOrder - bOrder;
    return a.title.localeCompare(b.title) || a.id.localeCompare(b.id);
  });
}

function safeRelativePath(value: string): string {
  if (!value || value.includes("\0") || value.includes("\\") || path.posix.isAbsolute(value)) {
    throw coreError(422, "invalid_manuscript_path", "The scene has an unsafe manuscript path");
  }
  const segments = value.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === ".." || segment.toLowerCase() === ".git")) {
    throw coreError(422, "invalid_manuscript_path", "The scene has an unsafe manuscript path");
  }
  if (!value.toLowerCase().endsWith(".md")) {
    throw coreError(422, "invalid_manuscript_path", "The scene manuscript must be a Markdown file");
  }
  return segments.join(path.sep);
}

function parseMarkdownDocument(document: string): FrontmatterDocument {
  const opening = /^(---)[ \t]*\r?\n/.exec(document);
  if (!opening) return { prefix: "", body: document, data: {} };

  const delimiter = /^---[ \t]*\r?$/gm;
  delimiter.lastIndex = opening[0].length;
  const closing = delimiter.exec(document);
  if (!closing) throw coreError(422, "invalid_frontmatter", "The scene Markdown has unclosed YAML frontmatter");

  const frontmatter = document.slice(opening[0].length, closing.index);
  let data: Record<string, unknown> = {};
  try {
    const parsed = YAML.parse(frontmatter);
    const record = asRecord(parsed);
    if (parsed !== null && record === null) {
      throw new Error("Frontmatter must be a YAML mapping");
    }
    data = record ?? {};
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid YAML frontmatter";
    throw coreError(422, "invalid_frontmatter", `The scene Markdown has invalid YAML frontmatter: ${message}`);
  }

  let bodyStart = closing.index + closing[0].length;
  if (document.startsWith("\r\n", bodyStart)) bodyStart += 2;
  else if (document.startsWith("\n", bodyStart)) bodyStart += 1;
  const prefix = document.slice(0, bodyStart);
  return { prefix, body: document.slice(bodyStart), data };
}

const WRITING_PAGE_CHARS = 400;

function pages400(charCount: number): number {
  return charCount <= 0 ? 0 : Math.ceil(charCount / WRITING_PAGE_CHARS);
}

function findLiteralInsensitive(text: string, query: string): { offset: number; length: number } | null {
  if (!query) return null;
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(escaped, "iu").exec(text);
  return match ? { offset: match.index, length: match[0].length } : null;
}

function searchSnippet(text: string, offset: number, length: number): string {
  const start = Math.max(0, offset - 48);
  const end = Math.min(text.length, offset + length + 48);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < text.length ? "…" : "";
  return `${prefix}${text.slice(start, end).replace(/[\r\n\t]+/g, " ")}${suffix}`;
}

function hierarchyId(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 128 || value.trim() !== value || value.includes("/")) {
    throw coreError(400, "invalid_hierarchy_id", "Hierarchy IDs must be nonempty path-safe strings of at most 128 characters");
  }
  try { assertProjectPath(value); }
  catch { throw coreError(400, "invalid_hierarchy_id", "Hierarchy IDs must be nonempty path-safe strings of at most 128 characters"); }
  return value;
}

function hierarchyTitle(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 512 || /[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(value)) {
    throw coreError(400, "invalid_hierarchy_title", "A hierarchy title of at most 512 characters is required");
  }
  return value.trim();
}

function hierarchyOrder(data: Record<string, unknown>): number {
  return typeof data.order === "number" && Number.isFinite(data.order) ? data.order : 0;
}

function revisionFor(yamlText: string, markdownText: string): string {
  return createHash("sha256").update(yamlText).update("\0").update(markdownText).digest("hex");
}

function revisionForBytes(content: Buffer | string): string {
  return createHash("sha256").update(content).digest("hex");
}

function isSnapshotId(value: unknown): value is SnapshotId {
  const snapshot = asRecord(value);
  const repository = snapshot ? asRecord(snapshot.repository) : null;
  return !!snapshot && !!repository &&
    (repository.provider === "github" || repository.provider === "local") &&
    [repository.repositoryId, repository.defaultBranch, repository.ownerScope, repository.url].every((item) => typeof item === "string" && item.length > 0) &&
    typeof snapshot.remoteCommit === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64}|)$/.test(snapshot.remoteCommit) &&
    (snapshot.overlayCommit === undefined || (typeof snapshot.overlayCommit === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(snapshot.overlayCommit)));
}

function canonicalJson(value: unknown): string {
  const normalize = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(normalize);
    const record = asRecord(item);
    if (record) {
      return Object.fromEntries(Object.keys(record).sort().map((key) => [key, normalize(record[key])]));
    }
    return item;
  };
  return JSON.stringify(normalize(value));
}

function isJsonValue(value: unknown, active = new WeakSet<object>(), depth = 0): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || depth > 32) return false;
  if (active.has(value)) return false;
  if (!Array.isArray(value)) {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
  }
  active.add(value);
  const valid = Array.isArray(value)
    ? value.every((item) => isJsonValue(item, active, depth + 1))
    : Object.values(value as Record<string, unknown>).every((item) => isJsonValue(item, active, depth + 1));
  active.delete(value);
  return valid;
}

function operationRequiresHierarchyRevision(operation: ChangeOperation): boolean {
  return operation.effect === "structure" || operation.writes.some(({ path: filePath }) =>
    filePath === "plot/volumes" || filePath.startsWith("plot/volumes/"));
}

function assertUserOperationPaths(operation: ChangeOperation): void {
  const reserved = ["meta/scriptorium/operations", "meta/scriptorium/publications", "meta/scriptorium/proposals"];
  for (const write of operation.writes) {
    const filePath = write.path.toLowerCase();
    if (reserved.some((root) => filePath === root || filePath.startsWith(`${root}/`))) {
      throw new Error("Change operations cannot modify Core authority metadata");
    }
    if (write.encoding === "base64" && Buffer.from(write.content ?? "", "base64").toString("base64") !== write.content) {
      throw new Error("Binary change content must use canonical base64 encoding");
    }
  }
}

function normalizedOperation(operation: ChangeOperation): ChangeOperation {
  return {
    id: operation.id,
    generation: operation.generation,
    repository: {
      provider: operation.repository.provider,
      repositoryId: operation.repository.repositoryId,
      defaultBranch: operation.repository.defaultBranch,
      ownerScope: operation.repository.ownerScope,
      url: operation.repository.url,
    },
    baseRemoteCommit: operation.baseRemoteCommit,
    effect: operation.effect,
    reads: operation.reads.map(({ path: filePath, revision }) => ({ path: filePath, revision })),
    writes: operation.writes.map((change) => ({
      path: change.path,
      revision: change.revision,
      content: change.content,
      ...(change.encoding === undefined ? {} : { encoding: change.encoding }),
    })),
    message: operation.message,
    ...(operation.evidenceIds === undefined ? {} : { evidenceIds: [...operation.evidenceIds] }),
  };
}

function operationDigest(operation: ChangeOperation): string {
  return revisionForBytes(JSON.stringify(normalizedOperation(operation)));
}

function normalizedProposal(proposal: ChangeProposal): ChangeProposal {
  return {
    id: proposal.id,
    snapshot: structuredClone(proposal.snapshot),
    operations: proposal.operations.map(normalizedOperation),
    source: proposal.source,
    ...(proposal.evidence?.length ? { evidence: structuredClone(proposal.evidence) } : {}),
  };
}

function proposalDigest(proposal: ChangeProposal): string {
  return createHash("sha256").update(canonicalJson(normalizedProposal(proposal))).digest("hex");
}

function assertPersistedProposal(value: unknown): asserts value is ChangeProposal {
  const proposal = asRecord(value);
  if (!proposal || typeof proposal.id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(proposal.id) ||
      !isSnapshotId(proposal.snapshot) || !Array.isArray(proposal.operations) || !proposal.operations.length ||
      proposal.operations.length > 256 || !["author", "module", "mcp"].includes(proposal.source as string)) {
    throw new Error("Invalid proposal envelope");
  }
  const operationIds = new Set<string>();
  for (const candidate of proposal.operations) {
    assertChangeOperation(candidate);
    assertUserOperationPaths(candidate);
    const operation = candidate as ChangeOperation;
    if (operationIds.has(operation.id) || operation.baseRemoteCommit !== (proposal.snapshot as SnapshotId).remoteCommit ||
        snapshotKey({ repository: operation.repository, remoteCommit: operation.baseRemoteCommit }) !==
          snapshotKey({ repository: (proposal.snapshot as SnapshotId).repository, remoteCommit: (proposal.snapshot as SnapshotId).remoteCommit })) {
      throw new Error("Proposal operation binding mismatch");
    }
    operationIds.add(operation.id);
  }
  const evidence = proposal.evidence ?? [];
  if (!Array.isArray(evidence) || !isJsonValue(evidence) ||
      Buffer.byteLength(JSON.stringify(evidence), "utf8") > MAX_PROPOSAL_EVIDENCE_BYTES) {
    throw new Error("Invalid proposal evidence");
  }
  const evidenceIds = new Set<string>();
  for (const itemValue of evidence) {
    const item = asRecord(itemValue);
    if (!item || typeof item.id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(item.id) || evidenceIds.has(item.id) ||
        !isSnapshotId(item.snapshot) || snapshotKey(item.snapshot) !== snapshotKey(proposal.snapshot as SnapshotId) ||
        !["story", "diagnostics", "nlp", "semantic", "speaker", "assistant", "publishing", "mcp"].includes(item.module as string) ||
        typeof item.kind !== "string" || !item.kind.trim() || item.kind.length > 128 || !Array.isArray(item.paths) || item.paths.length > 512 ||
        !Object.prototype.hasOwnProperty.call(item, "details")) {
      throw new Error("Invalid proposal evidence record");
    }
    for (const fileValue of item.paths) {
      const file = asRecord(fileValue);
      if (!file || typeof file.path !== "string" || (file.revision !== null &&
          (typeof file.revision !== "string" || !/^[a-f0-9]{64}$/.test(file.revision)))) {
        throw new Error("Invalid proposal evidence path");
      }
      assertProjectPath(file.path);
    }
    evidenceIds.add(item.id);
  }
  for (const candidate of proposal.operations) {
    const operation = candidate as ChangeOperation;
    if (operation.evidenceIds?.some((id) => !evidenceIds.has(id))) throw new Error("Missing proposal evidence reference");
  }
  if (Buffer.byteLength(JSON.stringify(normalizedProposal(proposal as unknown as ChangeProposal)), "utf8") > MAX_PROPOSAL_BYTES) {
    throw new Error("Persisted proposal exceeds its size limit");
  }
}

function publicationDigest(batchId: string, operations: PublicationMetadata["operations"]): string {
  return revisionForBytes(JSON.stringify({ version: 1, batchId, operations }));
}

function receiptMatchesOperation(value: unknown, operation: ChangeOperation): value is CheckpointReceipt {
  const receipt = asRecord(value);
  if (!receipt || receipt.operationId !== operation.id || receipt.generation !== operation.generation ||
      typeof receipt.localCommit !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(receipt.localCommit) ||
      receipt.remoteBase !== operation.baseRemoteCommit || !Array.isArray(receipt.revisions)) return false;
  const expected = operation.writes.map((write) => ({
    path: write.path,
    revision: write.content === null
      ? null
      : revisionForBytes(write.encoding === "base64" ? Buffer.from(write.content, "base64") : Buffer.from(write.content, "utf8")),
  }));
  return receipt.revisions.length === expected.length && receipt.revisions.every((item, index) => {
    const actual = asRecord(item);
    const target = expected[index];
    return !!actual && !!target && actual.path === target.path && actual.revision === target.revision;
  });
}

function operationMetadataPath(operationId: string): string {
  return `${OPERATION_DIRECTORY}/${operationId}.json`;
}

function publicationMetadataPath(batchId: string): string {
  return `${PUBLICATION_DIRECTORY}/${batchId}.json`;
}

function proposalMetadataPath(proposalId: string): string {
  return `${PROPOSAL_DIRECTORY}/${proposalId}.json`;
}

function parseOperationMetadata(text: string, metadataPath: string): OperationMetadata {
  try {
    const value = asRecord(JSON.parse(text));
    if (!value || value.version !== 1 || typeof value.digest !== "string" || !asRecord(value.operation)) {
      throw new Error("Invalid metadata");
    }
    const operation = value.operation as unknown as ChangeOperation;
    assertChangeOperation(operation);
    assertUserOperationPaths(operation);
    const normalized = normalizedOperation(operation);
    if (metadataPath !== operationMetadataPath(normalized.id) || value.digest !== operationDigest(normalized)) {
      throw new Error("Mismatched metadata");
    }
    if (!Number.isSafeInteger(value.sequence) || (value.sequence as number) <= 0 ||
        (value.authorScope !== undefined && (typeof value.authorScope !== "string" || !value.authorScope.trim())) ||
        (value.hierarchyRevision !== undefined && (typeof value.hierarchyRevision !== "string" || !/^[a-f0-9]{64}$/.test(value.hierarchyRevision))) ||
        (value.proposalId !== undefined && (typeof value.proposalId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value.proposalId)))) {
      throw new Error("Invalid operation metadata fields");
    }
    return {
      version: 1,
      sequence: value.sequence as number,
      digest: value.digest,
      operation: normalized,
      ...(typeof value.authorScope === "string" ? { authorScope: value.authorScope } : {}),
      ...(typeof value.hierarchyRevision === "string" ? { hierarchyRevision: value.hierarchyRevision } : {}),
      ...(typeof value.proposalId === "string" ? { proposalId: value.proposalId } : {}),
    };
  } catch {
    throw coreError(409, "operation_metadata_invalid", "The repository contains invalid Scriptorium operation metadata");
  }
}

function gitHubSlug(url: string): { owner: string; repository: string } {
  const parsed = new URL(url);
  const segments = parsed.pathname.split("/").filter(Boolean);
  return { owner: segments[0] ?? "", repository: (segments[1] ?? "").replace(/\.git$/i, "") };
}

async function githubIdentity(
  url: string,
  token: string | undefined,
  request: typeof fetch,
): Promise<RepositoryIdentity> {
  const { owner, repository } = gitHubSlug(url);
  const headers = new Headers({
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "Scriptorium-Core",
  });
  if (token) headers.set("Authorization", `Bearer ${token}`);
  let response: Response;
  try {
    response = await request(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}`, {
      method: "GET",
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw coreError(502, "repository_metadata_unavailable", "GitHub repository metadata could not be fetched");
  }
  if (!response.ok) {
    const status = response.status === 404 || response.status === 410 ? 409 : 502;
    const code = status === 409 ? "repository_unavailable" : "repository_metadata_unavailable";
    throw coreError(status, code, "GitHub repository metadata could not be fetched");
  }
  let value: Record<string, unknown> | null;
  try { value = asRecord(await response.json()); }
  catch { value = null; }
  const ownerValue = value ? asRecord(value.owner) : null;
  if (
    !value || !Number.isSafeInteger(value.id) || (value.id as number) <= 0 ||
    typeof value.default_branch !== "string" || !ownerValue ||
    !(Number.isSafeInteger(ownerValue.id) || (typeof ownerValue.login === "string" && ownerValue.login.length > 0))
  ) {
    throw coreError(502, "repository_metadata_invalid", "GitHub returned invalid repository metadata");
  }
  return {
    provider: "github",
    repositoryId: String(value.id),
    defaultBranch: branchName(value.default_branch),
    ownerScope: `github:${String(ownerValue.id ?? ownerValue.login)}`,
    url,
  };
}

function localIdentity(url: string, defaultBranch: string): RepositoryIdentity {
  const repositoryId = createHash("sha256").update(url).digest("hex");
  return {
    provider: "local",
    repositoryId,
    defaultBranch,
    ownerScope: `local:${repositoryId}`,
    url,
  };
}

function normalizeGitHubUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw coreError(400, "invalid_repository_url", "Use an HTTPS GitHub repository URL");
  }
  if (
    url.protocol !== "https:" ||
    url.hostname.toLowerCase() !== "github.com" ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw coreError(400, "invalid_repository_url", "Only HTTPS repositories hosted at github.com are supported");
  }
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 2 || !segments.every((segment) => /^[A-Za-z0-9_.-]+$/.test(segment))) {
    throw coreError(400, "invalid_repository_url", "Use a GitHub repository URL in the form https://github.com/owner/repository");
  }
  const owner = segments[0];
  const repository = segments[1].replace(/\.git$/i, "");
  if (!owner || !repository || owner === "." || owner === ".." || repository === "." || repository === "..") {
    throw coreError(400, "invalid_repository_url", "The GitHub repository URL is invalid");
  }
  return `https://github.com/${owner}/${repository}.git`;
}

function repositoryTitle(url: string): string {
  const last = url.replace(/\/+$/, "").split("/").at(-1) ?? "Project";
  return last.replace(/\.git$/i, "") || "Project";
}

function branchName(value: string | undefined): string {
  const branch = value?.trim() || DEFAULT_BRANCH;
  if (
    branch.length > 240 ||
    !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch) ||
    branch.includes("..") ||
    branch.includes("@{") ||
    branch.endsWith("/") ||
    branch.includes("//") ||
    branch.endsWith(".lock")
  ) {
    throw coreError(400, "invalid_branch", "The branch name is invalid");
  }
  return branch;
}

function sanitizedEnvironment(token?: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.GIT_CONFIG;
  delete env.GIT_CONFIG_PARAMETERS;
  delete env.GIT_CONFIG_COUNT;
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_CONFIG_GLOBAL = process.platform === "win32" ? "NUL" : "/dev/null";
  env.GIT_TERMINAL_PROMPT = "0";
  if (token) env.SCRIPTORIUM_GIT_TOKEN = token;
  else delete env.SCRIPTORIUM_GIT_TOKEN;
  return env;
}

function makeAskpassScript(directory: string): Promise<string> {
  const scriptPath = path.join(directory, "askpass");
  const script = "#!/bin/sh\ncase \"$1\" in\n  *sername*) printf '%s\\n' 'x-access-token' ;;\n  *) printf '%s\\n' \"$SCRIPTORIUM_GIT_TOKEN\" ;;\nesac\n";
  return fs.writeFile(scriptPath, script, { mode: 0o700 }).then(() => scriptPath);
}

async function git(
  cwd: string,
  args: string[],
  options: { token?: string; askpass?: string; timeout?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<string> {
  const baseArgs = [
    "--literal-pathspecs",
    "-c", "core.hooksPath=/dev/null",
    "-c", "credential.helper=",
    "-c", "init.templateDir=/dev/null",
    ...args,
  ];
  const env = { ...sanitizedEnvironment(options.token), ...options.env };
  if (options.askpass) {
    env.GIT_ASKPASS = options.askpass;
    env.GIT_ASKPASS_REQUIRE = "force";
  }
  try {
    const result = await execFile("git", baseArgs, {
      cwd,
      env,
      timeout: options.timeout ?? GIT_TIMEOUT_MS,
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true,
    });
    return result.stdout;
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Git command failed";
    const redacted = options.token ? detail.split(options.token).join("[redacted]") : detail;
    throw coreError(502, "git_operation_failed", `Git operation failed: ${redacted}`);
  }
}

async function gitInput(
  cwd: string,
  args: string[],
  input: Buffer | string,
  options: { token?: string; askpass?: string; timeout?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<string> {
  const baseArgs = [
    "--literal-pathspecs",
    "-c", "core.hooksPath=/dev/null",
    "-c", "credential.helper=",
    "-c", "init.templateDir=/dev/null",
    ...args,
  ];
  const env = { ...sanitizedEnvironment(options.token), ...options.env };
  if (options.askpass) {
    env.GIT_ASKPASS = options.askpass;
    env.GIT_ASKPASS_REQUIRE = "force";
  }
  return await new Promise<string>((resolve, reject) => {
    const child = execFileCallback("git", baseArgs, {
      cwd,
      env,
      timeout: options.timeout ?? GIT_TIMEOUT_MS,
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true,
    }, (error, stdout) => {
      if (error) {
        const detail = error.message;
        const redacted = options.token ? detail.split(options.token).join("[redacted]") : detail;
        reject(coreError(502, "git_operation_failed", `Git operation failed: ${redacted}`));
        return;
      }
      resolve(stdout);
    });
    child.stdin?.end(input);
  });
}

async function gitBuffer(cwd: string, args: string[]): Promise<Buffer> {
  const baseArgs = [
    "--literal-pathspecs",
    "-c", "core.hooksPath=/dev/null",
    "-c", "credential.helper=",
    "-c", "init.templateDir=/dev/null",
    ...args,
  ];
  return await new Promise<Buffer>((resolve, reject) => {
    execFileCallback("git", baseArgs, {
      cwd,
      env: sanitizedEnvironment(),
      encoding: "buffer",
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true,
    }, (error, stdout) => {
      if (error) {
        reject(coreError(502, "git_operation_failed", `Git operation failed: ${error.message}`));
        return;
      }
      resolve(Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout));
    });
  });
}

function stripMarkdownFrontmatter(raw: string): string {
  if (!raw.startsWith("---")) return raw;
  const end = raw.indexOf("\n---", 3);
  if (end === -1) return raw;
  const after = raw.slice(end + 4);
  return after.startsWith("\n") ? after.slice(1) : after;
}

function parseLoomTrailers(message: string): Record<string, string> {
  const trailers: Record<string, string> = {};
  for (const line of message.split(/\r?\n/)) {
    const match = /^(Loom-[A-Za-z0-9-]+):\s*(.*)$/.exec(line.trim());
    if (match?.[1]) trailers[match[1]] = (match[2] ?? "").trim();
  }
  return trailers;
}

function parseLoomSceneId(message: string): string | null {
  const subject = message.split(/\r?\n/, 1)[0] ?? "";
  return /^loom\(scene\):\s+(\S+)/.exec(subject.trim())?.[1] ?? null;
}

function parseGitLogRecord(chunk: string): { hash: string; date: string; body: string } | null {
  const normalized = chunk.replace(/^\n+/, "").replace(/\n+$/, "");
  if (!normalized) return null;
  const first = normalized.indexOf("\0");
  const second = normalized.indexOf("\0", first + 1);
  if (first < 1 || second < first + 1) return null;
  return {
    hash: normalized.slice(0, first),
    date: normalized.slice(first + 1, second),
    body: normalized.slice(second + 1).trimEnd(),
  };
}

function validateProjectId(id: string): void {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw coreError(404, "project_not_found", "Project not found");
}

async function ensureDirectory(directory: string): Promise<void> {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw coreError(500, "unsafe_data_directory", "The application data directory is unsafe");
  }
  await fs.chmod(directory, 0o700);
  const resolved = await fs.realpath(directory);
  if (resolved !== path.resolve(directory)) {
    throw coreError(500, "unsafe_data_directory", "The application data directory is unsafe");
  }
}

async function pathUnderRoot(root: string, relativePath: string): Promise<string> {
  if (!relativePath || relativePath.includes("\0") || relativePath.includes("\\") || path.posix.isAbsolute(relativePath)) {
    throw coreError(422, "unsafe_project_path", "The project path is unsafe");
  }
  const segments = relativePath.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw coreError(422, "unsafe_project_path", "The project path is unsafe");
  }
  const resolvedRoot = await fs.realpath(root);
  let current = resolvedRoot;
  let missingParent = false;
  for (let index = 0; index < segments.length; index++) {
    current = path.join(current, segments[index]);
    if (missingParent) continue;
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) {
        throw coreError(422, "unsafe_manuscript_path", "The scene manuscript path crosses a symbolic link");
      }
      if (index < segments.length - 1 && !stat.isDirectory()) {
        throw coreError(422, "unsafe_manuscript_path", "The scene manuscript path contains a non-directory parent");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        missingParent = true;
        continue;
      }
      throw error;
    }
  }
  const relative = path.relative(resolvedRoot, current);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw coreError(422, "unsafe_manuscript_path", "The scene manuscript path escapes the project");
  }
  return current;
}

async function pathIsWithinProject(root: string, relativePath: string): Promise<string> {
  return pathUnderRoot(root, safeRelativePath(relativePath));
}

async function atomicWrite(filePath: string, content: string | Buffer): Promise<void> {
  const directory = path.dirname(filePath);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const tempPath = path.join(directory, `.${path.basename(filePath)}.${randomUUID()}.tmp`);
  try {
    const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
    await fs.writeFile(tempPath, bytes, { flag: "wx", mode: 0o600, flush: true });
    await fs.rename(tempPath, filePath);
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export class CoreStore implements MutationCoordinator {
  readonly dataDir: string;
  private readonly projectsDir: string;
  private readonly proposalsDir: string;
  private readonly locksDir: string;
  private readonly registryPath: string;
  private readonly token?: string;
  private readonly allowLocalRemotes: boolean;
  private readonly fetcher: typeof fetch;
  private readonly maxPushAttempts: number;
  private readonly queueTails = new Map<string, Promise<void>>();
  private readonly proposals = new Map<string, Map<string, ChangeProposal>>();
  private readonly durableProposalIds = new Map<string, Set<string>>();
  private readonly approvals = new Map<string, Map<string, {
    authorScope: string;
    operationDigests: Map<string, string>;
    hierarchyRevisions: Map<string, string>;
  }>>();

  constructor(options: CoreStoreOptions) {
    if (!options?.dataDir) throw new TypeError("CoreStore requires dataDir");
    this.dataDir = path.resolve(options.dataDir);
    this.projectsDir = path.join(this.dataDir, "projects");
    this.proposalsDir = path.join(this.dataDir, "proposal-journal");
    this.locksDir = path.join(this.dataDir, ".locks");
    this.registryPath = path.join(this.dataDir, "projects.json");
    this.token = options.githubToken ?? process.env.SCRIPTORIUM_GITHUB_TOKEN;
    this.allowLocalRemotes = options.allowLocalRemotes ?? false;
    this.fetcher = options.fetch ?? fetch;
    this.maxPushAttempts = Math.min(MAX_PUSH_ATTEMPTS, Math.max(1, options.maxPushRetries ?? MAX_PUSH_ATTEMPTS));
  }

  private async initialize(): Promise<void> {
    await ensureDirectory(this.dataDir);
    await ensureDirectory(this.projectsDir);
    await ensureDirectory(this.proposalsDir);
    await ensureDirectory(this.locksDir);
  }

  private async readRegistry(): Promise<ProjectRecord[]> {
    await this.initialize();
    try {
      const registryStat = await fs.lstat(this.registryPath);
      if (registryStat.isSymbolicLink() || !registryStat.isFile()) {
        throw new Error("Project registry must be a regular file");
      }
      const raw = JSON.parse(await fs.readFile(this.registryPath, "utf8")) as unknown;
      if (!Array.isArray(raw)) throw new Error("Project registry must be an array");
      return raw.map((value) => {
        const item = asRecord(value);
        if (
          !item ||
          typeof item.id !== "string" ||
          typeof item.url !== "string" ||
          typeof item.branch !== "string" ||
          typeof item.directory !== "string"
        ) {
          throw new Error("Project registry entry is invalid");
        }
        validateProjectId(item.id);
        if (item.directory !== item.id) throw new Error("Project registry directory is invalid");
        const identityValue = asRecord(item.identity);
        const identity = identityValue &&
          (identityValue.provider === "github" || identityValue.provider === "local") &&
          typeof identityValue.repositoryId === "string" &&
          typeof identityValue.defaultBranch === "string" &&
          typeof identityValue.ownerScope === "string" &&
          typeof identityValue.url === "string"
          ? {
              provider: identityValue.provider,
              repositoryId: identityValue.repositoryId,
              defaultBranch: identityValue.defaultBranch,
              ownerScope: identityValue.ownerScope,
              url: identityValue.url,
            } as RepositoryIdentity
          : undefined;
        return {
          id: item.id,
          url: item.url,
          branch: item.branch,
          directory: item.directory,
          emptyRemote: typeof item.emptyRemote === "boolean" ? item.emptyRemote : false,
          ...(identity ? { identity } : {}),
        };
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw coreError(500, "project_registry_invalid", "The project registry could not be read safely");
    }
  }

  private async writeRegistry(records: ProjectRecord[]): Promise<void> {
    await atomicWrite(this.registryPath, `${JSON.stringify(records, null, 2)}\n`);
  }

  private proposalJournalPath(projectId: string): string {
    validateProjectId(projectId);
    return path.join(this.proposalsDir, `${projectId}.json`);
  }

  private async readProposalJournal(record: ProjectRecord): Promise<Map<string, ChangeProposal>> {
    const journalPath = this.proposalJournalPath(record.id);
    let stat: Awaited<ReturnType<typeof fs.lstat>>;
    try { stat = await fs.lstat(journalPath); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Map();
      throw error;
    }
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_PROPOSAL_JOURNAL_BYTES) {
      throw coreError(500, "proposal_journal_invalid", "The local pending proposal journal is unsafe or exceeds its size limit");
    }
    let value: Record<string, unknown> | null;
    try { value = asRecord(JSON.parse(await fs.readFile(journalPath, "utf8"))); }
    catch { throw coreError(500, "proposal_journal_invalid", "The local pending proposal journal could not be read safely"); }
    const journalIdentity = value ? asRecord(value.repository) : null;
    if (!value || value.version !== 1 || !journalIdentity || !Array.isArray(value.proposals) ||
        !isSnapshotId({ repository: journalIdentity, remoteCommit: "" })) {
      throw coreError(500, "proposal_journal_invalid", "The local pending proposal journal has an invalid identity");
    }
    if (!record.identity || snapshotKey({ repository: journalIdentity as unknown as RepositoryIdentity, remoteCommit: "" }) !==
        snapshotKey({ repository: record.identity, remoteCommit: "" })) {
      throw coreError(409, "proposal_repository_mismatch", "The saved proposals belong to a different repository identity");
    }
    const proposals = new Map<string, ChangeProposal>();
    for (const rawProposal of value.proposals) {
      try { assertPersistedProposal(rawProposal); }
      catch { throw coreError(500, "proposal_journal_invalid", "The local pending proposal journal contains invalid proposal data"); }
      const proposal = normalizedProposal(rawProposal);
      if (snapshotKey({ repository: proposal.snapshot.repository, remoteCommit: "" }) !==
          snapshotKey({ repository: record.identity, remoteCommit: "" })) {
        throw coreError(409, "proposal_repository_mismatch", "The saved proposals belong to a different repository identity");
      }
      this.mergeProposal(proposals, proposal);
    }
    if (proposals.size > 256) throw coreError(500, "proposal_journal_invalid", "The local pending proposal journal contains too many entries");
    return proposals;
  }

  private async writeProposalJournal(record: ProjectRecord, proposals: Map<string, ChangeProposal>): Promise<void> {
    const journalPath = this.proposalJournalPath(record.id);
    if (proposals.size > 256) throw coreError(413, "proposal_journal_too_large", "Too many pending proposals are stored for this project");
    if (!proposals.size) {
      await fs.rm(journalPath, { force: true });
      return;
    }
    if (!record.identity) throw coreError(409, "proposal_repository_unavailable", "The repository identity is not available for proposal recovery");
    const journal: ProposalJournal = {
      version: 1,
      repository: record.identity,
      proposals: [...proposals.values()].map(normalizedProposal),
    };
    const content = `${JSON.stringify(journal, null, 2)}\n`;
    if (Buffer.byteLength(content, "utf8") > MAX_PROPOSAL_JOURNAL_BYTES) {
      throw coreError(413, "proposal_journal_too_large", "Pending proposals exceed the local recovery size limit");
    }
    await atomicWrite(journalPath, content);
  }

  private async getProject(projectId: string): Promise<{ record: ProjectRecord; root: string }> {
    validateProjectId(projectId);
    const records = await this.readRegistry();
    const record = records.find((item) => item.id === projectId);
    if (!record) throw coreError(404, "project_not_found", "Project not found");
    const root = path.join(this.projectsDir, record.directory);
    const stat = await fs.lstat(root).catch(() => null);
    if (!stat?.isDirectory() || stat.isSymbolicLink()) {
      throw coreError(500, "project_workspace_invalid", "The project workspace is missing or unsafe");
    }
    return { record, root };
  }

  private async treeEntry(root: string, commit: string, relativePath: string): Promise<{ mode: string; type: string; hash: string } | null> {
    assertProjectPath(relativePath);
    if (!commit) return null;
    let treeish = commit;
    const segments = relativePath.split("/");
    for (let index = 0; index < segments.length; index++) {
      const segment = segments[index];
      if (!segment) return null;
      const output = await git(root, ["ls-tree", "-z", treeish, "--", segment]);
      const entries = output.split("\0").filter(Boolean);
      const encoded = entries.find((entry) => entry.slice(entry.indexOf("\t") + 1) === segment);
      if (!encoded) return null;
      const tab = encoded.indexOf("\t");
      const fields = encoded.slice(0, tab).split(" ");
      const mode = fields[0] ?? "";
      const type = fields[1] ?? "";
      const hash = fields[2] ?? "";
      if (mode === "120000") {
        throw coreError(422, "unsafe_project_path", "The project path crosses a symbolic link");
      }
      if (index < segments.length - 1) {
        if (type !== "tree") throw coreError(422, "unsafe_project_path", "The project path contains a non-directory parent");
        treeish = hash;
      } else {
        if (type !== "blob") throw coreError(422, "unsafe_project_path", "The project path is not a regular file");
        return { mode, type, hash };
      }
    }
    return null;
  }

  private async snapshotFile(
    root: string,
    commit: string,
    relativePath: string,
    encoding: "utf8" | "base64" = "utf8",
  ): Promise<{ content: string; revision: string } | null> {
    const entry = await this.treeEntry(root, commit, relativePath);
    if (!entry) return null;
    const bytes = await gitBuffer(root, ["cat-file", "blob", entry.hash]);
    return { content: encoding === "base64" ? bytes.toString("base64") : bytes.toString("utf8"), revision: revisionForBytes(bytes) };
  }

  private async snapshotFiles(root: string, commit: string, prefix: string): Promise<string[]> {
    if (prefix) {
      try { assertProjectPath(prefix.replace(/\/$/, "")); }
      catch { throw coreError(422, "unsafe_project_path", "The project path is unsafe"); }
    }
    if (!commit) return [];
    const output = await git(root, ["ls-tree", "-r", "--full-tree", "-z", commit]);
    const files: string[] = [];
    for (const entry of output.split("\0")) {
      if (!entry) continue;
      const tab = entry.indexOf("\t");
      if (tab < 0) continue;
      const filePath = entry.slice(tab + 1);
      if (!prefix || filePath === prefix || filePath.startsWith(`${prefix.replace(/\/$/, "")}/`)) files.push(filePath);
    }
    return files.sort((a, b) => a.localeCompare(b));
  }

  private async hierarchyTreeRevision(root: string, commit: string): Promise<string> {
    if (!commit) return revisionForBytes(Buffer.alloc(0));
    const tree = await gitBuffer(root, ["ls-tree", "-r", "--full-tree", "-z", commit, "--", "plot/volumes"]);
    return revisionForBytes(tree);
  }

  private async createCommit(
    root: string,
    parent: string,
    writes: FileChange[],
    metadata: Array<{ path: string; content: string }>,
    message: string,
  ): Promise<string> {
    const indexDir = await fs.mkdtemp(path.join(this.dataDir, ".operation-index-"));
    const indexPath = path.join(indexDir, "index");
    const env = { GIT_INDEX_FILE: indexPath };
    try {
      await git(root, ["read-tree", parent || "--empty"], { env });
      const allWrites: Array<{ path: string; content: string | null; encoding?: "utf8" | "base64" }> = [
        ...writes.map((change) => ({ path: change.path, content: change.content, ...(change.encoding ? { encoding: change.encoding } : {}) })),
        ...metadata.map((item) => ({ path: item.path, content: item.content, encoding: "utf8" as const })),
      ];
      for (const change of allWrites) {
        assertProjectPath(change.path);
        const existing = parent ? await this.treeEntry(root, parent, change.path).catch((error) => {
          if (error instanceof CoreError && error.code === "unsafe_project_path") throw error;
          throw error;
        }) : null;
        if (change.content === null) {
          if (existing) await git(root, ["update-index", "--force-remove", "--", change.path], { env });
          continue;
        }
        const bytes = change.encoding === "base64" ? Buffer.from(change.content, "base64") : Buffer.from(change.content, "utf8");
        const blob = (await gitInput(root, ["hash-object", "-w", "--stdin"], bytes)).trim();
        const mode = existing?.mode === "100755" ? "100755" : "100644";
        await git(root, ["update-index", "--add", "--cacheinfo", `${mode},${blob},${change.path}`], { env });
      }
      const tree = (await git(root, ["write-tree"], { env })).trim();
      const commit = (await git(root, [
        "-c", "user.name=Scriptorium",
        "-c", "user.email=scriptorium@localhost",
        "commit-tree", tree,
        ...(parent ? ["-p", parent] : []),
        "-m", message.replace(/\r\n?/g, "\n").replace(/\0/g, "").slice(0, 1024),
      ])).trim();
      if (!/^[a-f0-9]{40,64}$/.test(commit)) throw coreError(500, "checkpoint_failed", "Git did not create a checkpoint commit");
      return commit;
    } finally {
      await fs.rm(indexDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async commitTreeFiles(root: string, commit: string): Promise<string[]> {
    if (!commit) return [];
    return this.snapshotFiles(root, commit, "");
  }

  private async getRef(root: string, ref: string): Promise<string> {
    try { return (await git(root, ["rev-parse", "--verify", ref])).trim(); }
    catch (error) {
      if (error instanceof CoreError && error.code === "git_operation_failed") return "";
      throw error;
    }
  }

  private async isAncestor(root: string, ancestor: string, descendant: string): Promise<boolean> {
    if (!ancestor || !descendant) return ancestor === descendant;
    try { await git(root, ["merge-base", "--is-ancestor", ancestor, descendant]); return true; }
    catch (error) {
      if (error instanceof CoreError && error.code === "git_operation_failed") return false;
      throw error;
    }
  }

  private async getRepositoryIdentity(record: ProjectRecord, root: string, askpass: string): Promise<RepositoryIdentity> {
    let identity: RepositoryIdentity;
    if (record.identity?.provider === "github" || /^https:\/\//i.test(record.url)) {
      identity = await githubIdentity(record.url, this.token, this.fetcher);
    } else {
      const head = await git(root, ["ls-remote", "--symref", "origin", "HEAD"], { token: this.token, askpass });
      const defaultBranch = head.match(/^ref: refs\/heads\/(.+)\tHEAD$/m)?.[1] ?? record.identity?.defaultBranch ?? record.branch;
      identity = localIdentity(record.url, branchName(defaultBranch));
    }
    if (record.identity) {
      if (record.identity.provider !== identity.provider || record.identity.repositoryId !== identity.repositoryId) {
        throw coreError(409, "repository_replaced", "The registered repository identity changed; mutations are paused");
      }
      if (record.identity.defaultBranch !== identity.defaultBranch) {
        throw coreError(409, "default_branch_changed", "The repository default branch changed; explicitly rebind the project before writing");
      }
    } else {
      record.identity = identity;
      await this.withRegistryLock(async () => {
        const records = await this.readRegistry();
        await this.writeRegistry(records.map((item) => item.id === record.id ? { ...item, identity } : item));
      });
    }
    return identity;
  }

  private async fetchRemoteUnlocked(record: ProjectRecord, root: string): Promise<{ identity: RepositoryIdentity; remoteCommit: string }> {
    const askpassDir = path.join(this.dataDir, `.askpass-${record.id}`);
    await fs.mkdir(askpassDir, { recursive: true, mode: 0o700 });
    try {
      const askpass = await makeAskpassScript(askpassDir);
      const identity = await this.getRepositoryIdentity(record, root, askpass);
      const remote = await git(root, ["ls-remote", "--heads", "origin", `refs/heads/${record.branch}`], { token: this.token, askpass });
      const exists = remote.split(/\r?\n/).some((line) => line.endsWith(`\trefs/heads/${record.branch}`));
      if (!exists) {
        if (record.emptyRemote) return { identity, remoteCommit: "" };
        throw coreError(409, "remote_branch_missing", "The registered GitHub branch no longer exists");
      }
      await git(root, ["fetch", "--no-tags", "origin", record.branch], { token: this.token, askpass });
      const remoteCommit = await this.getRef(root, `refs/remotes/origin/${record.branch}`);
      if (!remoteCommit) throw coreError(409, "remote_branch_missing", "The registered GitHub branch no longer exists");
      if (record.emptyRemote) {
        record.emptyRemote = false;
        await this.withRegistryLock(async () => {
          const records = await this.readRegistry();
          await this.writeRegistry(records.map((item) => item.id === record.id ? { ...item, emptyRemote: false } : item));
        });
      }
      return { identity, remoteCommit };
    } finally {
      await fs.rm(askpassDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async readHistoricalMetadataFiles(
    root: string,
    commit: string,
    directory: string,
  ): Promise<Array<{ path: string; commit: string; content: string }>> {
    const history = await git(root, ["log", "--full-history", "--format=%H", "--name-only", commit, "--", directory]);
    const paths = new Map<string, string[]>();
    let currentCommit = "";
    for (const rawLine of history.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(line)) {
        currentCommit = line;
      } else if (currentCommit && line.startsWith(`${directory}/`) && line.endsWith(".json")) {
        const commits = paths.get(line) ?? [];
        commits.push(currentCommit);
        paths.set(line, commits);
      }
    }
    const records: Array<{ path: string; commit: string; content: string }> = [];
    for (const [filePath, versions] of paths) {
      for (const versionCommit of versions) {
        try {
          const content = await git(root, ["show", `${versionCommit}:${filePath}`]);
          records.push({ path: filePath, commit: versionCommit, content });
        } catch (error) {
          if (!(error instanceof CoreError) || error.code !== "git_operation_failed") throw error;
          /* A deletion commit has no blob at its tip; earlier versions remain in the path history. */
        }
      }
    }
    return records;
  }

  private mergeProposal(proposals: Map<string, ChangeProposal>, proposal: ChangeProposal): void {
    const existing = proposals.get(proposal.id);
    if (existing && canonicalJson(existing) !== canonicalJson(proposal)) {
      throw coreError(409, "proposal_id_reused", "The proposal ID is already bound to a different payload");
    }
    if (!existing) proposals.set(proposal.id, structuredClone(proposal));
  }

  private async readProposalRecords(root: string, commit: string): Promise<Map<string, ChangeProposal>> {
    const proposalVersions = await this.readHistoricalMetadataFiles(root, commit, PROPOSAL_DIRECTORY);
    const proposals = new Map<string, ChangeProposal>();
    const digests = new Map<string, string>();
    for (const version of proposalVersions) {
      if (Buffer.byteLength(version.content, "utf8") > MAX_PROPOSAL_BYTES) {
        throw coreError(409, "proposal_metadata_invalid", "The repository contains an oversized proposal manifest");
      }
      let metadata: Record<string, unknown> | null;
      try { metadata = asRecord(JSON.parse(version.content)); }
      catch { throw coreError(409, "proposal_metadata_invalid", "The repository contains an invalid proposal manifest"); }
      if (!metadata || metadata.version !== 1 || typeof metadata.proposalId !== "string" ||
          !/^[A-Za-z0-9_-]{1,128}$/.test(metadata.proposalId) || version.path !== proposalMetadataPath(metadata.proposalId) ||
          typeof metadata.digest !== "string" || !/^[a-f0-9]{64}$/.test(metadata.digest)) {
        throw coreError(409, "proposal_metadata_invalid", "The repository contains an invalid proposal manifest");
      }
      try { assertPersistedProposal(metadata.proposal); }
      catch { throw coreError(409, "proposal_metadata_invalid", "The repository contains invalid proposal data"); }
      const proposal = normalizedProposal(metadata.proposal);
      if (proposal.id !== metadata.proposalId || proposalDigest(proposal) !== metadata.digest) {
        throw coreError(409, "proposal_metadata_invalid", "The proposal manifest does not match its immutable digest");
      }
      const existingDigest = digests.get(proposal.id);
      if (existingDigest && existingDigest !== metadata.digest) {
        throw coreError(409, "proposal_id_reused", "A proposal ID's immutable repository binding changed in Git history");
      }
      digests.set(proposal.id, metadata.digest);
      this.mergeProposal(proposals, proposal);
    }
    return proposals;
  }

  private async readDurableProposals(root: string, commits: string[]): Promise<Map<string, ChangeProposal>> {
    const proposals = new Map<string, ChangeProposal>();
    for (const commit of [...new Set(commits.filter(Boolean))]) {
      const found = await this.readProposalRecords(root, commit);
      for (const proposal of found.values()) this.mergeProposal(proposals, proposal);
    }
    return proposals;
  }

  private async readPublicationRecords(root: string, commit: string): Promise<Map<string, PublicationMetadata>> {
    const publicationMetadata = new Map<string, PublicationMetadata>();
    if (!commit) return publicationMetadata;
    const publicationVersions = await this.readHistoricalMetadataFiles(root, commit, PUBLICATION_DIRECTORY);
    for (const version of publicationVersions) {
      let publication: PublicationMetadata;
      try { publication = JSON.parse(version.content) as PublicationMetadata; }
      catch { throw coreError(409, "publication_metadata_invalid", "The repository contains invalid publication metadata"); }
      if (
        publication.version !== 1 || typeof publication.batchId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(publication.batchId) ||
        version.path !== publicationMetadataPath(publication.batchId) || !Array.isArray(publication.operations) ||
        publication.operations.length > 256 || typeof publication.digest !== "string" ||
        publication.digest !== publicationDigest(publication.batchId, publication.operations)
      ) {
        throw coreError(409, "publication_metadata_invalid", "The repository contains invalid publication metadata");
      }
      const existing = publicationMetadata.get(publication.batchId);
      if (existing && existing.digest !== publication.digest) {
        throw coreError(409, "batch_id_reused", "A publication batch's immutable repository binding changed in Git history");
      }
      if (!existing) publicationMetadata.set(publication.batchId, publication);
    }
    return publicationMetadata;
  }

  private async readOperationRecords(root: string, commit: string): Promise<StoredOperation[]> {
    if (!commit) return [];
    const operationVersions = await this.readHistoricalMetadataFiles(root, commit, OPERATION_DIRECTORY);
    const publicationMetadata = await this.readPublicationRecords(root, commit);
    const operationMetadata = new Map<string, { metadata: OperationMetadata; path: string; commit: string }>();
    for (const version of operationVersions) {
      if (version.content.length > 16 * 1024 * 1024) {
        throw coreError(409, "operation_metadata_invalid", "The repository contains invalid Scriptorium operation metadata");
      }
      const metadata = parseOperationMetadata(version.content, version.path);
      const existing = operationMetadata.get(metadata.operation.id);
      if (existing && (
        existing.metadata.digest !== metadata.digest || existing.metadata.sequence !== metadata.sequence ||
        existing.metadata.authorScope !== metadata.authorScope || existing.metadata.operation.generation !== metadata.operation.generation ||
        existing.metadata.hierarchyRevision !== metadata.hierarchyRevision || existing.metadata.proposalId !== metadata.proposalId
      )) {
        throw coreError(409, "operation_metadata_invalid", "An operation's immutable repository binding changed in Git history");
      }
      if (!existing) operationMetadata.set(metadata.operation.id, { metadata, path: version.path, commit: version.commit });
    }

    const publishedReceipts = new Map<string, { generation: number; digest: string; receipt: CheckpointReceipt }>();
    for (const publication of publicationMetadata.values()) {
      const rows = new Set<string>();
      for (const value of publication.operations as unknown[]) {
        const row = asRecord(value);
        if (
          !row || typeof row.operationId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(row.operationId) ||
          !Number.isSafeInteger(row.generation) || (row.generation as number) < 0 ||
          typeof row.digest !== "string" || !/^[a-f0-9]{64}$/.test(row.digest) || rows.has(row.operationId)
        ) {
          throw coreError(409, "publication_metadata_invalid", "The repository contains invalid publication metadata");
        }
        rows.add(row.operationId);
        if (publishedReceipts.has(row.operationId)) {
          throw coreError(409, "publication_metadata_invalid", "An operation appears in more than one publication receipt");
        }
        publishedReceipts.set(row.operationId, {
          generation: row.generation as number,
          digest: row.digest,
          receipt: row.receipt as CheckpointReceipt,
        });
      }
    }

    const operations: StoredOperation[] = [];
    const foundReceipts = new Set<string>();
    for (const { metadata, path: filePath, commit: changedAt } of operationMetadata.values()) {
      const originalCommit = await this.getRef(root, `refs/scriptorium/checkpoints/${metadata.operation.id}`);
      const reconstructedReceipt: CheckpointReceipt = {
        operationId: metadata.operation.id,
        generation: metadata.operation.generation,
        localCommit: originalCommit || changedAt,
        remoteBase: metadata.operation.baseRemoteCommit,
        revisions: metadata.operation.writes.map((write) => ({
          path: write.path,
          revision: write.content === null
            ? null
            : revisionForBytes(write.encoding === "base64" ? Buffer.from(write.content, "base64") : Buffer.from(write.content, "utf8")),
        })),
      };
      const durableReceipt = publishedReceipts.get(metadata.operation.id);
      let receipt = reconstructedReceipt;
      if (durableReceipt) {
        if (durableReceipt.generation !== metadata.operation.generation || durableReceipt.digest !== metadata.digest ||
            !receiptMatchesOperation(durableReceipt.receipt, metadata.operation)) {
          throw coreError(409, "publication_metadata_invalid", "The publication receipt does not match its checkpoint operation");
        }
        receipt = durableReceipt.receipt;
        foundReceipts.add(metadata.operation.id);
      }
      operations.push({ ...metadata, path: filePath, commit: changedAt, receipt });
    }
    if ([...publishedReceipts.keys()].some((operationId) => !foundReceipts.has(operationId))) {
      throw coreError(409, "publication_metadata_invalid", "A publication receipt references an operation that is not present in the repository");
    }
    return operations;
  }

  private async readLocalOperationRecords(root: string): Promise<StoredOperation[]> {
    const refs = (await git(root, ["for-each-ref", "--format=%(refname)", "refs/scriptorium/checkpoints/"]))
      .trim().split(/\r?\n/).filter(Boolean);
    const byId = new Map<string, StoredOperation>();
    for (const ref of refs) {
      const id = ref.slice("refs/scriptorium/checkpoints/".length);
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) continue;
      const commit = await this.getRef(root, ref);
      if (!commit) continue;
      const operation = (await this.readOperationRecords(root, commit)).find((item) => item.operation.id === id);
      if (operation) byId.set(id, operation);
    }
    return [...byId.values()].sort((a, b) => a.sequence - b.sequence || a.operation.id.localeCompare(b.operation.id));
  }

  private async checkpointHead(root: string): Promise<string> {
    const tracked = await this.getRef(root, "refs/scriptorium/checkpoint-head");
    if (tracked) return tracked;
    return this.getRef(root, "HEAD");
  }

  private async makeReader(root: string, snapshot: SnapshotId, commit: string): Promise<SnapshotReader> {
    return {
      snapshot,
      read: async (relativePath, encoding = "utf8") => {
        assertProjectPath(relativePath);
        if (encoding !== "utf8" && encoding !== "base64") throw coreError(400, "invalid_read_encoding", "Snapshot reads support UTF-8 or base64 encoding");
        return this.snapshotFile(root, commit, relativePath, encoding);
      },
      list: async (prefix) => this.snapshotFiles(root, commit, prefix),
    };
  }

  private async selectedSnapshotUnlocked(projectId: string, view: "remote" | "checkpoint" = "remote", pinned?: SnapshotId | string) {
    const observation = await this.requireObservation(projectId);
    const { record, root } = await this.getProject(projectId);
    let snapshot = observation.snapshot;
    if (view === "checkpoint") {
      const reconciled = await this.reconcileUnlocked(projectId);
      snapshot = reconciled.snapshot;
      if (reconciled.operations.some((operation) => operation.state === "conflict")) {
        const localHead = await this.checkpointHead(root);
        if (localHead && localHead !== snapshot.remoteCommit) snapshot = { ...snapshot, overlayCommit: localHead };
      }
    }
    if (typeof pinned === "string") {
      if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(pinned)) throw coreError(400, "invalid_snapshot", "A pinned snapshot must be a Git commit ID");
      snapshot = { ...snapshot, remoteCommit: pinned };
    } else if (pinned) {
      await this.ensureSnapshot(root, pinned, observation.snapshot.repository, observation.snapshot.remoteCommit);
      snapshot = pinned;
    }
    await this.ensureSnapshot(root, snapshot, observation.snapshot.repository, observation.snapshot.remoteCommit);
    return { snapshot, commit: view === "checkpoint" ? snapshot.overlayCommit ?? snapshot.remoteCommit : snapshot.remoteCommit, record, root };
  }

  private async parseSnapshotYaml(root: string, commit: string, filePath: string): Promise<{ text: string; data: Record<string, unknown> } | null> {
    const file = await this.snapshotFile(root, commit, filePath);
    if (!file) return null;
    let data: Record<string, unknown> | null;
    try { data = asRecord(YAML.parse(file.content)); }
    catch { throw coreError(422, "project_data_invalid", "A hierarchy YAML file is invalid"); }
    if (!data) throw coreError(422, "project_data_invalid", "A hierarchy YAML file must contain a mapping");
    return { text: file.content, data };
  }

  private async loadHierarchyRecords(root: string, commit: string): Promise<{
    files: string[];
    volumes: VolumeHierarchyRecord[];
    chapters: ChapterHierarchyRecord[];
    scenes: SceneHierarchyRecord[];
  }> {
    const files = await this.snapshotFiles(root, commit, "plot/volumes");
    const volumeDirectories = [...new Set(files.flatMap((file) => {
      const match = /^plot\/volumes\/([^/]+)\//.exec(file);
      return match?.[1] ? [match[1]] : [];
    }))];
    const volumes: VolumeHierarchyRecord[] = [];
    const chapters: ChapterHierarchyRecord[] = [];
    const scenes: SceneHierarchyRecord[] = [];
    for (const directoryName of volumeDirectories) {
      const directory = `plot/volumes/${directoryName}`;
      const volumePath = `${directory}/volume.yaml`;
      const volumeYaml = await this.parseSnapshotYaml(root, commit, volumePath);
      const volumeData = volumeYaml?.data ?? { id: directoryName };
      const volumeId = typeof volumeData.id === "string" ? volumeData.id : directoryName;
      volumes.push({
        id: volumeId,
        title: titleOf(volumeData, volumeId),
        directory,
        path: volumePath,
        revision: volumeYaml ? revisionForBytes(volumeYaml.text) : null,
        data: volumeData,
      });
      const chapterPrefix = `${directory}/chapters/`;
      const chapterDirectories = [...new Set(files.flatMap((file) => {
        if (!file.startsWith(chapterPrefix)) return [];
        const match = /^([^/]+)\//.exec(file.slice(chapterPrefix.length));
        return match?.[1] ? [match[1]] : [];
      }))];
      for (const chapterDirectoryName of chapterDirectories) {
        const chapterDirectory = `${chapterPrefix}${chapterDirectoryName}`;
        const chapterPath = `${chapterDirectory}/chapter.yaml`;
        const chapterYaml = await this.parseSnapshotYaml(root, commit, chapterPath);
        const chapterData = chapterYaml?.data ?? { id: chapterDirectoryName };
        const chapterId = typeof chapterData.id === "string" ? chapterData.id : chapterDirectoryName;
        chapters.push({
          id: chapterId,
          title: titleOf(chapterData, chapterId),
          directory: chapterDirectory,
          path: chapterPath,
          revision: chapterYaml ? revisionForBytes(chapterYaml.text) : null,
          volumeId,
          data: chapterData,
        });
        const scenePrefix = `${chapterDirectory}/scenes/`;
        for (const scenePath of files.filter((file) => file.startsWith(scenePrefix) && file.endsWith(".yaml"))) {
          const sceneYaml = await this.parseSnapshotYaml(root, commit, scenePath);
          if (!sceneYaml) continue;
          const sceneId = typeof sceneYaml.data.id === "string" ? sceneYaml.data.id : path.posix.basename(scenePath, ".yaml");
          scenes.push({
            id: sceneId,
            title: titleOf(sceneYaml.data, sceneId),
            path: scenePath,
            revision: revisionForBytes(sceneYaml.text),
            data: sceneYaml.data,
            volumeId,
            chapterId,
          });
        }
      }
    }
    return { files, volumes, chapters, scenes };
  }

  async observe(projectId: string): Promise<RemoteObservation> {
    return this.withProjectLock(projectId, () => this.requireObservation(projectId));
  }

  async reader(
    projectId: string,
    view: "remote" | "checkpoint" = "remote",
    pinned?: SnapshotId | string,
  ): Promise<SnapshotReader> {
    return this.withProjectLock(projectId, async () => {
      const selected = await this.selectedSnapshotUnlocked(projectId, view, pinned);
      return this.makeReader(selected.root, selected.snapshot, selected.commit);
    });
  }

  async readTreeSnapshot(projectId: string, view: "remote" | "checkpoint" = "remote", pinned?: SnapshotId | string): Promise<{ snapshot: SnapshotId; tree: Tree }> {
    return this.withProjectLock(projectId, async () => {
      const selected = await this.selectedSnapshotUnlocked(projectId, view, pinned);
      let title = repositoryTitle(selected.record.url);
      const project = await this.parseSnapshotYaml(selected.root, selected.commit, "meta/project.yaml");
      if (project) title = titleOf(project.data, title);
      const files = await this.snapshotFiles(selected.root, selected.commit, "plot/volumes");
      const volumeIds = [...new Set(files.flatMap((file) => {
        const found = file.match(/^plot\/volumes\/([^/]+)\//)?.[1];
        return found ? [found] : [];
      }))];
      const volumes: TreeVolume[] = [];
      const seen = new Set<string>();
      for (const volumeId of volumeIds) {
        const volumeData = (await this.parseSnapshotYaml(selected.root, selected.commit, `plot/volumes/${volumeId}/volume.yaml`))?.data ?? { id: volumeId };
        const volumeKey = typeof volumeData.id === "string" ? volumeData.id : volumeId;
        if (seen.has(volumeKey)) throw coreError(409, "duplicate_entity_id", "The project contains duplicate hierarchy ids");
        seen.add(volumeKey);
        const prefix = `plot/volumes/${volumeId}/chapters/`;
        const chapterIds = [...new Set(files.flatMap((file) => {
          if (!file.startsWith(prefix)) return [];
          const found = file.slice(prefix.length).match(/^([^/]+)\//)?.[1];
          return found ? [found] : [];
        }))];
        const chapters: TreeChapter[] = [];
        for (const chapterId of chapterIds) {
          const base = `${prefix}${chapterId}`;
          const chapterData = (await this.parseSnapshotYaml(selected.root, selected.commit, `${base}/chapter.yaml`))?.data ?? { id: chapterId };
          const chapterKey = typeof chapterData.id === "string" ? chapterData.id : chapterId;
          if (seen.has(chapterKey)) throw coreError(409, "duplicate_entity_id", "The project contains duplicate hierarchy ids");
          seen.add(chapterKey);
          const sceneEntries: Array<TreeScene & { order?: number }> = [];
          for (const file of files.filter((candidate) => candidate.startsWith(`${base}/scenes/`) && candidate.endsWith(".yaml"))) {
            const yaml = await this.parseSnapshotYaml(selected.root, selected.commit, file);
            if (!yaml) continue;
            const sceneId = typeof yaml.data.id === "string" ? yaml.data.id : path.posix.basename(file, ".yaml");
            if (seen.has(sceneId)) throw coreError(409, "duplicate_scene_id", "The project contains duplicate scene ids");
            seen.add(sceneId);
            sceneEntries.push({
              id: sceneId,
              title: titleOf(yaml.data, sceneId),
              ...(typeof yaml.data.order === "number" && Number.isFinite(yaml.data.order) ? { order: yaml.data.order } : {}),
            });
          }
          const scenes = sortByOrderAndTitle(sceneEntries).map(({ id, title }) => ({ id, title }));
          chapters.push({ id: chapterKey, title: titleOf(chapterData, chapterKey), scenes });
        }
        volumes.push({ id: volumeKey, title: titleOf(volumeData, volumeKey), chapters: chapters.sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id)) });
      }
      return { snapshot: selected.snapshot, tree: { title, volumes: volumes.sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id)) } };
    });
  }

  async readSceneSnapshot(
    projectId: string,
    sceneId: string,
    view: "remote" | "checkpoint" = "remote",
    pinned?: SnapshotId | string,
  ): Promise<{ snapshot: SnapshotId; scene: Scene; document: { path: string; content: string; revision: string | null }; metadata: { path: string; content: string; revision: string } }> {
    return this.withProjectLock(projectId, async () => {
      const selected = await this.selectedSnapshotUnlocked(projectId, view, pinned);
      const files = await this.snapshotFiles(selected.root, selected.commit, "plot/volumes");
      const matches: Array<{ path: string; text: string; data: Record<string, unknown> }> = [];
      for (const file of files.filter((candidate) => /\/scenes\/[^/]+\.yaml$/.test(candidate))) {
        const yaml = await this.parseSnapshotYaml(selected.root, selected.commit, file);
        if (!yaml) continue;
        const id = typeof yaml.data.id === "string" ? yaml.data.id : path.posix.basename(file, ".yaml");
        if (id === sceneId) matches.push({ path: file, text: yaml.text, data: yaml.data });
      }
      if (!matches.length) throw coreError(404, "scene_not_found", "Scene not found");
      if (matches.length > 1) throw coreError(409, "duplicate_scene_id", "The project contains duplicate scene ids");
      const found = matches[0]!;
      const parts = found.path.split("/");
      const manuscriptPath = typeof found.data.manuscript === "string"
        ? safeRelativePath(found.data.manuscript).split(path.sep).join("/")
        : `manuscript/${parts[2]}/${parts[4]}/${sceneId}.md`;
      try { assertProjectPath(manuscriptPath); }
      catch { throw coreError(422, "invalid_manuscript_path", "The scene has an unsafe manuscript path"); }
      let documentFile: { content: string; revision: string } | null;
      try { documentFile = await this.snapshotFile(selected.root, selected.commit, manuscriptPath); }
      catch (error) {
        if (error instanceof CoreError && error.code === "unsafe_project_path") throw coreError(422, "unsafe_manuscript_path", "The scene manuscript path crosses a symbolic link");
        throw error;
      }
      const content = documentFile?.content ?? "";
      return {
        snapshot: selected.snapshot,
        scene: { id: sceneId, title: titleOf(found.data, sceneId), text: parseMarkdownDocument(content).body, revision: revisionFor(found.text, content) },
        document: { path: manuscriptPath, content, revision: documentFile?.revision ?? null },
        metadata: { path: found.path, content: found.text, revision: revisionForBytes(found.text) },
      };
    });
  }

  async searchSnapshot(
    projectId: string,
    query: string,
    limit = 20,
    view: "remote" | "checkpoint" = "remote",
    pinned?: SnapshotId | string,
  ): Promise<{ snapshot: SnapshotId; results: LiteralSearchResult[] }> {
    if (typeof query !== "string" || query.length > 512) {
      throw coreError(400, "invalid_search_query", "Search query must be a string of at most 512 characters");
    }
    if (!Number.isFinite(limit) || limit < 1) throw coreError(400, "invalid_search_limit", "Search limit must be a positive number");
    if (!query) return this.withProjectLock(projectId, async () => {
      const selected = await this.selectedSnapshotUnlocked(projectId, view, pinned);
      return { snapshot: selected.snapshot, results: [] };
    });
    const resultLimit = Math.min(100, Math.floor(limit));
    return this.withProjectLock(projectId, async () => {
      const selected = await this.selectedSnapshotUnlocked(projectId, view, pinned);
      const files = await this.snapshotFiles(selected.root, selected.commit, "plot/volumes");
      const resultsByEntity = new Map<string, LiteralSearchResult>();
      const sceneIds = new Set<string>();
      const add = (result: LiteralSearchResult): void => {
        const key = `${result.type}:${result.id}`;
        const previous = resultsByEntity.get(key);
        if (!previous || result.score > previous.score || (result.score === previous.score && (result.offset ?? Infinity) < (previous.offset ?? Infinity))) {
          resultsByEntity.set(key, result);
        }
      };
      const titleHit = (input: { id: string; type: "scene" | "chapter" | "volume"; title: string; filePath: string }): void => {
        const match = findLiteralInsensitive(input.title, query);
        if (!match) return;
        add({
          id: input.id,
          type: input.type,
          name: input.title,
          snippet: searchSnippet(input.title, match.offset, match.length),
          filePath: input.filePath,
          score: 0.5,
          field: "name",
          offset: match.offset,
          length: match.length,
        });
      };

      const volumeDirectories = [...new Set(files.flatMap((file) => {
        const match = /^plot\/volumes\/([^/]+)\//.exec(file);
        return match?.[1] ? [match[1]] : [];
      }))];
      for (const volumeDirectory of volumeDirectories) {
        const volumePath = `plot/volumes/${volumeDirectory}/volume.yaml`;
        const volume = (await this.parseSnapshotYaml(selected.root, selected.commit, volumePath))?.data ?? { id: volumeDirectory };
        const volumeId = typeof volume.id === "string" ? volume.id : volumeDirectory;
        titleHit({ id: volumeId, type: "volume", title: titleOf(volume, volumeId), filePath: volumePath });
        const chapterPrefix = `plot/volumes/${volumeDirectory}/chapters/`;
        const chapterDirectories = [...new Set(files.flatMap((file) => {
          if (!file.startsWith(chapterPrefix)) return [];
          const match = /^([^/]+)\//.exec(file.slice(chapterPrefix.length));
          return match?.[1] ? [match[1]] : [];
        }))];
        for (const chapterDirectory of chapterDirectories) {
          const chapterPath = `${chapterPrefix}${chapterDirectory}/chapter.yaml`;
          const chapter = (await this.parseSnapshotYaml(selected.root, selected.commit, chapterPath))?.data ?? { id: chapterDirectory };
          const chapterId = typeof chapter.id === "string" ? chapter.id : chapterDirectory;
          titleHit({ id: chapterId, type: "chapter", title: titleOf(chapter, chapterId), filePath: chapterPath });
          const scenePrefix = `${chapterPrefix}${chapterDirectory}/scenes/`;
          for (const scenePath of files.filter((file) => file.startsWith(scenePrefix) && file.endsWith(".yaml"))) {
            const parsed = await this.parseSnapshotYaml(selected.root, selected.commit, scenePath);
            if (!parsed) continue;
            const sceneId = typeof parsed.data.id === "string" ? parsed.data.id : path.posix.basename(scenePath, ".yaml");
            if (sceneIds.has(sceneId)) throw coreError(409, "duplicate_scene_id", "The project contains duplicate scene ids");
            sceneIds.add(sceneId);
            const title = titleOf(parsed.data, sceneId);
            titleHit({ id: sceneId, type: "scene", title, filePath: scenePath });
            const parts = scenePath.split("/");
            const manuscriptPath = typeof parsed.data.manuscript === "string"
              ? safeRelativePath(parsed.data.manuscript).split(path.sep).join("/")
              : `manuscript/${parts[2]}/${parts[4]}/${sceneId}.md`;
            assertProjectPath(manuscriptPath);
            const document = await this.snapshotFile(selected.root, selected.commit, manuscriptPath);
            if (!document) continue;
            const body = parseMarkdownDocument(document.content).body;
            const match = findLiteralInsensitive(body, query);
            if (!match) continue;
            add({
              id: sceneId,
              type: "scene",
              name: title,
              snippet: searchSnippet(body, match.offset, match.length),
              filePath: manuscriptPath,
              score: 1,
              field: "body",
              offset: match.offset,
              length: match.length,
            });
          }
        }
      }

      for (const scratchPath of await this.snapshotFiles(selected.root, selected.commit, "meta/scratch")) {
        if (!scratchPath.toLowerCase().endsWith(".md")) continue;
        const document = await this.snapshotFile(selected.root, selected.commit, scratchPath);
        if (!document) continue;
        const body = parseMarkdownDocument(document.content).body;
        const match = findLiteralInsensitive(body, query);
        if (!match) continue;
        const name = path.posix.basename(scratchPath, ".md");
        add({
          id: `scratch:${scratchPath}`,
          type: "manuscript",
          name,
          snippet: searchSnippet(body, match.offset, match.length),
          filePath: scratchPath,
          score: 1,
          field: "body",
          offset: match.offset,
          length: match.length,
        });
      }

      const results = [...resultsByEntity.values()]
        .sort((a, b) => b.score - a.score || a.filePath.localeCompare(b.filePath) || (a.offset ?? 0) - (b.offset ?? 0))
        .slice(0, resultLimit);
      return { snapshot: selected.snapshot, results };
    });
  }

  async writingStatsSnapshot(
    projectId: string,
    view: "remote" | "checkpoint" = "remote",
    pinned?: SnapshotId | string,
  ): Promise<{ snapshot: SnapshotId; stats: WritingStats }> {
    return this.withProjectLock(projectId, async () => {
      const selected = await this.selectedSnapshotUnlocked(projectId, view, pinned);
      const files = await this.snapshotFiles(selected.root, selected.commit, "plot/volumes");
      const sceneById: Record<string, SceneWritingStats> = Object.create(null) as Record<string, SceneWritingStats>;
      let totalCharCount = 0;
      const volumeDirectories = [...new Set(files.flatMap((file) => {
        const match = /^plot\/volumes\/([^/]+)\//.exec(file);
        return match?.[1] ? [match[1]] : [];
      }))];
      const orderOf = (data: Record<string, unknown>): number => typeof data.order === "number" && Number.isFinite(data.order) ? data.order : 0;
      const volumes: VolumeWritingStats[] = [];
      const seenIds = new Set<string>();
      const orderedVolumes: Array<{ directory: string; id: string; data: Record<string, unknown>; title: string }> = [];
      for (const directory of volumeDirectories) {
        const volumePath = `plot/volumes/${directory}/volume.yaml`;
        const data = (await this.parseSnapshotYaml(selected.root, selected.commit, volumePath))?.data ?? { id: directory };
        const id = typeof data.id === "string" ? data.id : directory;
        orderedVolumes.push({ directory, id, data, title: titleOf(data, id) });
      }
      orderedVolumes.sort((a, b) => orderOf(a.data) - orderOf(b.data) || a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
      for (const orderedVolume of orderedVolumes) {
        const volumeDirectory = orderedVolume.directory;
        const volumeId = orderedVolume.id;
        const chapterPrefix = `plot/volumes/${volumeDirectory}/chapters/`;
        const chapterDirectories = [...new Set(files.flatMap((file) => {
          if (!file.startsWith(chapterPrefix)) return [];
          const match = /^([^/]+)\//.exec(file.slice(chapterPrefix.length));
          return match?.[1] ? [match[1]] : [];
        }))];
        const chapters: ChapterWritingStats[] = [];
        let volumeCharCount = 0;
        const orderedChapters: Array<{ directory: string; id: string; data: Record<string, unknown>; title: string }> = [];
        for (const directory of chapterDirectories) {
          const chapterPath = `${chapterPrefix}${directory}/chapter.yaml`;
          const data = (await this.parseSnapshotYaml(selected.root, selected.commit, chapterPath))?.data ?? { id: directory };
          const id = typeof data.id === "string" ? data.id : directory;
          orderedChapters.push({ directory, id, data, title: titleOf(data, id) });
        }
        orderedChapters.sort((a, b) => orderOf(a.data) - orderOf(b.data) || a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
        for (const chapter of orderedChapters) {
          const chapterDirectory = `${chapterPrefix}${chapter.directory}`;
          const scenePrefix = `${chapterDirectory}/scenes/`;
          const orderedScenes: Array<{ path: string; id: string; data: Record<string, unknown>; title: string }> = [];
          for (const scenePath of files.filter((file) => file.startsWith(scenePrefix) && file.endsWith(".yaml"))) {
            const parsed = await this.parseSnapshotYaml(selected.root, selected.commit, scenePath);
            if (!parsed) continue;
            const id = typeof parsed.data.id === "string" ? parsed.data.id : path.posix.basename(scenePath, ".yaml");
            orderedScenes.push({ path: scenePath, id, data: parsed.data, title: titleOf(parsed.data, id) });
          }
          orderedScenes.sort((a, b) => orderOf(a.data) - orderOf(b.data) || a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
          const scenes: SceneWritingStats[] = [];
          let chapterCharCount = 0;
          for (const scene of orderedScenes) {
            if (seenIds.has(scene.id)) throw coreError(409, "duplicate_scene_id", "The project contains duplicate scene ids");
            seenIds.add(scene.id);
            const parts = scene.path.split("/");
            const manuscriptPath = typeof scene.data.manuscript === "string"
              ? safeRelativePath(scene.data.manuscript).split(path.sep).join("/")
              : `manuscript/${parts[2]}/${parts[4]}/${scene.id}.md`;
            assertProjectPath(manuscriptPath);
            const documentFile = await this.snapshotFile(selected.root, selected.commit, manuscriptPath);
            const document = parseMarkdownDocument(documentFile?.content ?? "");
            const charCount = document.body.length;
            const rawStatus = scene.data.status;
            const status = typeof rawStatus === "string" && rawStatus ? rawStatus :
              typeof document.data.status === "string" ? document.data.status : undefined;
            const stat: SceneWritingStats = {
              sceneId: scene.id,
              charCount,
              pages400: pages400(charCount),
              ...(status !== undefined ? { status } : {}),
            };
            scenes.push(stat);
            sceneById[scene.id] = stat;
            chapterCharCount += charCount;
          }
          chapters.push({
            chapterId: chapter.id,
            charCount: chapterCharCount,
            pages400: pages400(chapterCharCount),
            scenes,
          });
          volumeCharCount += chapterCharCount;
        }
        volumes.push({ volumeId, charCount: volumeCharCount, pages400: pages400(volumeCharCount), chapters });
        totalCharCount += volumeCharCount;
      }
      return {
        snapshot: selected.snapshot,
        stats: { totalCharCount, totalPages400: pages400(totalCharCount), volumes, sceneById },
      };
    });
  }

  private makeBuiltOperation(
    snapshot: SnapshotId,
    effect: ChangeOperation["effect"],
    writes: FileChange[],
    message: string,
  ): BuiltChangeOperation {
    const operation: ChangeOperation = {
      id: randomUUID(),
      generation: 0,
      repository: structuredClone(snapshot.repository),
      baseRemoteCommit: snapshot.remoteCommit,
      effect,
      reads: writes.map(({ path: filePath, revision }) => ({ path: filePath, revision })),
      writes,
      message,
    };
    try {
      assertChangeOperation(operation);
      assertUserOperationPaths(operation);
    } catch {
      throw coreError(400, "invalid_change_operation", "The Core builder produced an invalid change operation");
    }
    return { snapshot: structuredClone(snapshot), operation };
  }

  async buildCreateHierarchyOperation(
    projectId: string,
    input: CreateHierarchyInput,
    view: "remote" | "checkpoint" = "remote",
    pinned?: SnapshotId | string,
  ): Promise<BuiltChangeOperation> {
    if (!input || !["volume", "chapter", "scene"].includes(input.kind)) {
      throw coreError(400, "invalid_hierarchy_operation", "A volume, chapter, or scene creation is required");
    }
    const id = hierarchyId(input.id);
    const title = hierarchyTitle(input.title);
    let volumeId: string | undefined;
    let chapterId: string | undefined;
    if (input.kind !== "volume") volumeId = hierarchyId(input.volumeId);
    if (input.kind === "scene") chapterId = hierarchyId(input.chapterId);
    let body = "";
    if (input.kind === "scene") {
      if (input.manuscriptBody !== undefined && typeof input.manuscriptBody !== "string") {
        throw coreError(400, "invalid_manuscript_body", "Scene manuscript body must be text");
      }
      body = input.manuscriptBody ?? "";
      if (Buffer.byteLength(body, "utf8") > 8 * 1024 * 1024) throw coreError(413, "manuscript_too_large", "Scene manuscript body exceeds the operation limit");
    }

    return this.withProjectLock(projectId, async () => {
      const selected = await this.selectedSnapshotUnlocked(projectId, view, pinned);
      const hierarchy = await this.loadHierarchyRecords(selected.root, selected.commit);
      if ([...hierarchy.volumes, ...hierarchy.chapters, ...hierarchy.scenes].some((node) => node.id === id)) {
        throw coreError(409, "hierarchy_id_exists", "The hierarchy ID is already in use");
      }
      let writes: FileChange[];
      let message: string;
      if (input.kind === "volume") {
        const directory = `plot/volumes/${id}`;
        const metadataPath = `${directory}/volume.yaml`;
        if (hierarchy.files.some((file) => file === metadataPath || file.startsWith(`${directory}/`))) {
          throw coreError(409, "hierarchy_path_exists", "The volume path already contains project files");
        }
        const order = Math.max(0, ...hierarchy.volumes.map((volume) => hierarchyOrder(volume.data))) + 1;
        writes = [{ path: metadataPath, revision: null, content: YAML.stringify({ id, name: title, title, order }) }];
        message = `loom(structure): create volume ${id}`;
      } else {
        const parentVolume = hierarchy.volumes.filter((volume) => volume.id === volumeId);
        if (parentVolume.length !== 1) {
          if (!parentVolume.length) throw coreError(404, "volume_not_found", "The parent volume was not found");
          throw coreError(409, "duplicate_entity_id", "The project contains duplicate volume IDs");
        }
        const volume = parentVolume[0]!;
        if (input.kind === "chapter") {
          const directory = `${volume.directory}/chapters/${id}`;
          const metadataPath = `${directory}/chapter.yaml`;
          if (hierarchy.files.some((file) => file === metadataPath || file.startsWith(`${directory}/`))) {
            throw coreError(409, "hierarchy_path_exists", "The chapter path already contains project files");
          }
          const siblings = hierarchy.chapters.filter((chapter) => chapter.volumeId === volume.id);
          const order = Math.max(0, ...siblings.map((chapter) => hierarchyOrder(chapter.data))) + 1;
          writes = [{ path: metadataPath, revision: null, content: YAML.stringify({ id, title, volume: volume.id, order }) }];
          message = `loom(structure): create chapter ${id}`;
        } else {
          const parentChapters = hierarchy.chapters.filter((chapter) => chapter.id === chapterId && chapter.volumeId === volume.id);
          if (parentChapters.length !== 1) {
            if (!parentChapters.length) throw coreError(404, "chapter_not_found", "The parent chapter was not found in the selected volume");
            throw coreError(409, "duplicate_entity_id", "The project contains duplicate chapter IDs");
          }
          const chapter = parentChapters[0]!;
          const directory = `${chapter.directory}/scenes`;
          const metadataPath = `${directory}/${id}.yaml`;
          const manuscriptPath = `manuscript/${path.posix.basename(volume.directory)}/${path.posix.basename(chapter.directory)}/${id}.md`;
          try { assertProjectPath(metadataPath); assertProjectPath(manuscriptPath); }
          catch { throw coreError(400, "invalid_hierarchy_id", "The scene ID cannot form a safe project path"); }
          if (hierarchy.files.includes(metadataPath) || hierarchy.files.includes(manuscriptPath)) {
            throw coreError(409, "hierarchy_path_exists", "The scene or manuscript path already exists");
          }
          if (await this.snapshotFile(selected.root, selected.commit, manuscriptPath)) {
            throw coreError(409, "hierarchy_path_exists", "The scene manuscript path already exists");
          }
          const siblings = hierarchy.scenes.filter((scene) => scene.chapterId === chapter.id && scene.volumeId === volume.id);
          const order = Math.max(0, ...siblings.map((scene) => hierarchyOrder(scene.data))) + 1;
          writes = [
            {
              path: metadataPath,
              revision: null,
              content: YAML.stringify({
                id,
                type: "scene",
                name: title,
                title,
                volume: volume.id,
                chapter: chapter.id,
                manuscript: manuscriptPath,
                order,
              }),
            },
            { path: manuscriptPath, revision: null, content: body },
          ];
          message = `loom(structure): create scene ${id}`;
        }
      }
      return this.makeBuiltOperation(selected.snapshot, "structure", writes, message);
    });
  }

  async buildDeleteHierarchyOperation(
    projectId: string,
    target: HierarchyTarget,
    view: "remote" | "checkpoint" = "remote",
    pinned?: SnapshotId | string,
  ): Promise<BuiltChangeOperation> {
    if (!target || !["volume", "chapter", "scene"].includes(target.kind)) {
      throw coreError(400, "invalid_hierarchy_operation", "A volume, chapter, or scene deletion is required");
    }
    const id = hierarchyId(target.id);
    const volumeId = target.kind === "volume" ? undefined : hierarchyId(target.volumeId);
    const chapterId = target.kind === "scene" ? hierarchyId(target.chapterId) : undefined;
    return this.withProjectLock(projectId, async () => {
      const selected = await this.selectedSnapshotUnlocked(projectId, view, pinned);
      const hierarchy = await this.loadHierarchyRecords(selected.root, selected.commit);
      let writes: FileChange[];
      if (target.kind === "volume") {
        const matches = hierarchy.volumes.filter((volume) => volume.id === id);
        if (matches.length !== 1) {
          if (!matches.length) throw coreError(404, "volume_not_found", "The volume was not found");
          throw coreError(409, "duplicate_entity_id", "The project contains duplicate volume IDs");
        }
        const volume = matches[0]!;
        if (hierarchy.chapters.some((chapter) => chapter.volumeId === volume.id)) {
          throw coreError(409, "hierarchy_not_empty", "Delete the volume's chapters before deleting the volume");
        }
        if (hierarchy.files.some((file) => file.startsWith(`${volume.directory}/`) && file !== volume.path)) {
          throw coreError(409, "hierarchy_contains_unknown_files", "The volume contains files outside its Core hierarchy metadata");
        }
        if (volume.revision === null) throw coreError(409, "hierarchy_metadata_missing", "The volume metadata file is missing");
        writes = [{ path: volume.path, revision: volume.revision, content: null }];
      } else if (target.kind === "chapter") {
        const matches = hierarchy.chapters.filter((chapter) => chapter.id === id && chapter.volumeId === volumeId);
        if (matches.length !== 1) {
          if (!matches.length) throw coreError(404, "chapter_not_found", "The chapter was not found in the selected volume");
          throw coreError(409, "duplicate_entity_id", "The project contains duplicate chapter IDs");
        }
        const chapter = matches[0]!;
        if (hierarchy.scenes.some((scene) => scene.volumeId === chapter.volumeId && scene.chapterId === chapter.id)) {
          throw coreError(409, "hierarchy_not_empty", "Delete the chapter's scenes before deleting the chapter");
        }
        if (hierarchy.files.some((file) => file.startsWith(`${chapter.directory}/`) && file !== chapter.path)) {
          throw coreError(409, "hierarchy_contains_unknown_files", "The chapter contains files outside its Core hierarchy metadata");
        }
        if (chapter.revision === null) throw coreError(409, "hierarchy_metadata_missing", "The chapter metadata file is missing");
        writes = [{ path: chapter.path, revision: chapter.revision, content: null }];
      } else {
        const matches = hierarchy.scenes.filter((scene) => scene.id === id && scene.volumeId === volumeId && scene.chapterId === chapterId);
        if (matches.length !== 1) {
          if (!matches.length) throw coreError(404, "scene_not_found", "The scene was not found in the selected hierarchy");
          throw coreError(409, "duplicate_scene_id", "The project contains duplicate scene IDs");
        }
        const scene = matches[0]!;
        const parts = scene.path.split("/");
        const manuscriptPath = typeof scene.data.manuscript === "string"
          ? safeRelativePath(scene.data.manuscript).split(path.sep).join("/")
          : `manuscript/${parts[2]}/${parts[4]}/${scene.id}.md`;
        assertProjectPath(manuscriptPath);
        if (hierarchy.scenes.some((other) => other.id !== scene.id && (
          typeof other.data.manuscript === "string"
            ? safeRelativePath(other.data.manuscript).split(path.sep).join("/")
            : `manuscript/${other.path.split("/")[2]}/${other.path.split("/")[4]}/${other.id}.md`
        ) === manuscriptPath)) {
          throw coreError(409, "shared_manuscript_path", "The scene manuscript is shared with another scene and cannot be removed");
        }
        const manuscript = await this.snapshotFile(selected.root, selected.commit, manuscriptPath);
        writes = [
          { path: scene.path, revision: scene.revision, content: null },
          { path: manuscriptPath, revision: manuscript?.revision ?? null, content: null },
        ];
      }
      return this.makeBuiltOperation(selected.snapshot, "structure", writes, `loom(structure): delete ${target.kind} ${id}`);
    });
  }

  async buildReorderHierarchyOperation(
    projectId: string,
    input: ReorderHierarchyInput,
    view: "checkpoint" | "remote" = "remote",
    pinned?: SnapshotId | string,
  ): Promise<BuiltChangeOperation> {
    if (!input || !["volume", "chapter", "scene"].includes(input.kind) || !Array.isArray(input.orderedIds)) {
      throw coreError(400, "invalid_hierarchy_order", "An ordered list of volume, chapter, or scene IDs is required");
    }
    if (input.orderedIds.length === 0 || input.orderedIds.length > 256) {
      throw coreError(400, "invalid_hierarchy_order", "Reordering requires between 1 and 256 sibling IDs");
    }
    const orderedIds = input.orderedIds.map(hierarchyId);
    if (new Set(orderedIds).size !== orderedIds.length) throw coreError(400, "invalid_hierarchy_order", "Sibling IDs must be unique");
    const volumeId = input.kind === "volume" ? undefined : hierarchyId(input.volumeId);
    const chapterId = input.kind === "scene" ? hierarchyId(input.chapterId) : undefined;
    return this.withProjectLock(projectId, async () => {
      const selected = await this.selectedSnapshotUnlocked(projectId, view, pinned);
      const hierarchy = await this.loadHierarchyRecords(selected.root, selected.commit);
      const siblings = input.kind === "volume"
        ? hierarchy.volumes
        : input.kind === "chapter"
          ? hierarchy.chapters.filter((chapter) => chapter.volumeId === volumeId)
          : hierarchy.scenes.filter((scene) => scene.volumeId === volumeId && scene.chapterId === chapterId);
      if (siblings.length !== orderedIds.length || orderedIds.some((id) => !siblings.some((item) => item.id === id))) {
        throw coreError(409, "hierarchy_order_membership_changed", "The order must include every current sibling exactly once");
      }
      const sortedCurrent = [...siblings].sort((a, b) => hierarchyOrder(a.data) - hierarchyOrder(b.data) || a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
      if (sortedCurrent.every((item, index) => item.id === orderedIds[index])) {
        throw coreError(409, "hierarchy_order_unchanged", "The hierarchy already has the requested order");
      }
      const records = new Map(siblings.map((item) => [item.id, item]));
      const writes: FileChange[] = orderedIds.map((id, index) => {
        const item = records.get(id)!;
        return {
          path: item.path,
          revision: item.revision,
          content: YAML.stringify({ ...item.data, order: index + 1 }),
        };
      });
      const parent = input.kind === "volume" ? "" : input.kind === "chapter" ? ` in volume ${volumeId}` : ` in chapter ${chapterId}`;
      return this.makeBuiltOperation(selected.snapshot, "structure", writes, `loom(structure): reorder ${input.kind}${parent}`);
    });
  }

  async buildRestoreOperation(
    projectId: string,
    operationId: string,
    view: "remote" | "checkpoint" = "remote",
    pinned?: SnapshotId | string,
  ): Promise<BuiltChangeOperation> {
    if (typeof operationId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(operationId)) {
      throw coreError(400, "invalid_operation_id", "The operation ID is invalid");
    }
    return this.withProjectLock(projectId, async () => {
      const selected = await this.selectedSnapshotUnlocked(projectId, view, pinned);
      const operations = await this.readOperationRecords(selected.root, selected.commit);
      const stored = operations.find((item) => item.operation.id === operationId);
      if (!stored) throw coreError(404, "checkpoint_not_found", "The approved checkpoint was not found in this selected history");
      if (!receiptMatchesOperation(stored.receipt, stored.operation)) {
        throw coreError(409, "checkpoint_receipt_invalid", "The checkpoint receipt does not match its approved operation");
      }
      const parentOutput = (await git(selected.root, ["show", "-s", "--format=%P", stored.commit])).trim();
      const checkpointParent = parentOutput.split(/\s+/)[0] ?? "";
      const writes: FileChange[] = [];
      for (const original of stored.operation.writes) {
        const expected = stored.receipt.revisions.find((revision) => revision.path === original.path);
        if (!expected) throw coreError(409, "checkpoint_receipt_invalid", "The checkpoint receipt is missing an affected file");
        const current = await this.snapshotFile(selected.root, selected.commit, original.path, "base64");
        if ((current?.revision ?? null) !== expected.revision) {
          throw coreError(409, "restore_target_changed", `The checkpoint effect changed after it was approved: ${original.path}`);
        }
        const before = checkpointParent ? await this.snapshotFile(selected.root, checkpointParent, original.path, "base64") : null;
        writes.push({
          path: original.path,
          revision: current?.revision ?? null,
          content: before?.content ?? null,
          ...(before ? { encoding: "base64" as const } : {}),
        });
      }
      return this.makeBuiltOperation(
        selected.snapshot,
        stored.operation.effect,
        writes,
        `loom(restore): ${operationId}`,
      );
    });
  }

  private buildProposalStatus(
    projectId: string,
    proposal: ChangeProposal,
    observation: RemoteObservation,
    storedOperations: Map<string, StoredOperation>,
    publishedOperationIds: Set<string>,
  ): ProposalStatus {
    const approval = this.approvals.get(projectId)?.get(proposal.id);
    const approvedOperationIds: string[] = [];
    const checkpoints: CheckpointReceipt[] = [];
    const published: string[] = [];
    for (const operation of proposal.operations) {
      const digest = operationDigest(operation);
      const stored = storedOperations.get(operation.id);
      const matches = stored && stored.digest === digest && stored.operation.generation === operation.generation && receiptMatchesOperation(stored.receipt, operation);
      if (approval?.operationDigests.get(operation.id) === digest || (matches && !!stored.authorScope)) {
        approvedOperationIds.push(operation.id);
      }
      if (matches) checkpoints.push(structuredClone(stored.receipt));
      if (matches && publishedOperationIds.has(operation.id)) published.push(operation.id);
    }
    const total = proposal.operations.length;
    const checkpointedCount = checkpoints.length;
    const coveredOperationIds = new Set([
      ...approvedOperationIds,
      ...checkpoints.map((receipt) => receipt.operationId),
    ]);
    const state: ProposalStatus["state"] = checkpointedCount === total
      ? "checkpointed"
      : coveredOperationIds.size === total
        ? "approved"
        : coveredOperationIds.size > 0
          ? "partially_approved"
          : "proposed";
    return {
      proposal: structuredClone(proposal),
      state,
      approvedOperationIds,
      checkpoints,
      publishedOperationIds: published,
      stale: snapshotKey({ repository: proposal.snapshot.repository, remoteCommit: proposal.snapshot.remoteCommit }) !==
        snapshotKey({ repository: observation.snapshot.repository, remoteCommit: observation.snapshot.remoteCommit }),
    };
  }

  private async proposalOperationRecords(root: string, observation: RemoteObservation): Promise<{
    records: Map<string, StoredOperation>;
    publishedOperationIds: Set<string>;
  }> {
    const remote = observation.snapshot.remoteCommit ? await this.readOperationRecords(root, observation.snapshot.remoteCommit) : [];
    const local = await this.readLocalOperationRecords(root);
    const records = new Map<string, StoredOperation>();
    for (const stored of local) records.set(stored.operation.id, stored);
    for (const stored of remote) records.set(stored.operation.id, stored);
    return { records, publishedOperationIds: new Set(remote.map((stored) => stored.operation.id)) };
  }

  private async loadProjectProposals(
    record: ProjectRecord,
    root: string,
    observation: RemoteObservation,
    operations?: { records: Map<string, StoredOperation>; publishedOperationIds: Set<string> },
  ): Promise<Map<string, ChangeProposal>> {
    const storedOperations = operations ?? await this.proposalOperationRecords(root, observation);
    const proposals = new Map<string, ChangeProposal>();
    for (const proposal of this.proposals.get(record.id)?.values() ?? []) this.mergeProposal(proposals, proposal);
    for (const proposal of (await this.readProposalJournal(record)).values()) this.mergeProposal(proposals, proposal);
    const remoteProposalRecords = await this.readDurableProposals(root, [observation.snapshot.remoteCommit]);
    const remoteProposalIds = new Set(remoteProposalRecords.keys());
    const commits = [...new Set([
      observation.snapshot.remoteCommit,
      ...[...storedOperations.records.values()].map((item) => item.commit),
    ])];
    const durable = await this.readDurableProposals(root, commits);
    for (const proposal of durable.values()) {
      if (record.identity && snapshotKey({ repository: proposal.snapshot.repository, remoteCommit: "" }) !==
          snapshotKey({ repository: record.identity, remoteCommit: "" })) {
        throw coreError(409, "proposal_repository_mismatch", "A durable proposal belongs to a different repository identity");
      }
      this.mergeProposal(proposals, proposal);
    }
    // A checkpoint may be durable only in this local clone. Keep its proposal in
    // the independent journal until the manifest is present in the remote history.
    const recoverable = new Map([...proposals].filter(([id]) => !remoteProposalIds.has(id)));
    await this.writeProposalJournal(record, recoverable);
    this.durableProposalIds.set(record.id, remoteProposalIds);
    this.proposals.set(record.id, proposals);
    return proposals;
  }

  async listProposals(projectId: string): Promise<ProposalStatus[]> {
    return this.withProjectLock(projectId, async () => {
      const observation = await this.requireObservation(projectId);
      const { record, root } = await this.getProject(projectId);
      const operations = await this.proposalOperationRecords(root, observation);
      const proposals = await this.loadProjectProposals(record, root, observation, operations);
      return [...proposals.values()].map((proposal) => this.buildProposalStatus(
        record.id, proposal, observation, operations.records, operations.publishedOperationIds));
    });
  }

  async getProposal(projectId: string, proposalId: string): Promise<ProposalStatus | null> {
    if (typeof proposalId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(proposalId)) {
      throw coreError(400, "invalid_proposal_id", "The proposal ID is invalid");
    }
    return this.withProjectLock(projectId, async () => {
      const observation = await this.requireObservation(projectId);
      const { record, root } = await this.getProject(projectId);
      const operations = await this.proposalOperationRecords(root, observation);
      const proposals = await this.loadProjectProposals(record, root, observation, operations);
      const proposal = proposals.get(proposalId);
      if (!proposal) return null;
      return this.buildProposalStatus(record.id, proposal, observation, operations.records, operations.publishedOperationIds);
    });
  }

  async propose(projectId: string, proposal: ChangeProposal): Promise<ChangeProposal> {
    return this.withProjectLock(projectId, async () => {
      if (
        !proposal || typeof proposal.id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(proposal.id) ||
        !Array.isArray(proposal.operations) || !proposal.operations.length || proposal.operations.length > 256 ||
        !isSnapshotId(proposal.snapshot) || !["author", "module", "mcp"].includes(proposal.source)
      ) {
        throw coreError(400, "invalid_proposal", "A proposal with a valid snapshot and at least one operation is required");
      }
      const observation = await this.requireObservation(projectId);
      const { record, root } = await this.getProject(projectId);
      const proposalBase = { repository: proposal.snapshot.repository, remoteCommit: proposal.snapshot.remoteCommit };
      await this.ensureSnapshot(root, proposal.snapshot, observation.snapshot.repository, observation.snapshot.remoteCommit);
      const ids = new Set<string>();
      for (const operation of proposal.operations) {
        try {
          assertChangeOperation(operation);
          assertUserOperationPaths(operation);
        } catch { throw coreError(400, "invalid_change_operation", "A proposed change operation is invalid"); }
        if (ids.has(operation.id)) throw coreError(400, "invalid_proposal", "A proposal contains duplicate operation IDs");
        if (operation.evidenceIds !== undefined && (!Array.isArray(operation.evidenceIds) || operation.evidenceIds.some((id) => typeof id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(id)))) {
          throw coreError(400, "invalid_change_operation", "A proposed operation contains invalid evidence IDs");
        }
        ids.add(operation.id);
        if (operation.baseRemoteCommit !== proposal.snapshot.remoteCommit || snapshotKey({ repository: operation.repository, remoteCommit: operation.baseRemoteCommit }) !== snapshotKey(proposalBase)) {
          throw coreError(409, "proposal_snapshot_mismatch", "A proposed operation belongs to a different repository snapshot");
        }
      }
      const evidence = proposal.evidence ?? [];
      if (!Array.isArray(evidence)) throw coreError(400, "invalid_proposal_evidence", "Proposal evidence must be an array");
      let evidenceBytes = 0;
      try {
        if (!isJsonValue(evidence)) throw new Error("Proposal evidence is not JSON data");
        evidenceBytes = Buffer.byteLength(JSON.stringify(evidence), "utf8");
      } catch { throw coreError(400, "invalid_proposal_evidence", "Proposal evidence must be bounded JSON data"); }
      if (evidenceBytes > MAX_PROPOSAL_EVIDENCE_BYTES) throw coreError(413, "proposal_evidence_too_large", "Proposal evidence exceeds the allowed size");
      const evidenceIds = new Set<string>();
      for (const item of evidence) {
        if (
          !item || typeof item.id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(item.id) || evidenceIds.has(item.id) ||
          !isSnapshotId(item.snapshot) || snapshotKey(item.snapshot) !== snapshotKey(proposal.snapshot) ||
          !["story", "diagnostics", "nlp", "semantic", "speaker", "assistant", "publishing", "mcp"].includes(item.module) ||
          typeof item.kind !== "string" || !item.kind.trim() || item.kind.length > 128 || !Array.isArray(item.paths) || item.paths.length > 512 ||
          !Object.prototype.hasOwnProperty.call(item, "details")
        ) {
          throw coreError(400, "invalid_proposal_evidence", "Proposal evidence is invalid or belongs to a different snapshot");
        }
        for (const file of item.paths) {
          if (!file || typeof file !== "object") throw coreError(400, "invalid_proposal_evidence", "Proposal evidence contains an invalid file revision");
          try { assertProjectPath(file.path); } catch { throw coreError(400, "invalid_proposal_evidence", "Proposal evidence contains an unsafe project path"); }
          if (file.revision !== null && (typeof file.revision !== "string" || !/^[a-f0-9]{64}$/.test(file.revision))) {
            throw coreError(400, "invalid_proposal_evidence", "Proposal evidence contains an invalid file revision");
          }
          const evidenceCommit = proposal.snapshot.overlayCommit ?? proposal.snapshot.remoteCommit;
          const actual = evidenceCommit ? await this.snapshotFile(root, evidenceCommit, file.path) : null;
          if ((actual?.revision ?? null) !== file.revision) {
            throw coreError(409, "evidence_snapshot_mismatch", "Proposal evidence does not match the file revision in its declared snapshot");
          }
        }
        evidenceIds.add(item.id);
      }
      for (const operation of proposal.operations) {
        if (operation.evidenceIds?.some((id) => !evidenceIds.has(id))) throw coreError(400, "proposal_evidence_missing", "An operation references evidence that is not attached to the proposal");
      }
      const copied = normalizedProposal({
        id: proposal.id,
        snapshot: proposal.snapshot,
        operations: proposal.operations,
        source: proposal.source,
        ...(evidence.length ? { evidence } : {}),
      });
      if (Buffer.byteLength(JSON.stringify(copied), "utf8") > MAX_PROPOSAL_BYTES) {
        throw coreError(413, "proposal_too_large", "The complete proposal exceeds the recovery size limit");
      }
      const storedOperations = await this.proposalOperationRecords(root, observation);
      const proposals = await this.loadProjectProposals(record, root, observation, storedOperations);
      const existing = proposals.get(copied.id);
      if (existing) {
        if (canonicalJson(existing) !== canonicalJson(copied)) {
          throw coreError(409, "proposal_id_reused", "The proposal ID is already bound to a different payload");
        }
        return structuredClone(existing);
      }
      if (snapshotKey(proposalBase) !== snapshotKey(observation.snapshot)) throw coreError(409, "proposal_snapshot_stale", "The proposal was based on a stale repository snapshot");
      const updated = new Map(proposals);
      updated.set(copied.id, copied);
      const durableIds = this.durableProposalIds.get(record.id) ?? new Set<string>();
      await this.writeProposalJournal(record, new Map([...updated].filter(([id]) => !durableIds.has(id))));
      this.proposals.set(record.id, updated);
      return structuredClone(copied);
    });
  }

  async approve(projectId: string, approval: Approval): Promise<void> {
    return this.withProjectLock(projectId, async () => {
      if (!approval || typeof approval.proposalId !== "string" || typeof approval.authorScope !== "string" || !approval.authorScope.trim() || !Array.isArray(approval.operationIds)) {
        throw coreError(400, "invalid_approval", "An authenticated author approval is required");
      }
      const observation = await this.requireObservation(projectId);
      const { record, root } = await this.getProject(projectId);
      const storedOperations = await this.proposalOperationRecords(root, observation);
      const proposals = await this.loadProjectProposals(record, root, observation, storedOperations);
      const proposal = proposals.get(approval.proposalId);
      if (!proposal) throw coreError(404, "proposal_not_found", "The proposal is no longer available for approval");
      if (snapshotKey({ repository: proposal.snapshot.repository, remoteCommit: proposal.snapshot.remoteCommit }) !== snapshotKey(observation.snapshot)) {
        throw coreError(409, "proposal_snapshot_stale", "The repository changed after this proposal was created; review a fresh proposal before approving it");
      }
      const allowed = new Set(proposal.operations.map((operation) => operation.id));
      if (!approval.operationIds.length || new Set(approval.operationIds).size !== approval.operationIds.length || approval.operationIds.some((id) => !allowed.has(id))) {
        throw coreError(400, "invalid_approval", "Approval operation IDs must be a unique subset of the proposal");
      }
      const approvedDigests = new Map<string, string>();
      const hierarchyRevisions = new Map<string, string>();
      const hierarchyCommit = proposal.snapshot.overlayCommit ?? proposal.snapshot.remoteCommit;
      for (const operation of proposal.operations) {
        if (!approval.operationIds.includes(operation.id)) continue;
        approvedDigests.set(operation.id, operationDigest(operation));
        if (operationRequiresHierarchyRevision(operation)) {
          hierarchyRevisions.set(operation.id, await this.hierarchyTreeRevision(root, hierarchyCommit));
        }
      }
      const approvals = this.approvals.get(record.id) ?? new Map<string, {
        authorScope: string;
        operationDigests: Map<string, string>;
        hierarchyRevisions: Map<string, string>;
      }>();
      approvals.set(approval.proposalId, { authorScope: approval.authorScope, operationDigests: approvedDigests, hierarchyRevisions });
      this.approvals.set(record.id, approvals);
    });
  }

  private async checkpointUnlocked(
    projectId: string,
    operation: ChangeOperation,
    authorScope?: string,
    approvedHierarchyRevisions: string[] = [],
    acceptedProposal?: ChangeProposal,
  ): Promise<CheckpointReceipt> {
    const observation = await this.requireObservation(projectId);
    const { record, root } = await this.getProject(projectId);
    try {
      assertChangeOperation(operation);
      assertUserOperationPaths(operation);
    } catch { throw coreError(400, "invalid_change_operation", "The change operation is invalid"); }
    const identity = observation.snapshot.repository;
    if (snapshotKey({ repository: operation.repository, remoteCommit: operation.baseRemoteCommit }) !== snapshotKey({ repository: identity, remoteCommit: operation.baseRemoteCommit })) {
      throw coreError(409, "operation_repository_mismatch", "The operation belongs to a different repository");
    }
    if (operation.baseRemoteCommit && observation.snapshot.remoteCommit && !(await this.isAncestor(root, operation.baseRemoteCommit, observation.snapshot.remoteCommit))) {
      throw coreError(409, "operation_base_stale", "The operation base is no longer in the remote history");
    }
    const digest = operationDigest(operation);
    const remoteOperations = observation.snapshot.remoteCommit ? await this.readOperationRecords(root, observation.snapshot.remoteCommit) : [];
    const localOperations = await this.readLocalOperationRecords(root);
    let proposalManifest: { path: string; content: string } | undefined;
    let proposalId: string | undefined;
    if (acceptedProposal) {
      try { assertPersistedProposal(acceptedProposal); }
      catch { throw coreError(409, "proposal_metadata_invalid", "The approved proposal cannot be persisted safely"); }
      const proposal = normalizedProposal(acceptedProposal);
      if (!proposal.operations.some((item) => item.id === operation.id && operationDigest(item) === digest)) {
        throw coreError(409, "proposal_operation_mismatch", "The approved proposal does not contain this exact operation");
      }
      const serialized = JSON.stringify({ version: 1, proposalId: proposal.id, digest: proposalDigest(proposal), proposal }, null, 2) + "\n";
      if (Buffer.byteLength(serialized, "utf8") > MAX_PROPOSAL_BYTES) {
        throw coreError(413, "proposal_too_large", "The complete proposal exceeds the recovery size limit");
      }
      const proposalPath = proposalMetadataPath(proposal.id);
      const knownProposals = await this.readDurableProposals(root, [
        observation.snapshot.remoteCommit,
        ...localOperations.map((item) => item.commit),
      ]);
      const boundProposal = knownProposals.get(proposal.id);
      if (boundProposal && canonicalJson(boundProposal) !== canonicalJson(proposal)) {
        throw coreError(409, "proposal_id_reused", "The proposal ID is already bound to a different payload");
      }
      proposalManifest = { path: proposalPath, content: serialized };
      proposalId = proposal.id;
    }
    const prior = [...remoteOperations, ...localOperations].find((item) => item.operation.id === operation.id);
    if (prior) {
      if (prior.digest !== digest || prior.operation.generation !== operation.generation) throw coreError(409, "operation_id_reused", "The operation ID and generation are already bound to a different payload");
      return prior.receipt;
    }
    const pendingLocal = localOperations.some((item) => !remoteOperations.some((remoteItem) => remoteItem.operation.id === item.operation.id));
    const trackedHead = await this.checkpointHead(root);
    const canAdvanceToRemote = !!observation.snapshot.remoteCommit &&
      (!trackedHead || await this.isAncestor(root, trackedHead, observation.snapshot.remoteCommit));
    const parent = !pendingLocal && canAdvanceToRemote ? observation.snapshot.remoteCommit : trackedHead;
    if (acceptedProposal && proposalManifest) {
      const existingFile = parent ? await this.snapshotFile(root, parent, proposalManifest.path) : null;
      if (existingFile) {
        let existingMetadata: Record<string, unknown> | null;
        try { existingMetadata = asRecord(JSON.parse(existingFile.content)); }
        catch { throw coreError(409, "proposal_metadata_invalid", "The repository contains an invalid proposal manifest"); }
        if (!existingMetadata || existingMetadata.version !== 1 || existingMetadata.proposalId !== acceptedProposal.id ||
            existingMetadata.digest !== proposalDigest(acceptedProposal)) {
          throw coreError(409, "proposal_id_reused", "The proposal ID is already bound to a different repository payload");
        }
        proposalManifest = undefined;
      }
    }
    const preconditions = new Map<string, string | null>();
    for (const item of [...operation.reads, ...operation.writes]) {
      if (preconditions.has(item.path) && preconditions.get(item.path) !== item.revision) throw coreError(409, "operation_precondition_conflict", `The operation has inconsistent revisions for ${item.path}`);
      preconditions.set(item.path, item.revision);
    }
    for (const [filePath, expected] of preconditions) {
      const current = parent ? await this.snapshotFile(root, parent, filePath) : null;
      if ((current?.revision ?? null) !== expected) throw coreError(409, "operation_precondition_conflict", `The file changed since the operation snapshot: ${filePath}`);
    }
    let hierarchyRevision: string | undefined;
    if (operationRequiresHierarchyRevision(operation)) {
      hierarchyRevision = parent ? await this.hierarchyTreeRevision(root, parent) : revisionForBytes(Buffer.alloc(0));
      if (!approvedHierarchyRevisions.includes(hierarchyRevision)) {
        throw coreError(409, "hierarchy_precondition_conflict", "The project hierarchy changed after the operation was approved");
      }
    }
    const metadataPath = operationMetadataPath(operation.id);
    const proposalPath = acceptedProposal ? proposalMetadataPath(acceptedProposal.id) : undefined;
    const metadataFiles = [
      { path: metadataPath, content: "" },
      ...(proposalManifest ? [proposalManifest] : []),
    ];
    const touched = [...new Set([
      ...operation.writes.map((write) => write.path),
      ...metadataFiles.map((item) => item.path),
      ...(proposalPath ? [proposalPath] : []),
    ])];
    if (parent && (await git(root, ["status", "--porcelain", "--untracked-files=all", "--", ...touched])).trim()) {
      throw coreError(409, "working_tree_path_dirty", "A changed file has uncommitted workspace edits");
    }
    const sequence = Math.max(0, ...remoteOperations.map((item) => item.sequence), ...localOperations.map((item) => item.sequence)) + 1;
    const metadata: OperationMetadata = {
      version: 1,
      sequence,
      digest,
      operation: normalizedOperation(operation),
      ...(authorScope ? { authorScope } : {}),
      ...(hierarchyRevision ? { hierarchyRevision } : {}),
      ...(proposalId ? { proposalId } : {}),
    };
    metadataFiles[0]!.content = `${JSON.stringify(metadata, null, 2)}\n`;
    if (proposalManifest) metadataFiles[1] = proposalManifest;
    const commit = await this.createCommit(root, parent, operation.writes, metadataFiles, operation.message);
    const receipt: CheckpointReceipt = {
      operationId: operation.id,
      generation: operation.generation,
      localCommit: commit,
      remoteBase: operation.baseRemoteCommit,
      revisions: operation.writes.map((write) => ({
        path: write.path,
        revision: write.content === null ? null : revisionForBytes(write.encoding === "base64" ? Buffer.from(write.content, "base64") : Buffer.from(write.content, "utf8")),
      })),
    };
    await git(root, ["update-ref", `refs/scriptorium/checkpoints/${operation.id}`, commit]);
    const oldCheckpointHead = await this.getRef(root, "refs/scriptorium/checkpoint-head");
    await git(root, ["update-ref", "refs/scriptorium/checkpoint-head", commit, ...(oldCheckpointHead ? [oldCheckpointHead] : [])]);
    const head = await this.getRef(root, "HEAD");
    const branch = (await git(root, ["branch", "--show-current"])).trim();
    if (head === parent && branch === record.branch) {
      for (const write of operation.writes) {
        const target = await pathUnderRoot(root, write.path);
        if (write.content === null) await fs.rm(target, { force: true });
        else await atomicWrite(target, write.encoding === "base64" ? Buffer.from(write.content, "base64") : write.content);
      }
      for (const item of metadataFiles) await atomicWrite(await pathUnderRoot(root, item.path), item.content);
      await git(root, ["update-ref", `refs/heads/${record.branch}`, commit, head || "0".repeat(commit.length)]);
      await git(root, ["reset", "--quiet", commit, "--", ...touched]);
    }
    return receipt;
  }

  async checkpoint(projectId: string, operation: ChangeOperation): Promise<CheckpointReceipt> {
    return this.withProjectLock(projectId, async () => {
      try { assertChangeOperation(operation); }
      catch { throw coreError(400, "invalid_change_operation", "The change operation is invalid"); }
      const { record, root } = await this.getProject(projectId);
      const digest = operationDigest(operation);
      const observation = await this.requireObservation(projectId);
      const remoteOperations = observation.snapshot.remoteCommit ? await this.readOperationRecords(root, observation.snapshot.remoteCommit) : [];
      const localOperations = await this.readLocalOperationRecords(root);
      const prior = [...remoteOperations, ...localOperations].find((item) => item.operation.id === operation.id);
      if (prior) {
        if (prior.digest !== digest || prior.operation.generation !== operation.generation) throw coreError(409, "operation_id_reused", "The operation ID and generation are already bound to a different payload");
        return prior.receipt;
      }
      const records = new Map<string, StoredOperation>();
      for (const stored of localOperations) records.set(stored.operation.id, stored);
      for (const stored of remoteOperations) records.set(stored.operation.id, stored);
      const proposals = await this.loadProjectProposals(record, root, observation, {
        records,
        publishedOperationIds: new Set(remoteOperations.map((stored) => stored.operation.id)),
      });
      const approvals = [...(this.approvals.get(record.id)?.entries() ?? [])]
        .filter(([, item]) => item.operationDigests.get(operation.id) === digest);
      if (!approvals.length) throw coreError(403, "author_approval_required", "An authenticated author must approve this operation before checkpointing");
      const [proposalId, approval] = approvals.at(-1)!;
      const acceptedProposal = proposals.get(proposalId);
      if (!acceptedProposal) throw coreError(404, "proposal_not_found", "The approved proposal is no longer available for checkpointing");
      const hierarchyRevisions = [...new Set(approvals.flatMap(([, item]) => {
        const revision = item.hierarchyRevisions.get(operation.id);
        return revision ? [revision] : [];
      }))];
      return this.checkpointUnlocked(projectId, operation, approval.authorScope, hierarchyRevisions, acceptedProposal);
    });
  }

  async reconcile(projectId: string): Promise<ReconcileResult> {
    return this.withProjectLock(projectId, () => this.reconcileUnlocked(projectId));
  }

  async publish(projectId: string, batchId: string): Promise<import("@scriptorium/contracts").PublishReceipt> {
    return this.withProjectLock(projectId, async () => {
      if (typeof batchId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(batchId)) throw coreError(400, "invalid_batch_id", "The publication batch ID is invalid");
      const { record, root } = await this.getProject(projectId);
      const manifestPath = publicationMetadataPath(batchId);
      for (let attempt = 0; attempt < this.maxPushAttempts; attempt += 1) {
        const reconciled = await this.reconcileUnlocked(projectId);
        const remoteHead = reconciled.snapshot.remoteCommit;
        const historicalBatches = remoteHead ? await this.readPublicationRecords(root, remoteHead) : new Map<string, PublicationMetadata>();
        const historicalBatch = historicalBatches.get(batchId);
        const existing = remoteHead ? await this.snapshotFile(root, remoteHead, manifestPath) : null;
        if (existing) {
          let manifest: PublicationMetadata;
          try { manifest = JSON.parse(existing.content) as PublicationMetadata; }
          catch { throw coreError(409, "publication_metadata_invalid", "The repository contains invalid publication metadata"); }
          if (manifest.version !== 1 || manifest.batchId !== batchId || !Array.isArray(manifest.operations) || manifest.digest !== publicationDigest(batchId, manifest.operations)) {
            throw coreError(409, "batch_id_reused", "The publication batch ID is already bound to a different payload");
          }
          return { batchId, state: "confirmed", remoteCommit: remoteHead, acknowledged: manifest.operations.map((item) => item.receipt) };
        }
        const observation = await this.requireObservation(projectId);
        const pendingIds = new Set(observation.pending.map((receipt) => receipt.operationId));
        const localOperations = await this.readLocalOperationRecords(root);
        const remoteOperations = remoteHead ? await this.readOperationRecords(root, remoteHead) : [];
        const remoteById = new Map(remoteOperations.map((item) => [item.operation.id, item]));
        const conflicts = reconciled.operations.filter((item) => item.state === "conflict");
        const acknowledged = localOperations.filter((item) => remoteById.has(item.operation.id)).map((item) => item.receipt);
        if (conflicts.length) return { batchId, state: "conflict", remoteCommit: remoteHead, acknowledged };
        const toPublish = localOperations.filter((item) => pendingIds.has(item.operation.id) && !remoteById.has(item.operation.id));
        if (!toPublish.length) {
          const exactReplay = historicalBatch?.operations.map((item) => item.receipt);
          return { batchId, state: "confirmed", remoteCommit: remoteHead, acknowledged: exactReplay ?? acknowledged };
        }
        const rows = toPublish.map((item) => ({ operationId: item.operation.id, generation: item.operation.generation, digest: item.digest, receipt: item.receipt }));
        const digest = publicationDigest(batchId, rows);
        if (historicalBatch) {
          if (historicalBatch.digest !== digest) {
            throw coreError(409, "batch_id_reused", "The publication batch ID is already bound to a different payload");
          }
          return { batchId, state: "confirmed", remoteCommit: remoteHead, acknowledged: historicalBatch.operations.map((item) => item.receipt) };
        }
        const manifest: PublicationMetadata = { version: 1, batchId, digest, operations: rows };
        const parent = reconciled.snapshot.overlayCommit ?? remoteHead;
        const commit = await this.createCommit(root, parent, [], [{ path: manifestPath, content: `${JSON.stringify(manifest, null, 2)}\n` }], `Publish checkpoint batch ${batchId}`);
        const publicationRef = `refs/scriptorium/publications/${batchId}`;
        const previous = await this.getRef(root, publicationRef);
        await git(root, ["update-ref", publicationRef, commit, ...(previous ? [previous] : [])]);
        const askpassDir = path.join(this.dataDir, `.askpass-${record.id}`);
        await fs.mkdir(askpassDir, { recursive: true, mode: 0o700 });
        try {
          const askpass = await makeAskpassScript(askpassDir);
          await git(root, ["push", "origin", `${commit}:refs/heads/${record.branch}`], { token: this.token, askpass });
        } catch { /* A fresh remote observation below distinguishes rejection from a lost response. */ }
        finally { await fs.rm(askpassDir, { recursive: true, force: true }).catch(() => undefined); }

        let after: RemoteObservation;
        try { after = await this.requireObservation(projectId); }
        catch (error) {
          if (error instanceof CoreError && (error.code === "default_branch_changed" || error.code === "repository_replaced")) throw error;
          return { batchId, state: "publication_unknown", remoteCommit: remoteHead, acknowledged: [] };
        }
        const remoteManifest = after.snapshot.remoteCommit ? await this.snapshotFile(root, after.snapshot.remoteCommit, manifestPath) : null;
        if (remoteManifest) {
          let parsed: PublicationMetadata;
          try { parsed = JSON.parse(remoteManifest.content) as PublicationMetadata; }
          catch { throw coreError(409, "publication_metadata_invalid", "The repository contains invalid publication metadata"); }
          if (parsed.batchId === batchId && parsed.digest === publicationDigest(batchId, parsed.operations) && await this.isAncestor(root, commit, after.snapshot.remoteCommit)) {
            return { batchId, state: "confirmed", remoteCommit: after.snapshot.remoteCommit, acknowledged: parsed.operations.map((item) => item.receipt) };
          }
        }
        if (attempt + 1 >= this.maxPushAttempts) {
          const current = await this.getRef(root, `refs/remotes/origin/${record.branch}`);
          return { batchId, state: "conflict", remoteCommit: current || remoteHead, acknowledged: [] };
        }
      }
      return { batchId, state: "conflict", remoteCommit: "", acknowledged: [] };
    });
  }

  private async ensureSnapshot(root: string, snapshot: SnapshotId, identity: RepositoryIdentity, currentRemote: string): Promise<void> {
    if (!snapshot || snapshotKey({ ...snapshot, repository: identity }) !== snapshotKey(snapshot)) {
      throw coreError(409, "snapshot_repository_mismatch", "The requested snapshot belongs to a different repository");
    }
    if (snapshot.repository.defaultBranch !== identity.defaultBranch || snapshot.repository.repositoryId !== identity.repositoryId || snapshot.repository.ownerScope !== identity.ownerScope) {
      throw coreError(409, "snapshot_repository_mismatch", "The requested snapshot belongs to a different repository");
    }
    if (snapshot.remoteCommit) {
      try { await git(root, ["cat-file", "-e", `${snapshot.remoteCommit}^{commit}`]); }
      catch { throw coreError(409, "snapshot_unavailable", "The requested repository snapshot is unavailable"); }
      if (currentRemote && !(await this.isAncestor(root, snapshot.remoteCommit, currentRemote))) {
        throw coreError(409, "snapshot_unavailable", "The requested repository snapshot is no longer in the remote history");
      }
    }
    if (snapshot.overlayCommit) {
      try { await git(root, ["cat-file", "-e", `${snapshot.overlayCommit}^{commit}`]); }
      catch { throw coreError(409, "snapshot_unavailable", "The requested checkpoint snapshot is unavailable"); }
      const candidates = [currentRemote, await this.checkpointHead(root), await this.getRef(root, "refs/scriptorium/reconciled-head")];
      const refs = (await git(root, ["for-each-ref", "--format=%(refname)", "refs/scriptorium/checkpoints/", "refs/scriptorium/reconciliations/"])).trim().split(/\r?\n/).filter(Boolean);
      for (const ref of refs) candidates.push(await this.getRef(root, ref));
      let reachable = snapshot.overlayCommit === snapshot.remoteCommit;
      for (const candidate of candidates.filter(Boolean)) {
        if (await this.isAncestor(root, snapshot.overlayCommit, candidate)) { reachable = true; break; }
      }
      if (!reachable) throw coreError(409, "snapshot_unavailable", "The requested checkpoint snapshot is not a recognized Scriptorium checkpoint");
    }
  }

  private async observedUnlocked(projectId: string): Promise<RemoteObservation> {
    const { record, root } = await this.getProject(projectId);
    const remote = await this.fetchRemoteUnlocked(record, root);
    const remoteHead = remote.remoteCommit;
    let localHead = await this.checkpointHead(root);
    const remoteOperations = remoteHead ? await this.readOperationRecords(root, remoteHead) : [];
    const localOperations = await this.readLocalOperationRecords(root);
    const remoteById = new Map(remoteOperations.map((item) => [item.operation.id, item]));
    const pending: CheckpointReceipt[] = [];
    for (const local of localOperations) {
      const published = remoteById.get(local.operation.id);
      if (!published) pending.push(local.receipt);
      else if (published.digest !== local.digest) throw coreError(409, "operation_id_reused", "An operation ID is already bound to a different payload");
    }
    if (!pending.length && remoteHead) {
      const checkpointRef = await this.getRef(root, "refs/scriptorium/checkpoint-head");
      const trackedHead = checkpointRef || await this.getRef(root, "HEAD");
      const trackedAsCheckpoint = localOperations.some((item) => item.receipt.localCommit === trackedHead);
      if (!trackedHead || trackedAsCheckpoint || await this.isAncestor(root, trackedHead, remoteHead)) {
        await git(root, ["update-ref", "refs/scriptorium/checkpoint-head", remoteHead, ...(checkpointRef ? [checkpointRef] : [])]);
        localHead = remoteHead;
      }
    }
    return {
      snapshot: { repository: remote.identity, remoteCommit: remoteHead },
      checkpointHead: localHead,
      observedAt: new Date().toISOString(),
      state: "fresh",
      pending,
    };
  }

  private async requireObservation(projectId: string): Promise<RemoteObservation> {
    try { return await this.observedUnlocked(projectId); }
    catch (error) {
      if (error instanceof CoreError) throw error;
      throw coreError(502, "remote_observation_failed", "The repository could not be freshly observed");
    }
  }

  private async reconcileUnlocked(projectId: string): Promise<ReconcileResult> {
    const observation = await this.requireObservation(projectId);
    const { root } = await this.getProject(projectId);
    const remoteHead = observation.snapshot.remoteCommit;
    const localOperations = await this.readLocalOperationRecords(root);
    const remoteOperations = remoteHead ? await this.readOperationRecords(root, remoteHead) : [];
    const remoteById = new Map(remoteOperations.map((item) => [item.operation.id, item]));
    let replayHead = remoteHead;
    const outcomes: ReconcileResult["operations"] = [];
    for (const stored of localOperations) {
      const operation = stored.operation;
      const remote = remoteById.get(operation.id);
      const paths = operation.writes.map((write) => write.path);
      if (remote) {
        outcomes.push(remote.digest === stored.digest
          ? { operationId: operation.id, state: "unchanged", receipt: remote.receipt, paths }
          : { operationId: operation.id, state: "conflict", paths });
        continue;
      }
      if (operation.baseRemoteCommit && remoteHead && !(await this.isAncestor(root, operation.baseRemoteCommit, remoteHead))) {
        outcomes.push({ operationId: operation.id, state: "conflict", receipt: stored.receipt, paths });
        continue;
      }
      if (operationRequiresHierarchyRevision(operation)) {
        const currentHierarchyRevision = replayHead
          ? await this.hierarchyTreeRevision(root, replayHead)
          : revisionForBytes(Buffer.alloc(0));
        if (!stored.hierarchyRevision || currentHierarchyRevision !== stored.hierarchyRevision) {
          outcomes.push({ operationId: operation.id, state: "conflict", receipt: stored.receipt, paths });
          continue;
        }
      }
      const preconditions = new Map<string, string | null>();
      for (const precondition of [...operation.reads, ...operation.writes]) {
        if (preconditions.has(precondition.path) && preconditions.get(precondition.path) !== precondition.revision) {
          preconditions.set(precondition.path, "__invalid__");
        } else preconditions.set(precondition.path, precondition.revision);
      }
      const conflicts: string[] = [];
      for (const [filePath, expected] of preconditions) {
        const actual = replayHead ? await this.snapshotFile(root, replayHead, filePath) : null;
        if (expected === "__invalid__" || (actual?.revision ?? null) !== expected) conflicts.push(filePath);
      }
      const metaPath = operationMetadataPath(operation.id);
      const collision = replayHead ? await this.snapshotFile(root, replayHead, metaPath) : null;
      if (collision) {
        try {
          const existing = parseOperationMetadata(collision.content, metaPath);
          if (existing.digest !== stored.digest || existing.hierarchyRevision !== stored.hierarchyRevision || existing.proposalId !== stored.proposalId) conflicts.push(metaPath);
        } catch { conflicts.push(metaPath); }
      }
      let boundProposal: ChangeProposal | undefined;
      let boundProposalPath: string | undefined;
      if (stored.proposalId) {
        boundProposalPath = proposalMetadataPath(stored.proposalId);
        const storedProposals = await this.readProposalRecords(root, stored.commit);
        boundProposal = storedProposals.get(stored.proposalId);
        const storedManifest = await this.snapshotFile(root, stored.commit, boundProposalPath);
        if (!boundProposal || !storedManifest) conflicts.push(boundProposalPath);
        else {
          try {
            const parsed = asRecord(JSON.parse(storedManifest.content));
            if (!parsed || parsed.proposalId !== stored.proposalId || parsed.digest !== proposalDigest(boundProposal)) conflicts.push(boundProposalPath);
          } catch { conflicts.push(boundProposalPath); }
        }
      }
      if (conflicts.length) {
        outcomes.push({ operationId: operation.id, state: "conflict", receipt: stored.receipt, paths: [...new Set(conflicts)] });
        continue;
      }
      const parentLine = (await git(root, ["rev-list", "--parents", "-n1", stored.commit])).trim().split(/\s+/);
      const originalParent = parentLine[1] ?? "";
      if (replayHead === originalParent) {
        replayHead = stored.commit;
        outcomes.push({ operationId: operation.id, state: "unchanged", receipt: stored.receipt, paths });
        continue;
      }
      const metadata: OperationMetadata = {
        version: 1,
        sequence: stored.sequence,
        digest: stored.digest,
        operation,
        ...(stored.authorScope ? { authorScope: stored.authorScope } : {}),
        ...(stored.hierarchyRevision ? { hierarchyRevision: stored.hierarchyRevision } : {}),
        ...(stored.proposalId ? { proposalId: stored.proposalId } : {}),
      };
      const metadataFiles = [{ path: metaPath, content: `${JSON.stringify(metadata, null, 2)}\n` }];
      if (boundProposal && boundProposalPath) {
        const replayManifest = replayHead ? await this.snapshotFile(root, replayHead, boundProposalPath) : null;
        if (replayManifest) {
          try {
            const parsed = asRecord(JSON.parse(replayManifest.content));
            if (!parsed || parsed.proposalId !== boundProposal.id || parsed.digest !== proposalDigest(boundProposal)) {
              outcomes.push({ operationId: operation.id, state: "conflict", receipt: stored.receipt, paths: [...paths, boundProposalPath] });
              continue;
            }
          } catch {
            outcomes.push({ operationId: operation.id, state: "conflict", receipt: stored.receipt, paths: [...paths, boundProposalPath] });
            continue;
          }
        } else {
          metadataFiles.push({
            path: boundProposalPath,
            content: `${JSON.stringify({ version: 1, proposalId: boundProposal.id, digest: proposalDigest(boundProposal), proposal: boundProposal }, null, 2)}\n`,
          });
        }
      }
      const replayCommit = await this.createCommit(root, replayHead, operation.writes, metadataFiles, operation.message);
      const ref = `refs/scriptorium/reconciliations/${operation.id}`;
      const previous = await this.getRef(root, ref);
      await git(root, ["update-ref", ref, replayCommit, ...(previous ? [previous] : [])]);
      replayHead = replayCommit;
      outcomes.push({ operationId: operation.id, state: "replayed", receipt: stored.receipt, paths });
    }
    const previous = await this.getRef(root, "refs/scriptorium/reconciled-head");
    if (replayHead) await git(root, ["update-ref", "refs/scriptorium/reconciled-head", replayHead, ...(previous ? [previous] : [])]);
    else if (previous) await git(root, ["update-ref", "-d", "refs/scriptorium/reconciled-head", previous]);
    return {
      snapshot: { ...observation.snapshot, ...(replayHead && replayHead !== remoteHead ? { overlayCommit: replayHead } : {}) },
      operations: outcomes,
    };
  }

  private withProjectLock<T>(projectId: string, action: () => Promise<T>): Promise<T> {
    validateProjectId(projectId);
    return this.withLock(projectId, action);
  }

  private withRegistryLock<T>(action: () => Promise<T>): Promise<T> {
    return this.withLock("registry", action);
  }

  private async withLock<T>(projectId: string, action: () => Promise<T>): Promise<T> {
    let releaseQueue!: () => void;
    const prior = this.queueTails.get(projectId) ?? Promise.resolve();
    const gate = new Promise<void>((resolve) => { releaseQueue = resolve; });
    const tail = prior.catch(() => undefined).then(() => gate);
    this.queueTails.set(projectId, tail);
    await prior.catch(() => undefined);

    const lockDir = path.join(this.locksDir, projectId);
    const ownerPath = path.join(lockDir, "owner.json");
    const lockToken = randomUUID();
    let ownsLock = false;
    try {
      await this.initialize();
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          await fs.mkdir(lockDir, { mode: 0o700 });
          ownsLock = true;
          await fs.writeFile(ownerPath, JSON.stringify({ pid: process.pid, hostname: process.env.HOSTNAME ?? "", token: lockToken }), { mode: 0o600, flag: "wx", flush: true });
          break;
        } catch (error) {
          if (ownsLock) {
            await fs.rm(lockDir, { recursive: true, force: true }).catch(() => undefined);
            ownsLock = false;
          }
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          let owner: { pid?: unknown; hostname?: unknown } | null = null;
          try {
            const ownerStat = await fs.lstat(ownerPath);
            if (ownerStat.isSymbolicLink() || !ownerStat.isFile()) {
              throw coreError(500, "unsafe_project_lock", "The project lock owner file is unsafe");
            }
            owner = JSON.parse(await fs.readFile(ownerPath, "utf8")) as { pid?: unknown; hostname?: unknown };
          } catch (ownerError) {
            if (ownerError instanceof CoreError) throw ownerError;
            /* owner can be between mkdir and write */
          }
          const sameHost = owner?.hostname === (process.env.HOSTNAME ?? "");
          const pid = typeof owner?.pid === "number" ? owner.pid : null;
          let alive = true;
          if (sameHost && pid !== null) {
            try { process.kill(pid, 0); } catch (probeError) { alive = (probeError as NodeJS.ErrnoException).code !== "ESRCH"; }
          }
          const lockStat = await fs.lstat(lockDir).catch(() => null);
          if (lockStat?.isSymbolicLink() || (lockStat && !lockStat.isDirectory())) {
            throw coreError(500, "unsafe_project_lock", "The project lock path is unsafe");
          }
          if (sameHost && pid !== null && !alive) {
            throw coreError(423, "stale_project_lock", `An abandoned lock remains at dataDir/.locks/${projectId}; stop all Scriptorium processes and remove that directory before retrying`);
          }
          throw coreError(423, "project_busy", "Another Scriptorium process is using this project; retry shortly");
        }
      }
      if (!ownsLock) throw coreError(423, "project_busy", "Another Scriptorium process is using this project; retry shortly");
      return await action();
    } finally {
      if (ownsLock) {
        try {
          const owner = JSON.parse(await fs.readFile(ownerPath, "utf8")) as { token?: unknown };
          if (owner.token === lockToken) await fs.rm(lockDir, { recursive: true, force: true });
        } catch { /* the lock may have been reclaimed after a process failure */ }
      }
      releaseQueue();
      if (this.queueTails.get(projectId) === tail) this.queueTails.delete(projectId);
    }
  }

  async listProjects(): Promise<Project[]> {
    const records = await this.readRegistry();
    return records.map(({ id, url, branch }) => ({ id, url, branch }));
  }

  async registerProject(input: { url: string; branch?: string }): Promise<Project> {
    if (!input || typeof input.url !== "string" || !input.url.trim()) {
      throw coreError(400, "invalid_repository_url", "A repository URL is required");
    }
    const explicitBranch = input.branch === undefined ? undefined : branchName(input.branch);
    const url = this.allowLocalRemotes ? await this.normalizeRemote(input.url.trim()) : normalizeGitHubUrl(input.url.trim());
    const id = randomUUID();
    const directory = id;
    const root = path.join(this.projectsDir, directory);
    const askpassDir = path.join(this.dataDir, `.askpass-${id}`);
    await this.initialize();
    await fs.mkdir(askpassDir, { mode: 0o700 });
    let branch = explicitBranch ?? DEFAULT_BRANCH;
    let remoteWasEmpty = false;
    let identity: RepositoryIdentity;
    try {
      const askpass = await makeAskpassScript(askpassDir);
      const headInfo = await git(this.dataDir, ["ls-remote", "--symref", url, "HEAD"], { token: this.token, askpass });
      const remoteHead = headInfo.match(/^ref: refs\/heads\/(.+)\tHEAD$/m)?.[1];
      const remoteHeads = (await git(this.dataDir, ["ls-remote", "--heads", url], { token: this.token, askpass }))
        .split(/\r?\n/)
        .map((line) => line.split("\t")[1])
        .filter((ref): ref is string => typeof ref === "string" && ref.startsWith("refs/heads/"))
        .map((ref) => ref.slice("refs/heads/".length));
      remoteWasEmpty = remoteHeads.length === 0;
      const discoveredDefault = remoteHead ?? (remoteHeads.includes(DEFAULT_BRANCH) ? DEFAULT_BRANCH : remoteHeads[0] ?? DEFAULT_BRANCH);
      identity = /^https:\/\//i.test(url)
        ? await githubIdentity(url, this.token, this.fetcher)
        : localIdentity(url, branchName(discoveredDefault));
      branch = explicitBranch ?? identity.defaultBranch;
      const branchExists = remoteHeads.includes(branch);
      if (!branchExists && remoteHeads.length > 0) {
        throw coreError(404, "branch_not_found", `Branch "${branch}" was not found in the repository`);
      }
      if (branchExists) {
        await git(this.dataDir, [
          "clone", "--no-recurse-submodules", "--branch", branch, "--single-branch", "--", url, root,
        ], { token: this.token, askpass });
      } else {
        await git(this.dataDir, ["clone", "--no-recurse-submodules", "--", url, root], { token: this.token, askpass });
        await git(root, ["symbolic-ref", "HEAD", `refs/heads/${branch}`]);
      }
    } catch (error) {
      await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    } finally {
      await fs.rm(askpassDir, { recursive: true, force: true }).catch(() => undefined);
    }

    const record: ProjectRecord = { id, url, branch, directory, emptyRemote: false, identity };
    try {
      const registered = await this.withRegistryLock(async () => {
        const records = await this.readRegistry();
        const collision = records.find((item) => item.url === url && item.branch === branch);
        if (collision) return collision;
        const stored = { ...record, emptyRemote: remoteWasEmpty };
        await this.writeRegistry([...records, stored]);
        return stored;
      });
      if (registered.id !== id) {
        await fs.rm(root, { recursive: true, force: true });
        return { id: registered.id, url: registered.url, branch: registered.branch };
      }
    } catch (error) {
      await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
    return { id, url, branch };
  }

  private async normalizeRemote(input: string): Promise<string> {
    if (/^https:\/\//i.test(input)) return normalizeGitHubUrl(input);
    if (input.startsWith("file://")) {
      let local: URL;
      try { local = new URL(input); } catch { throw coreError(400, "invalid_repository_url", "The local repository URL is invalid"); }
      if (local.hostname && local.hostname !== "localhost") throw coreError(400, "invalid_repository_url", "Only local filesystem remotes are supported in development mode");
      return path.resolve(decodeURIComponent(local.pathname));
    }
    if (input.includes("://") || input.startsWith("-") || input.includes("@")) {
      throw coreError(400, "invalid_repository_url", "Only local filesystem remotes or GitHub HTTPS URLs are supported");
    }
    return path.resolve(input);
  }

  private async readYaml(root: string, relativePath: string): Promise<{ text: string; data: Record<string, unknown> }> {
    const filePath = await pathUnderRoot(root, relativePath);
    const text = await fs.readFile(filePath, "utf8");
    let data: Record<string, unknown> | null;
    try { data = asRecord(YAML.parse(text)); } catch (error) {
      const detail = error instanceof Error ? error.message : "Invalid YAML";
      throw coreError(422, "project_data_invalid", `A hierarchy YAML file is invalid: ${detail}`);
    }
    if (!data) throw coreError(422, "project_data_invalid", "A hierarchy YAML file must contain a mapping");
    return { text, data };
  }

  private async resolveScene(root: string, sceneId: string): Promise<SceneRecord> {
    if (typeof sceneId !== "string" || !sceneId) throw coreError(400, "invalid_scene_id", "A scene id is required");
    const volumesDir = await pathUnderRoot(root, "plot/volumes");
    const volumeDirs = await fs.readdir(volumesDir, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    const found: SceneRecord[] = [];
    for (const volumeEntry of volumeDirs) {
      if (volumeEntry.isSymbolicLink()) throw coreError(422, "unsafe_project_tree", "The project hierarchy contains a symbolic link");
      if (!volumeEntry.isDirectory()) continue;
      const volumeId = volumeEntry.name;
      const chaptersDir = await pathUnderRoot(root, `plot/volumes/${volumeId}/chapters`);
      const chapters = await fs.readdir(chaptersDir, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [];
        throw error;
      });
      for (const chapterEntry of chapters) {
        if (chapterEntry.isSymbolicLink()) throw coreError(422, "unsafe_project_tree", "The project hierarchy contains a symbolic link");
        if (!chapterEntry.isDirectory()) continue;
        const sceneDir = await pathUnderRoot(root, `plot/volumes/${volumeId}/chapters/${chapterEntry.name}/scenes`);
        const sceneEntries = await fs.readdir(sceneDir, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return [];
          throw error;
        });
        for (const entry of sceneEntries) {
          if (entry.isSymbolicLink()) throw coreError(422, "unsafe_project_tree", "The project hierarchy contains a symbolic link");
          if (!entry.isFile() || !entry.name.endsWith(".yaml")) continue;
          const yamlPath = path.join(sceneDir, entry.name);
          const yamlRelativePath = path.relative(root, yamlPath).split(path.sep).join("/");
          const { text, data } = await this.readYaml(root, yamlRelativePath);
          const id = typeof data.id === "string" ? data.id : path.basename(entry.name, ".yaml");
          if (id !== sceneId) continue;
          const linkedPath = typeof data.manuscript === "string"
            ? data.manuscript
            : `manuscript/${volumeId}/${chapterEntry.name}/${id}.md`;
          found.push({
            id,
            title: titleOf(data, id),
            yamlPath: path.relative(root, yamlPath).split(path.sep).join("/"),
            manuscriptPath: safeRelativePath(linkedPath),
            yamlText: text,
            yamlData: data,
          });
        }
      }
    }
    if (found.length === 0) throw coreError(404, "scene_not_found", "Scene not found");
    if (found.length > 1) throw coreError(409, "duplicate_scene_id", "The project contains duplicate scene ids");
    return found[0];
  }

  async tree(projectId: string): Promise<Tree> {
    return (await this.readTreeSnapshot(projectId, "checkpoint")).tree;
  }

  async readScene(projectId: string, sceneId: string): Promise<Scene> {
    return (await this.readSceneSnapshot(projectId, sceneId, "checkpoint")).scene;
  }

  async saveScene(
    projectId: string,
    sceneId: string,
    input: { text: string; revision: string },
  ): Promise<Scene> {
    if (!input || typeof input.text !== "string" || typeof input.revision !== "string") {
      throw coreError(400, "invalid_scene_save", "Scene text and revision are required");
    }
    return this.withProjectLock(projectId, async () => {
      const selected = await this.selectedSnapshotUnlocked(projectId, "checkpoint");
      const files = await this.snapshotFiles(selected.root, selected.commit, "plot/volumes");
      const matches: Array<{ path: string; data: Record<string, unknown>; yamlText: string }> = [];
      for (const file of files.filter((candidate) => /\/scenes\/[^/]+\.yaml$/.test(candidate))) {
        const yaml = await this.parseSnapshotYaml(selected.root, selected.commit, file);
        if (!yaml) continue;
        const id = typeof yaml.data.id === "string" ? yaml.data.id : path.posix.basename(file, ".yaml");
        if (id === sceneId) matches.push({ path: file, data: yaml.data, yamlText: yaml.text });
      }
      if (!matches.length) throw coreError(404, "scene_not_found", "Scene not found");
      if (matches.length > 1) throw coreError(409, "duplicate_scene_id", "The project contains duplicate scene ids");
      const found = matches[0]!;
      const parts = found.path.split("/");
      const manuscriptPath = typeof found.data.manuscript === "string"
        ? safeRelativePath(found.data.manuscript)
        : `manuscript/${parts[2]}/${parts[4]}/${sceneId}.md`;
      assertProjectPath(manuscriptPath);
      const currentFile = await this.snapshotFile(selected.root, selected.commit, manuscriptPath);
      const oldMarkdown = currentFile?.content ?? "";
      const currentRevision = revisionFor(found.yamlText, oldMarkdown);
      if (input.revision !== currentRevision) throw coreError(409, "revision_conflict", "The scene changed after it was loaded. Reload it before saving.");
      const document = parseMarkdownDocument(oldMarkdown);
      const nextMarkdown = `${document.prefix}${input.text}`;
      const missingLink = typeof found.data.manuscript !== "string";
      const nextYaml = missingLink ? YAML.stringify({ ...found.data, manuscript: manuscriptPath }) : found.yamlText;
      if (nextMarkdown === oldMarkdown && !missingLink) return { id: sceneId, title: titleOf(found.data, sceneId), text: input.text, revision: currentRevision };
      const metadataRevision = revisionForBytes(found.yamlText);
      const writes: FileChange[] = [{ path: manuscriptPath, revision: currentFile?.revision ?? null, content: nextMarkdown }];
      const reads: FileRevision[] = [{ path: manuscriptPath, revision: currentFile?.revision ?? null }];
      if (missingLink) {
        writes.push({ path: found.path, revision: metadataRevision, content: nextYaml });
        reads.push({ path: found.path, revision: metadataRevision });
      }
      const operation: ChangeOperation = {
        id: randomUUID(),
        generation: 0,
        repository: selected.snapshot.repository,
        baseRemoteCommit: selected.snapshot.remoteCommit,
        effect: "manuscript",
        reads,
        writes,
        message: [
          "loom(scene): " + sceneId.replace(/[\r\n\s]+/g, "-").slice(0, 128) + " (" + (input.text.length - document.body.length >= 0 ? "+" : "") + (input.text.length - document.body.length) + "字)",
          "",
          "Loom-File: " + manuscriptPath.split(path.sep).join("/"),
          "Loom-Char-Count: " + input.text.length,
        ].join("\n").slice(0, 1024),
      };
      const approvedHierarchyRevisions = operationRequiresHierarchyRevision(operation)
        ? [await this.hierarchyTreeRevision(selected.root, selected.commit)]
        : [];
      try { await this.checkpointUnlocked(projectId, operation, undefined, approvedHierarchyRevisions); }
      catch (error) {
        if (error instanceof CoreError) throw error;
        throw coreError(500, "save_checkpoint_failed", "The scene checkpoint could not be created; inspect project status before retrying.");
      }
      return { id: sceneId, title: titleOf(found.data, sceneId), text: input.text, revision: revisionFor(nextYaml, nextMarkdown) };
    });
  }

  async listManuscriptSnapshots(
    projectId: string,
    manuscriptId: string,
    sceneId?: string,
    view: "remote" | "checkpoint" = "remote",
    pinned?: SnapshotId | string,
  ): Promise<{ snapshot: SnapshotId; snapshots: ManuscriptSnapshotMeta[] }> {
    if (!manuscriptId || manuscriptId.length > 256 || manuscriptId.includes("\0")) {
      throw coreError(400, "invalid_manuscript_id", "The manuscript ID is invalid");
    }
    if (sceneId !== undefined && (!sceneId || sceneId.length > 256 || sceneId.includes("\0"))) {
      throw coreError(400, "invalid_scene_id", "The scene ID is invalid");
    }
    return this.withProjectLock(projectId, async () => {
      const selected = await this.selectedSnapshotUnlocked(projectId, view, pinned);
      if (!selected.commit) return { snapshot: selected.snapshot, snapshots: [] };
      const raw = await git(selected.root, [
        "log", "-n" + MAX_HISTORY,
        "--format=%H%x00%cI%x00%B%x1e",
        "--grep=loom(scene):", "--fixed-strings",
        selected.commit,
      ]);
      const snapshots: ManuscriptSnapshotMeta[] = [];
      for (const chunk of raw.split("\x1e")) {
        const entry = parseGitLogRecord(chunk);
        if (!entry || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(entry.hash)) continue;
        const scene = parseLoomSceneId(entry.body);
        if (!scene || (sceneId && scene !== sceneId)) continue;
        const trailers = parseLoomTrailers(entry.body);
        const entryManuscript = trailers["Loom-Manuscript"];
        if (entryManuscript && entryManuscript !== manuscriptId) continue;
        const parsedCount = Number(trailers["Loom-Char-Count"] ?? "0");
        const parsedDate = Date.parse(entry.date);
        const triggerValue = trailers["Loom-Trigger"];
        const trigger = triggerValue === "manual" || triggerValue === "submit" || triggerValue === "idle"
          ? triggerValue
          : undefined;
        snapshots.push({
          id: entry.hash,
          sceneId: scene,
          manuscriptId: entryManuscript ?? manuscriptId,
          createdAt: Number.isFinite(parsedDate) ? parsedDate : 0,
          charCount: Number.isFinite(parsedCount) && parsedCount >= 0 ? parsedCount : 0,
          source: "git",
          branch: selected.record.branch,
          ...(trailers["Loom-Label"] ? { label: trailers["Loom-Label"] } : {}),
          ...(trigger ? { trigger } : {}),
        });
      }
      return { snapshot: selected.snapshot, snapshots };
    });
  }

  async readManuscriptSnapshot(
    projectId: string,
    manuscriptId: string,
    snapshotId: string,
    view: "remote" | "checkpoint" = "remote",
    pinned?: SnapshotId | string,
  ): Promise<{ snapshot: SnapshotId; manuscript: ManuscriptSnapshot } | null> {
    if (!manuscriptId || manuscriptId.length > 256 || manuscriptId.includes("\0")) {
      throw coreError(400, "invalid_manuscript_id", "The manuscript ID is invalid");
    }
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(snapshotId)) {
      throw coreError(400, "invalid_snapshot_id", "A manuscript snapshot ID must be a full Git commit ID");
    }
    return this.withProjectLock(projectId, async () => {
      const selected = await this.selectedSnapshotUnlocked(projectId, view, pinned);
      if (!selected.commit || !(await this.isAncestor(selected.root, snapshotId, selected.commit))) return null;
      const raw = await git(selected.root, ["show", "-s", "--format=%H%x00%cI%x00%B", snapshotId]);
      const first = raw.indexOf("\0");
      const second = raw.indexOf("\0", first + 1);
      if (first < 1 || second < first + 1 || raw.slice(0, first) !== snapshotId) return null;
      const date = raw.slice(first + 1, second).trim();
      const message = raw.slice(second + 1).trimEnd();
      const sceneId = parseLoomSceneId(message);
      if (!sceneId) return null;
      const trailers = parseLoomTrailers(message);
      const recordedManuscriptId = trailers["Loom-Manuscript"];
      if (recordedManuscriptId && recordedManuscriptId !== manuscriptId) return null;
      const filePath = trailers["Loom-File"];
      if (!filePath || !filePath.toLowerCase().endsWith(".md")) return null;
      try { assertProjectPath(filePath); }
      catch { throw coreError(422, "unsafe_manuscript_path", "The historical manuscript path is unsafe"); }
      const file = await this.snapshotFile(selected.root, snapshotId, filePath);
      if (!file) return null;
      const body = stripMarkdownFrontmatter(file.content);
      const parsedCount = Number(trailers["Loom-Char-Count"] ?? body.length);
      const parsedDate = Date.parse(date);
      const triggerValue = trailers["Loom-Trigger"];
      const trigger = triggerValue === "manual" || triggerValue === "submit" || triggerValue === "idle"
        ? triggerValue
        : undefined;
      return {
        snapshot: selected.snapshot,
        manuscript: {
          id: snapshotId,
          sceneId,
          manuscriptId: recordedManuscriptId ?? manuscriptId,
          createdAt: Number.isFinite(parsedDate) ? parsedDate : 0,
          charCount: Number.isFinite(parsedCount) && parsedCount >= 0 ? parsedCount : body.length,
          source: "git",
          branch: selected.record.branch,
          ...(trailers["Loom-Label"] ? { label: trailers["Loom-Label"] } : {}),
          ...(trigger ? { trigger } : {}),
          body,
          document: { path: filePath, content: file.content, revision: file.revision },
        },
      };
    });
  }

  async history(projectId: string): Promise<Commit[]> {
    return this.withProjectLock(projectId, async () => {
      const { root } = await this.getProject(projectId);
      const observation = await this.requireObservation(projectId);
      const localHead = await this.getRef(root, "HEAD");
      const heads = !localHead ? [observation.snapshot.remoteCommit]
        : !observation.snapshot.remoteCommit || await this.isAncestor(root, observation.snapshot.remoteCommit, localHead) ? [localHead]
          : await this.isAncestor(root, localHead, observation.snapshot.remoteCommit) ? [observation.snapshot.remoteCommit]
            : [localHead, observation.snapshot.remoteCommit];
      const commitsByHash = new Map<string, Commit>();
      for (const commit of new Set(heads.filter(Boolean))) {
        const raw = await git(root, ["log", "-z", `-n${MAX_HISTORY}`, "--format=%H%x1f%cI%x1f%s", commit]);
        for (const row of raw.split("\0")) {
          const [hash, date, ...messageParts] = row.replace(/^\n/, "").split("\x1f");
          if (hash) commitsByHash.set(hash, { hash, date: date ?? "", message: messageParts.join("\x1f") });
        }
      }
      return [...commitsByHash.values()].slice(0, MAX_HISTORY);
    });
  }

  private async statusUnlocked(root: string, record: ProjectRecord): Promise<SyncStatus> {
    const branch = (await git(root, ["branch", "--show-current"])).trim();
    if (!branch || branch !== record.branch) {
      throw coreError(409, "branch_changed", "The project is no longer on its registered branch");
    }
    const remote = await this.fetchRemoteUnlocked(record, root);
    const head = await this.getRef(root, "HEAD");
    const dirtyOutput = await git(root, ["status", "--porcelain", "--untracked-files=all"]);
    let ahead = 0;
    let behind = 0;
    if (head && remote.remoteCommit) {
      const counts = (await git(root, ["rev-list", "--left-right", "--count", `${head}...${remote.remoteCommit}`])).trim().split(/\s+/);
      ahead = Number.parseInt(counts[0] ?? "0", 10) || 0;
      behind = Number.parseInt(counts[1] ?? "0", 10) || 0;
    } else if (head) ahead = Number.parseInt((await git(root, ["rev-list", "--count", head])).trim(), 10) || 0;
    else if (remote.remoteCommit) behind = Number.parseInt((await git(root, ["rev-list", "--count", remote.remoteCommit])).trim(), 10) || 0;
    return { branch, head, ahead, behind, dirty: dirtyOutput.length > 0 };
  }

  async status(projectId: string): Promise<SyncStatus> {
    return this.withProjectLock(projectId, async () => {
      const { root, record } = await this.getProject(projectId);
      return this.statusUnlocked(root, record);
    });
  }

  async sync(projectId: string): Promise<SyncStatus> {
    let status = await this.status(projectId);
    if (status.dirty) throw coreError(409, "working_tree_dirty", "Commit or preserve local workspace edits before synchronizing");
    const reconciled = await this.reconcile(projectId);
    if (reconciled.operations.some((operation) => operation.state === "conflict")) throw coreError(409, "sync_conflict", "A checkpoint conflicts with the current remote files");
    const observation = await this.observe(projectId);
    if (observation.pending.length) {
      const publication = await this.publish(projectId, randomUUID());
      if (publication.state === "publication_unknown") throw coreError(502, "publication_unknown", "The publish result is unknown; reconcile before retrying");
      if (publication.state !== "confirmed") throw coreError(409, "sync_conflict", "The remote did not accept the checkpoint batch");
    }
    await this.withProjectLock(projectId, async () => {
      const { root, record } = await this.getProject(projectId);
      status = await this.statusUnlocked(root, record);
      if (status.dirty) throw coreError(409, "working_tree_dirty", "Commit or preserve local workspace edits before synchronizing");
      const remoteHead = await this.getRef(root, `refs/remotes/origin/${record.branch}`);
      const head = await this.getRef(root, "HEAD");
      if (!remoteHead) return;
      if (!head) await git(root, ["checkout", "-B", record.branch, remoteHead]);
      else if (await this.isAncestor(root, head, remoteHead)) {
        if (head !== remoteHead) await git(root, ["merge", "--ff-only", remoteHead]);
      } else if (!(await this.isAncestor(root, remoteHead, head))) {
        const localOnly = (await git(root, ["rev-list", head, `^${remoteHead}`])).trim().split(/\r?\n/).filter(Boolean);
        const checkpointRefs = (await git(root, ["for-each-ref", "--format=%(objectname)", "refs/scriptorium/checkpoints/"])).trim().split(/\r?\n/).filter(Boolean);
        const checkpointCommits = new Set(checkpointRefs);
        if (localOnly.some((commit) => !checkpointCommits.has(commit))) throw coreError(409, "sync_conflict", "Unregistered local commits are preserved and need explicit reconciliation");
        await git(root, ["reset", "--keep", remoteHead]);
      }
      status = await this.statusUnlocked(root, record);
      if (status.dirty || status.ahead !== 0 || status.behind !== 0) throw coreError(502, "sync_incomplete", `Git synchronization did not finish cleanly (ahead=${status.ahead}, behind=${status.behind}, dirty=${status.dirty}, head=${status.head}, remote=${remoteHead})`);
    });
    return status;
  }
}
