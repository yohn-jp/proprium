import { createHash } from "node:crypto";
import { assertChangeOperation, assertProjectPath } from "@scriptorium/contracts";
import type { ChangeOperation, FileChange, ModuleId } from "@scriptorium/contracts";
import type { MigrationContext, MigrationEntry, PersistenceCategory } from "./types.js";

export interface PlannedFileImport {
  entry: MigrationEntry;
  operation?: ChangeOperation;
}

export function decodeLegacyBytes(bytes: Buffer): { content: string; encoding: "utf8" | "base64" } {
  if (bytes.includes(0)) return { content: bytes.toString("base64"), encoding: "base64" };
  try {
    const content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    return { content, encoding: "utf8" };
  } catch {
    return { content: bytes.toString("base64"), encoding: "base64" };
  }
}

export function stableMigrationId(seed: string): string {
  return `migration_${createHash("sha256").update(seed).digest("hex").slice(0, 48)}`;
}

export async function planExactFileImport(input: {
  context: MigrationContext;
  producerId: string;
  moduleId?: ModuleId;
  source: string;
  target: string;
  category: PersistenceCategory;
  bytes: Buffer;
  detail: string;
  message: string;
}): Promise<PlannedFileImport> {
  const { context } = input;
  assertProjectPath(input.target);
  if (input.moduleId && !context.enabledModules.has(input.moduleId)) {
    return {
      entry: {
        producerId: input.producerId,
        source: input.source,
        target: input.target,
        category: input.category,
        disposition: "deferred",
        detail: `Module ${input.moduleId} is disabled; source data remains untouched.`,
      },
    };
  }

  const { content, encoding } = decodeLegacyBytes(input.bytes);
  if (content.length > 8 * 1024 * 1024) {
    return {
      entry: {
        producerId: input.producerId,
        source: input.source,
        target: input.target,
        category: input.category,
        disposition: "blocked",
        detail: "File exceeds the frozen ChangeOperation payload limit; source was left untouched.",
      },
    };
  }

  const existing = await context.target.read(input.target);
  if (existing?.content === content) {
    return {
      entry: {
        producerId: input.producerId,
        source: input.source,
        target: input.target,
        category: input.category,
        disposition: "unchanged",
        detail: "Target already contains the same bytes.",
      },
    };
  }
  if (existing) {
    return {
      entry: {
        producerId: input.producerId,
        source: input.source,
        target: input.target,
        category: input.category,
        disposition: "conflict",
        detail: "Target already has different content; no source or target data was overwritten.",
      },
    };
  }

  return planGeneratedFileImport({
    context,
    producerId: input.producerId,
    source: input.source,
    target: input.target,
    category: input.category,
    content,
    encoding,
    detail: input.detail,
    message: input.message,
    existing,
  });
}

export async function planGeneratedFileImport(input: {
  context: MigrationContext;
  producerId: string;
  source: string;
  target: string;
  category: PersistenceCategory;
  content: string;
  encoding?: "utf8" | "base64";
  detail: string;
  message: string;
  existing?: { content: string; revision: string } | null;
}): Promise<PlannedFileImport> {
  const existing = input.existing === undefined ? await input.context.target.read(input.target) : input.existing;
  if (existing?.content === input.content) {
    return {
      entry: {
        producerId: input.producerId,
        source: input.source,
        target: input.target,
        category: input.category,
        disposition: "unchanged",
        detail: "Target already contains the planned bytes.",
      },
    };
  }
  const revision = existing?.revision ?? null;
  const write: FileChange = {
    path: input.target,
    revision,
    content: input.content,
    ...(input.encoding === "base64" ? { encoding: input.encoding } : {}),
  };
  const operation: ChangeOperation = {
    id: stableMigrationId(`${input.producerId}\0${input.context.repository.repositoryId}\0${input.target}\0${createHash("sha256").update(input.content).digest("hex")}`),
    generation: 0,
    repository: input.context.repository,
    baseRemoteCommit: input.context.snapshot.remoteCommit,
    effect: "migration",
    reads: [{ path: input.target, revision }],
    writes: [write],
    message: input.message,
  };
  assertChangeOperation(operation);
  return {
    entry: {
      producerId: input.producerId,
      source: input.source,
      target: input.target,
      category: input.category,
      disposition: "planned",
      detail: input.detail,
    },
    operation,
  };
}

export function recoveryRecord(input: {
  producerId: string;
  source: string;
  content: string;
  encoding: "utf8" | "base64";
  stableId: string;
  detail: string;
}) {
  return {
    id: stableMigrationId(`${input.producerId}\0${input.stableId}`),
    source: input.source,
    category: "provisional" as const,
    content: input.content,
    encoding: input.encoding,
    detail: input.detail,
  };
}
