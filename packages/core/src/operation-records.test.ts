import assert from "node:assert/strict";
import { test } from "node:test";
import type { ChangeOperation, ChangeProposal, RepositoryIdentity, SnapshotId } from "@scriptorium/contracts";
import {
  assertPersistedProposal,
  normalizedOperation,
  normalizedProposal,
  operationDigest,
  proposalDigest,
} from "./operation-records.js";

const commit = "a".repeat(40);
const repository = {
  url: "https://github.com/owner/repo",
  ownerScope: "owner",
  defaultBranch: "main",
  repositoryId: "repo-123",
  provider: "github",
} as RepositoryIdentity;
const snapshot = { remoteCommit: commit, repository } as SnapshotId;

function goldenOperation(): ChangeOperation {
  return {
    evidenceIds: ["evidence-one"],
    message: "Golden operation",
    writes: [{
      encoding: "utf8",
      content: "A line.\n",
      revision: null,
      path: "manuscript/chapter.md",
    }],
    reads: [{ revision: null, path: "manuscript/chapter.md" }],
    readScopes: [{ revision: "b".repeat(64), prefix: "bible/characters" }],
    effect: "manuscript",
    baseRemoteCommit: commit,
    repository: { ...repository },
    generation: 7,
    id: "operation-golden",
  } as ChangeOperation;
}

function goldenProposal(): ChangeProposal {
  return {
    source: "module",
    operations: [goldenOperation()],
    snapshot,
    id: "proposal-golden",
    evidence: [{
      details: { z: ["last", { y: 2, x: 1 }], a: true },
      paths: [{ revision: null, path: "manuscript/source.md" }],
      kind: "source_note",
      module: "story",
      snapshot,
      id: "evidence-one",
    }],
  } as ChangeProposal;
}

test("operation record normalization preserves the serialized bytes and SHA-256 digest", () => {
  const operation = goldenOperation();
  const serialized = JSON.stringify(normalizedOperation(operation));
  assert.equal(serialized,
    `{"id":"operation-golden","generation":7,"repository":{"provider":"github","repositoryId":"repo-123","defaultBranch":"main","ownerScope":"owner","url":"https://github.com/owner/repo"},"baseRemoteCommit":"${commit}","effect":"manuscript","reads":[{"path":"manuscript/chapter.md","revision":null}],"readScopes":[{"prefix":"bible/characters","revision":"${"b".repeat(64)}"}],"writes":[{"path":"manuscript/chapter.md","revision":null,"content":"A line.\\n","encoding":"utf8"}],"message":"Golden operation","evidenceIds":["evidence-one"]}`);
  assert.equal(operationDigest(operation), "9e685079c727b55d2265fdf990088998e50efe808cb4b53236ec47ce1bcdc490");
});

test("proposal records preserve normalized JSON and the canonical proposal digest", () => {
  const proposal = goldenProposal();
  const normalized = normalizedProposal(proposal);
  assert.equal(JSON.stringify(normalized),
    `{"id":"proposal-golden","snapshot":{"remoteCommit":"${commit}","repository":{"url":"https://github.com/owner/repo","ownerScope":"owner","defaultBranch":"main","repositoryId":"repo-123","provider":"github"}},"operations":[{"id":"operation-golden","generation":7,"repository":{"provider":"github","repositoryId":"repo-123","defaultBranch":"main","ownerScope":"owner","url":"https://github.com/owner/repo"},"baseRemoteCommit":"${commit}","effect":"manuscript","reads":[{"path":"manuscript/chapter.md","revision":null}],"readScopes":[{"prefix":"bible/characters","revision":"${"b".repeat(64)}"}],"writes":[{"path":"manuscript/chapter.md","revision":null,"content":"A line.\\n","encoding":"utf8"}],"message":"Golden operation","evidenceIds":["evidence-one"]}],"source":"module","evidence":[{"details":{"z":["last",{"y":2,"x":1}],"a":true},"paths":[{"revision":null,"path":"manuscript/source.md"}],"kind":"source_note","module":"story","snapshot":{"remoteCommit":"${commit}","repository":{"url":"https://github.com/owner/repo","ownerScope":"owner","defaultBranch":"main","repositoryId":"repo-123","provider":"github"}},"id":"evidence-one"}]}`);
  assert.equal(proposalDigest(proposal), "220f73e5dab70cf3643423f61fa472a221dccef23d4d26dd50e6d5f72fc5bee2");

  const reorderedDetails = goldenProposal();
  reorderedDetails.evidence![0]!.details = { a: true, z: ["last", { x: 1, y: 2 }] };
  assert.equal(proposalDigest(reorderedDetails), "220f73e5dab70cf3643423f61fa472a221dccef23d4d26dd50e6d5f72fc5bee2");
});

test("persisted proposal validation enforces record binding and safe content", () => {
  const proposal = goldenProposal();
  assert.doesNotThrow(() => assertPersistedProposal(proposal));

  const duplicateOperation = goldenOperation();
  duplicateOperation.writes[0] = { ...duplicateOperation.writes[0]!, path: "manuscript/other.md" };
  assert.throws(() => assertPersistedProposal({ ...proposal, operations: [goldenOperation(), duplicateOperation] }), /binding mismatch/);

  const missingEvidence = { ...proposal, evidence: [] };
  assert.throws(() => assertPersistedProposal(missingEvidence), /Missing proposal evidence reference/);

  const reservedPath = goldenOperation();
  reservedPath.writes[0] = { ...reservedPath.writes[0]!, path: "meta/scriptorium/operations/v1/forged.json" };
  assert.throws(() => assertPersistedProposal({ ...proposal, operations: [reservedPath] }), /Core authority metadata/);
});
