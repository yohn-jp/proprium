import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { ChangeOperation, ChangeProposal, ModuleStatus, ProposalStatus, RepositoryIdentity, SnapshotId, UiContribution } from "@scriptorium/contracts";
import { ContributionHost } from "../../../app/src/contributions/ContributionHost";
import { BrowserJournal, repositoryKey, type JournalProposalOwnership } from "../../../app/src/storage/journal";

interface HostLifecycleMetrics {
  loaderCalls: number;
  mountCalls: number;
  mountAuthors: string[];
  signalAborts: number;
  disposeCalls: number;
  activeTimers: number;
  timerTicks: number;
  activeRequests: number;
  activeWorkers: number;
  workersReady: number;
  lateCallbackAttempts: number;
  lateCallbackOutcomes: string[];
  journalWrites: Array<{ authorScope: string; proposalId: string }>;
  journalRemovals: Array<{ authorScope: string; proposalId: string }>;
  journalRecords: Array<{ authorScope: string; proposalId: string }>;
  legacyProposalIds: string[];
  reviewStatusProposalIds: string[];
  dismissedProposalIds: string[];
  pendingJournalWrites: number;
  proposalApiRequests: number;
  proposalReinsertions: number;
  proposalStoredEvents: number;
}

interface HostLifecycleHarness {
  currentAuthor: string;
  deferFirstMount: boolean;
  lateProposalAfterDeferredMount: boolean;
  deferFirstJournalWrite: boolean;
  proposalOnFirstMount: boolean;
  deferProposalApi: boolean;
  resolveFirstMount: (() => void) | null;
  resolveFirstJournalWrite: (() => void) | null;
  resolveProposalApi: (() => void) | null;
  metrics: HostLifecycleMetrics;
}

declare global {
  interface Window {
    __core64HostLifecycle: HostLifecycleHarness;
  }
}

const query = new URLSearchParams(window.location.search);
const harness: HostLifecycleHarness = {
  currentAuthor: "author-old",
  deferFirstMount: query.has("defer-first-mount"),
  lateProposalAfterDeferredMount: query.has("late-proposal"),
  deferFirstJournalWrite: query.has("defer-first-journal"),
  proposalOnFirstMount: query.has("proposal-on-first-mount"),
  deferProposalApi: query.has("defer-proposal-api"),
  resolveFirstMount: null,
  resolveFirstJournalWrite: null,
  resolveProposalApi: null,
  metrics: {
    loaderCalls: 0,
    mountCalls: 0,
    mountAuthors: [],
    signalAborts: 0,
    disposeCalls: 0,
    activeTimers: 0,
    timerTicks: 0,
    activeRequests: 0,
    activeWorkers: 0,
    workersReady: 0,
    lateCallbackAttempts: 0,
    lateCallbackOutcomes: [],
    journalWrites: [],
    journalRemovals: [],
    journalRecords: [],
    legacyProposalIds: [],
    reviewStatusProposalIds: [],
    dismissedProposalIds: [],
    pendingJournalWrites: 0,
    proposalApiRequests: 0,
    proposalReinsertions: 0,
    proposalStoredEvents: 0,
  },
};
window.__core64HostLifecycle = harness;

const repository: RepositoryIdentity = {
  provider: "github",
  repositoryId: "core64-lifecycle-fixture",
  defaultBranch: "main",
  ownerScope: "fixture-owner",
  url: "https://github.com/fixture/core64-lifecycle",
};

const contribution: UiContribution = {
  id: "publishing.lifecycle-fixture",
  module: "publishing",
  slot: "dock",
  title: "Lifecycle fixture",
  action: "publishing.lifecycle-fixture",
};

function snapshot(scene: number): SnapshotId {
  return {
    repository,
    remoteCommit: scene === 0 ? "a".repeat(40) : scene.toString(16).padStart(40, "0"),
  };
}

function proposalOperation(currentSnapshot: SnapshotId): ChangeOperation {
  return {
    id: "late-contribution-operation",
    generation: 1,
    repository,
    baseRemoteCommit: currentSnapshot.remoteCommit,
    effect: "metadata",
    reads: [],
    writes: [{
      path: "meta/scriptorium/modules/publishing/lifecycle-late-callback.md",
      revision: null,
      content: "This callback belongs to a disposed author scope.\n",
    }],
    message: "late lifecycle fixture proposal",
  };
}

function proposalFor(id: string): ChangeProposal {
  const currentSnapshot = snapshot(0);
  return { id, snapshot: currentSnapshot, operations: [proposalOperation(currentSnapshot)], source: "module" };
}

let browserJournal: BrowserJournal;
let lastProposal: ChangeProposal | null = null;
let firstJournalWrite = true;

async function syncJournalRecords(): Promise<void> {
  const records = (await browserJournal.getAllProposals())
    .filter((record) => record.repositoryKey === repositoryKey(repository))
    .map((record) => ({ authorScope: record.authorScope ?? "", proposalId: record.proposal.id }));
  harness.metrics.journalRecords = records;
  const all = await browserJournal.getAllProposals();
  const scoped = all.filter((record) => record.repositoryKey === repositoryKey(repository));
  harness.metrics.legacyProposalIds = scoped
    .filter((record) => record.ownershipToken === undefined)
    .map((record) => record.proposal.id);
  harness.metrics.reviewStatusProposalIds = scoped
    .filter((record) => record.status !== undefined)
    .map((record) => record.proposal.id);
  harness.metrics.dismissedProposalIds = scoped
    .filter((record) => record.dismissedAt !== undefined)
    .map((record) => record.proposal.id);
}

const journal = {
  async putProposal(
    owner: RepositoryIdentity,
    authorScope: string,
    proposal: ChangeProposal,
  ): Promise<JournalProposalOwnership | null> {
    lastProposal = proposal;
    if (harness.deferFirstJournalWrite && firstJournalWrite) {
      firstJournalWrite = false;
      harness.metrics.pendingJournalWrites += 1;
      await new Promise<void>((resolve) => {
        harness.resolveFirstJournalWrite = () => {
          harness.resolveFirstJournalWrite = null;
          resolve();
        };
      });
      harness.metrics.pendingJournalWrites -= 1;
    }
    const ownership = await browserJournal.putProposal(owner, authorScope, proposal);
    if (ownership) harness.metrics.journalWrites.push({ authorScope, proposalId: proposal.id });
    await syncJournalRecords();
    return ownership;
  },
  async removeProposal(
    owner: RepositoryIdentity,
    authorScope: string,
    proposalId: string,
    ownership?: JournalProposalOwnership,
  ): Promise<boolean> {
    const removed = await browserJournal.removeProposal(owner, authorScope, proposalId, ownership);
    if (removed) harness.metrics.journalRemovals.push({ authorScope, proposalId });
    await syncJournalRecords();
    return removed;
  },
};

async function seedLegacyProposal(): Promise<void> {
  const request = indexedDB.open("scriptorium-recovery", 3);
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction("proposals", "readwrite", { durability: "strict" });
      const store = transaction.objectStore("proposals");
      const key = JSON.stringify([repositoryKey(repository), "author-old", "preexisting-proposal-id"]);
      const read = store.get(key);
      read.onsuccess = () => {
        const legacyRecord = read.result as { ownershipToken?: string } | undefined;
        if (!legacyRecord) {
          transaction.abort();
          reject(new Error("The preexisting proposal was not seeded."));
          return;
        }
        delete legacyRecord.ownershipToken;
        store.put(legacyRecord);
      };
      read.onerror = () => reject(read.error);
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error ?? new Error("Legacy record transaction aborted."));
      transaction.onerror = () => reject(transaction.error ?? new Error("Legacy record transaction failed."));
    });
  } finally {
    database.close();
  }
}

async function reviewCurrentProposal(): Promise<void> {
  if (!lastProposal) return;
  const status: ProposalStatus = {
    proposal: lastProposal,
    state: "proposed",
    approvedOperationIds: [],
    checkpoints: [],
    publishedOperationIds: [],
    stale: false,
  };
  await browserJournal.putProposal(repository, "author-old", lastProposal, status);
  harness.metrics.reviewStatusProposalIds.push(lastProposal.id);
  await syncJournalRecords();
}

async function dismissCurrentProposal(): Promise<void> {
  if (!lastProposal) return;
  await browserJournal.dismissProposal(repository, "author-old", lastProposal.id);
  harness.metrics.dismissedProposalIds.push(lastProposal.id);
  await syncJournalRecords();
}

async function replaceCurrentProposalVersion(): Promise<void> {
  if (!lastProposal) return;
  await browserJournal.removeProposal(repository, "author-old", lastProposal.id);
  const ownership = await browserJournal.putProposal(repository, "author-old", lastProposal);
  if (ownership) harness.metrics.proposalReinsertions += 1;
  await syncJournalRecords();
}

const refresh = async () => {};
const readCurrentEditor = () => null;
const onProposalStored = () => { harness.metrics.proposalStoredEvents += 1; };

function HostFixture() {
  const [visible, setVisible] = useState(true);
  const [authorScope, setAuthorScope] = useState("author-old");
  const [scene, setScene] = useState(0);
  const [moduleAvailability, setModuleAvailability] = useState<ModuleStatus["availability"]>(
    query.has("start-disabled") ? "disabled" : "enabled-idle",
  );
  harness.currentAuthor = authorScope;

  const modules: ModuleStatus[] = [{ id: "publishing", availability: moduleAvailability, activeJobs: 0 }];

  return (
    <main>
      <button type="button" onClick={() => setVisible(false)}>Unmount host</button>
      <button type="button" onClick={() => setScene((value) => value + 1)}>Change scene snapshot</button>
      <button type="button" onClick={() => setAuthorScope("author-new")}>Change author</button>
      <button type="button" onClick={() => harness.resolveFirstMount?.()}>Resolve deferred mount</button>
      <button type="button" onClick={() => harness.resolveFirstJournalWrite?.()}>Resolve deferred journal write</button>
      <button type="button" onClick={() => harness.resolveProposalApi?.()}>Resolve deferred proposal API</button>
      <button type="button" onClick={() => void reviewCurrentProposal()}>Mark proposal reviewed</button>
      <button type="button" onClick={() => void dismissCurrentProposal()}>Dismiss proposal</button>
      <button type="button" onClick={() => void replaceCurrentProposalVersion()}>Replace proposal with same ID</button>
      <button type="button" onClick={() => setModuleAvailability("enabled-idle")}>Enable fixture module</button>
      <button type="button" onClick={() => setModuleAvailability("disabled")}>Disable fixture module</button>
      <output aria-label="Current author">{authorScope}</output>
      <output aria-label="Scene revision">{scene}</output>
      {visible && (
        <ContributionHost
          projectId="project-1"
          authorScope={authorScope}
          slot="dock"
          contributions={[contribution]}
          modules={modules}
          snapshot={snapshot(scene)}
          refresh={refresh}
          journal={journal as never}
          onProposalStored={onProposalStored}
          readCurrentEditor={readCurrentEditor}
        />
      )}
    </main>
  );
}

async function startFixture(): Promise<void> {
  browserJournal = await BrowserJournal.open();
  if (query.has("preexisting-proposal")) {
    Object.defineProperty(window.crypto, "randomUUID", {
      configurable: true,
      value: () => "preexisting-proposal-id",
    });
    await browserJournal.putProposal(repository, "author-old", proposalFor("preexisting-proposal-id"));
    await seedLegacyProposal();
    await syncJournalRecords();
  }
  createRoot(document.getElementById("root")!).render(<HostFixture />);
}

void startFixture();
