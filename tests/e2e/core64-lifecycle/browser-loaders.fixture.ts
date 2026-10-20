import type { BrowserModuleContext, BrowserModuleDefinition, ChangeOperation } from "@scriptorium/contracts";

declare global {
  interface Window {
    __core64HostLifecycle: {
      currentAuthor: string;
      deferFirstMount: boolean;
      lateProposalAfterDeferredMount: boolean;
      deferFirstJournalWrite: boolean;
      proposalOnFirstMount: boolean;
      resolveFirstMount: (() => void) | null;
      metrics: {
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
      };
    };
  }
}

function lateOperation(context: BrowserModuleContext): ChangeOperation {
  return {
    id: "late-contribution-operation",
    generation: 1,
    repository: context.snapshot.repository,
    baseRemoteCommit: context.snapshot.remoteCommit,
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

const definition: BrowserModuleDefinition = {
  async mount(_contributionId, element, context) {
    const harness = window.__core64HostLifecycle;
    const metrics = harness.metrics;
    const mountNumber = ++metrics.mountCalls;
    metrics.mountAuthors.push(harness.currentAuthor);

    let resourcesReleased = false;
    const timer = window.setInterval(() => { metrics.timerTicks += 1; }, 1000);
    metrics.activeTimers += 1;

    metrics.activeRequests += 1;
    void fetch("/api/lifecycle-held", { signal: context.signal })
      .catch(() => undefined)
      .finally(() => { metrics.activeRequests -= 1; });

    const workerUrl = URL.createObjectURL(new Blob(["postMessage('ready'); onmessage = () => {};"], { type: "text/javascript" }));
    const worker = new Worker(workerUrl);
    worker.addEventListener("message", (event) => {
      if (event.data === "ready") metrics.workersReady += 1;
    }, { once: true });
    metrics.activeWorkers += 1;

    const releaseResources = () => {
      if (resourcesReleased) return;
      resourcesReleased = true;
      window.clearInterval(timer);
      metrics.activeTimers -= 1;
      worker.terminate();
      URL.revokeObjectURL(workerUrl);
      metrics.activeWorkers -= 1;
    };

    context.signal.addEventListener("abort", () => {
      metrics.signalAborts += 1;
      releaseResources();
    }, { once: true });

    if (harness.deferFirstMount && mountNumber === 1) {
      await new Promise<void>((resolve) => {
        harness.resolveFirstMount = () => {
          harness.resolveFirstMount = null;
          resolve();
        };
      });
    }

    if (harness.lateProposalAfterDeferredMount && mountNumber === 1) {
      metrics.lateCallbackAttempts += 1;
      try {
        await context.propose([lateOperation(context)]);
        metrics.lateCallbackOutcomes.push("resolved");
      } catch {
        metrics.lateCallbackOutcomes.push("rejected");
      }
    }

    if (harness.proposalOnFirstMount && mountNumber === 1) {
      metrics.lateCallbackAttempts += 1;
      try {
        await context.propose([lateOperation(context)]);
        metrics.lateCallbackOutcomes.push("resolved");
      } catch {
        metrics.lateCallbackOutcomes.push("rejected");
      }
    }

    element.textContent = "Synthetic trusted contribution mounted";
    return () => {
      metrics.disposeCalls += 1;
      releaseResources();
    };
  },
};

export const moduleBrowserLoaders = {
  publishing: async () => {
    window.__core64HostLifecycle.metrics.loaderCalls += 1;
    return definition;
  },
};
