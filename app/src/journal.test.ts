import assert from "node:assert/strict";
import test from "node:test";
import type { ChangeOperation, RepositoryIdentity } from "@scriptorium/contracts";
import { documentKey, journalEntryKey, publicationReceiptKey, repositoryKey } from "./storage/journal";

const repository: RepositoryIdentity = {
  provider: "github",
  repositoryId: "12345",
  ownerScope: "owner",
  defaultBranch: "main",
  url: "https://github.com/owner/story",
};

function operation(id: string, generation: number): ChangeOperation {
  return {
    id,
    generation,
    repository,
    baseRemoteCommit: "0123456789abcdef",
    effect: "manuscript",
    reads: [],
    writes: [],
    message: "test",
  };
}

test("journal keys isolate author scopes and retain each operation generation", () => {
  const pathKey = documentKey(repository, "manuscript/scene.md");
  const generationOne = journalEntryKey({ documentKey: pathKey, authorScope: "owner", operation: operation("operation-a", 1) });
  const generationTwo = journalEntryKey({ documentKey: pathKey, authorScope: "owner", operation: operation("operation-a", 2) });
  const otherAuthor = journalEntryKey({ documentKey: pathKey, authorScope: "guest", operation: operation("operation-a", 1) });

  assert.notEqual(generationOne, generationTwo);
  assert.notEqual(generationOne, otherAuthor);
});

test("publication receipt keys are stable within a scope and distinct across batches/scopes", () => {
  const ownerBatch = publicationReceiptKey(repository, "owner", "batch-a");
  assert.equal(ownerBatch, publicationReceiptKey(repository, "owner", "batch-a"));
  assert.notEqual(ownerBatch, publicationReceiptKey(repository, "owner", "batch-b"));
  assert.notEqual(ownerBatch, publicationReceiptKey(repository, "guest", "batch-a"));
  assert.equal(repositoryKey(repository), repositoryKey({ ...repository }));
});
