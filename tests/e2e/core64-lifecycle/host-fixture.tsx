import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { ModuleStatus, SnapshotId, UiContribution } from "@scriptorium/contracts";
import { ContributionHost } from "../../../app/src/contributions/ContributionHost";

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
  proposalStoredEvents: number;
}

interface HostLifecycleHarness {
  currentAuthor: string;
  deferFirstMount: boolean;
  lateProposalAfterDeferredMount: boolean;
  resolveFirstMount: (() => void) | null;
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
  resolveFirstMount: null,
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
    proposalStoredEvents: 0,
  },
};
window.__core64HostLifecycle = harness;

const repository = {
  provider: "github" as const,
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

const journal = {
  async putProposal(_repository: unknown, authorScope: string, proposal: { id: string }) {
    harness.metrics.journalWrites.push({ authorScope, proposalId: proposal.id });
  },
  async removeProposal() {},
};

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

createRoot(document.getElementById("root")!).render(<HostFixture />);
