import { useEffect, useRef, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, useLocation, useNavigate } from "react-router-dom";
import type { ChangeOperation, RepositoryIdentity } from "@scriptorium/contracts";
import { MobileShell } from "../../../app/src/shells/mobile/MobileShell";
import type { WorkspacePanel } from "../../../app/src/application/contracts";
import { BrowserJournal, documentKey, journalEntryKey, repositoryKey, type JournalEntry } from "../../../app/src/storage/journal";

type GuardOutcome = boolean | "delayed";

interface FixtureMetrics {
  journalReady: boolean;
  armed: boolean;
  guardCalls: number;
  journalCalls: number;
  journalWrites: number;
  outcomes: GuardOutcome[];
  release?: () => void;
  scope: string;
  arm(outcomes: GuardOutcome[]): void;
  releaseGuard(): void;
  changeScope(scope: string): void;
  changeRoute(view: string): void;
}

declare global {
  interface Window {
    __mobileTransitionFixture?: FixtureMetrics;
  }
}

const repository: RepositoryIdentity = {
  provider: "github",
  repositoryId: "mobile-transition-fixture",
  ownerScope: "fixture-owner",
  defaultBranch: "main",
  url: "https://github.com/fixture-owner/mobile-transition-fixture",
};
const remoteCommit = "0123456789abcdef0123456789abcdef01234567";
const documentPath = "manuscript/vol-1/ch-1/scene-1.md";

function makeEntry(generation: number): JournalEntry {
  const text = `Fixture draft generation ${generation}`;
  const operation: ChangeOperation = {
    id: "mobile-transition-fixture-operation",
    generation,
    repository,
    baseRemoteCommit: remoteCommit,
    effect: "manuscript",
    reads: [{ path: documentPath, revision: null }],
    writes: [{ path: documentPath, revision: null, content: text }],
    message: "loom(scene): scene-1",
  };
  const entry: JournalEntry = {
    version: 1,
    key: "",
    repositoryKey: repositoryKey(repository),
    documentKey: documentKey(repository, documentPath),
    authorScope: "fixture-author",
    repository,
    documentPath,
    sceneId: "scene-1",
    snapshot: { repository, remoteCommit },
    text,
    baseText: "Fixture base manuscript",
    operation,
    state: "draft",
    updatedAt: Date.now(),
  };
  entry.key = journalEntryKey(entry);
  return entry;
}

function FixtureEditor(): ReactNode {
  return <div className="fixture-manuscript" data-testid="fixture-editor" contentEditable role="textbox" aria-label="Fixture manuscript" tabIndex={0} suppressContentEditableWarning>
    Fixture manuscript stays mounted while its panel is selected.
  </div>;
}

const panels: WorkspacePanel[] = [
  { id: "editor", title: "Editor", render: () => <FixtureEditor /> },
  { id: "outline", title: "Outline", render: () => <div data-testid="fixture-outline">Fixture outline</div> },
  { id: "inspector", title: "Inspector", render: () => <div>Fixture inspector</div> },
  { id: "history", title: "History", render: () => <div>Fixture history</div> },
  { id: "review", title: "Review", render: () => <div data-testid="fixture-review">Fixture review</div> },
];

function FixtureApplication(): ReactNode {
  const location = useLocation();
  const navigate = useNavigate();
  const [scope, setScope] = useState("fixture-author");
  const journalRef = useRef<BrowserJournal | null>(null);
  const generationRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    void BrowserJournal.open().then((journal) => {
      if (cancelled) journal.close();
      else {
        journalRef.current = journal;
        if (window.__mobileTransitionFixture) window.__mobileTransitionFixture.journalReady = true;
      }
    });
    return () => {
      cancelled = true;
      journalRef.current?.close();
      journalRef.current = null;
    };
  }, []);

  useEffect(() => {
    const metrics = window.__mobileTransitionFixture;
    if (metrics) {
      metrics.changeRoute = (view) => navigate({ pathname: location.pathname, search: `?view=${encodeURIComponent(view)}` }, { replace: true });
    }
  }, [location.pathname, navigate]);

  const beforeLayoutChange = async (): Promise<boolean> => {
    const metrics = window.__mobileTransitionFixture;
    if (!metrics?.armed) return true;
    const outcome = metrics.outcomes.shift() ?? true;
    metrics.guardCalls += 1;
    metrics.journalCalls += 1;
    const journal = journalRef.current;
    if (!journal) throw new Error("Fixture recovery journal is not ready.");
    const stored = await journal.putLatestDraft(makeEntry(++generationRef.current));
    if (!stored) throw new Error("Fixture recovery draft was not stored.");
    metrics.journalWrites += 1;
    if (outcome === "delayed") {
      return new Promise<boolean>((resolve) => { metrics.release = () => resolve(true); });
    }
    return outcome;
  };

  if (!window.__mobileTransitionFixture) {
    const metrics: FixtureMetrics = {
      journalReady: false,
      armed: false,
      guardCalls: 0,
      journalCalls: 0,
      journalWrites: 0,
      outcomes: [],
      scope,
      arm(outcomes) {
        this.armed = true;
        this.guardCalls = 0;
        this.journalCalls = 0;
        this.journalWrites = 0;
        this.outcomes = [...outcomes];
        this.release = undefined;
      },
      releaseGuard() {
        const release = this.release;
        this.release = undefined;
        release?.();
      },
      changeScope(nextScope) {
        this.scope = nextScope;
        window.dispatchEvent(new CustomEvent("mobile-transition-scope", { detail: nextScope }));
      },
      changeRoute() {},
    };
    window.__mobileTransitionFixture = metrics;
  }

  useEffect(() => {
    const updateScope = (event: Event) => {
      const next = (event as CustomEvent<string>).detail;
      if (typeof next === "string") setScope(next);
    };
    window.addEventListener("mobile-transition-scope", updateScope);
    return () => window.removeEventListener("mobile-transition-scope", updateScope);
  }, []);

  return <>
    <div className="fixture-controls" aria-label="Fixture controls">
      <output data-testid="fixture-route">{new URLSearchParams(location.search).get("view") ?? "writing"}</output>
      <output data-testid="fixture-scope">{scope}</output>
    </div>
    <MobileShell
      mode="mobile"
      header={<span>Fixture header</span>}
      documentTitle="Fixture Scene"
      documentContext="Fixture Chapter"
      library={<div>Fixture library</div>}
      editor={<FixtureEditor />}
      tools={<div>Fixture tools</div>}
      status={<div>Fixture status</div>}
      renderStatus={(interactionError) => interactionError ? <p role="alert">{interactionError}</p> : <p>Ready</p>}
      onSwitchMode={async () => false}
      workspaceScope={scope}
      panels={panels}
      beforeLayoutChange={beforeLayoutChange}
    />
  </>;
}

createRoot(document.getElementById("root")!).render(<BrowserRouter><FixtureApplication /></BrowserRouter>);
