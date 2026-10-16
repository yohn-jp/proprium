import { createHash } from "node:crypto";
import { assertChangeOperation, assertProjectPath } from "@scriptorium/contracts";
import type { ChangeOperation, FileChange } from "@scriptorium/contracts";
import { isSecretLegacyPath } from "../classification.js";
import { decodeLegacyBytes, stableMigrationId } from "../operations.js";
import type { GitPendingFile, MigrationContext, MigrationContribution, MigrationProducer } from "../types.js";

const MANAGED_META_PATHS = new Set([
  "meta/speaker-corrections.jsonl",
  "meta/speaker-model.json",
  "meta/synonyms.yaml",
  "meta/candidate-ignore-list.yaml",
  "meta/contradiction-dismissals.jsonl",
  "meta/publish-episodes.yaml",
  "meta/speaker-rule-gates.json",
]);

function isManagedPath(value: string): boolean {
  return value.startsWith(".arcadia/") || MANAGED_META_PATHS.has(value);
}

function operationForFile(
  context: MigrationContext,
  file: GitPendingFile,
  existing: { content: string; revision: string } | null,
): ChangeOperation {
  const sourceBytes = file.bytes;
  const decoded = sourceBytes ? decodeLegacyBytes(sourceBytes) : null;
  const write: FileChange = {
    path: file.path,
    revision: existing?.revision ?? null,
    content: decoded?.content ?? null,
    ...(decoded?.encoding === "base64" ? { encoding: "base64" as const } : {}),
  };
  const digest = createHash("sha256")
    .update(file.path)
    .update("\0")
    .update(sourceBytes ?? Buffer.from("deleted"))
    .digest("hex");
  const operation: ChangeOperation = {
    id: stableMigrationId(`git-pending\0${context.repository.repositoryId}\0${context.snapshot.remoteCommit}\0${digest}`),
    generation: 0,
    repository: context.repository,
    baseRemoteCommit: context.snapshot.remoteCommit,
    effect: "migration",
    reads: [{ path: file.path, revision: existing?.revision ?? null }],
    writes: [write],
    message: `Recover pending legacy repository change: ${file.path}`.slice(0, 1024),
  };
  assertChangeOperation(operation);
  return operation;
}

async function planFile(
  context: MigrationContext,
  file: GitPendingFile,
): Promise<MigrationContribution> {
  const result: MigrationContribution = { entries: [], operations: [], recovery: [] };
  try {
    assertProjectPath(file.path);
  } catch {
    result.entries.push({
      producerId: "git",
      source: file.path,
      category: "provisional",
      disposition: "blocked",
      detail: "Git reported an unsafe or unsupported path; no operation was produced.",
    });
    return result;
  }
  if (isManagedPath(file.path)) return result;
  if (file.excluded === "secret" || isSecretLegacyPath(file.path)) {
    result.entries.push({
      producerId: "git",
      source: file.path,
      category: "secret",
      disposition: "excluded",
      detail: "Credential-like file path is excluded from migration; its content was not added to an operation.",
    });
    return result;
  }
  const decoded = file.bytes ? decodeLegacyBytes(file.bytes) : null;
  if (decoded && decoded.content.length > 8 * 1024 * 1024) {
    result.entries.push({
      producerId: "git",
      source: file.path,
      category: "provisional",
      disposition: "blocked",
      detail: "File exceeds the frozen ChangeOperation payload limit; legacy checkout remains untouched.",
    });
    return result;
  }

  let existing: Awaited<ReturnType<typeof context.target.read>>;
  try {
    existing = await context.target.read(file.path);
  } catch (error) {
    result.entries.push({
      producerId: "git",
      source: file.path,
      target: file.path,
      category: "provisional",
      disposition: "blocked",
      detail: `The target snapshot rejected this path during its safe read, so this pending Git change was withheld: ${error instanceof Error ? error.message : String(error)}`,
    });
    return result;
  }
  if ((!decoded && !existing) || (decoded && existing?.content === decoded.content)) {
    result.entries.push({
      producerId: "git",
      source: file.path,
      target: file.path,
      category: "provisional",
      disposition: "unchanged",
      detail: "Target already represents the final pending source state.",
    });
    return result;
  }
  const operation = operationForFile(context, file, existing);
  result.entries.push({
    producerId: "git",
    source: file.path,
    target: file.path,
    category: "provisional",
    disposition: "planned",
    detail: "Reviewable migration operation contains the final content of pending local commits and worktree edits; target replacement/deletion is guarded by its observed file revision.",
  });
  result.operations.push(operation);
  return result;
}

export function createPendingGitProducer(): MigrationProducer {
  return {
    id: "git",
    async inspect(context: MigrationContext): Promise<MigrationContribution> {
      const result: MigrationContribution = { entries: [], operations: [], recovery: [] };
      const state = await context.source.inspectGit();
      if (!state.repository) return result;
      if (state.blockers.length > 0) {
        result.entries.push({
          producerId: "git",
          source: ".git",
          category: "provisional",
          disposition: "blocked",
          detail: state.blockers.join(" "),
        });
      }
      if (state.pendingCommitCount > 0 || state.workingTreePaths.length > 0) {
        let files: GitPendingFile[];
        try {
          files = await context.source.readGitPendingFiles(state);
        } catch (error) {
          result.entries.push({
            producerId: "git",
            source: ".git",
            category: "provisional",
            disposition: "blocked",
            detail: `Pending local Git operations could not be read safely: ${error instanceof Error ? error.message : String(error)}.`,
          });
          return result;
        }
        for (const file of files) {
          const planned = await planFile(context, file);
          result.entries.push(...planned.entries);
          result.operations.push(...planned.operations);
          result.recovery.push(...planned.recovery);
        }
      }
      if (state.pendingCommitCount > 0) {
        result.entries.push({
          producerId: "git",
          source: ".git/HEAD",
          category: "provisional",
          disposition: "planned",
          recordCount: state.pendingCommitCount,
          detail: `Detected ${state.pendingCommitCount} local commit(s) ahead of ${state.upstream ?? "an unreadable upstream"}; their final file effects are represented by reviewable operations, and the source history remains untouched.`,
        });
      }
      return result;
    },
  };
}
