import { useEffect, useMemo, useRef, useState } from "react";
import { snapshotKey, type BrowserEditorDocument, type BrowserModuleContext, type BrowserModuleDefinition, type ChangeOperation, type ChangeProposal, type ModuleStatus, type SnapshotId, type UiContribution } from "@scriptorium/contracts";
import { api } from "../api";
import { moduleBrowserLoaders } from "../generated/browser-modules";
import type { BrowserJournal } from "../storage/journal";

const SLOT_LABELS = {
  editor: "執筆ツール",
  dock: "ドック",
  inspection: "確認",
  review: "レビュー",
  settings: "設定",
} as const;

export function ContributionHost({
  projectId,
  authorScope,
  slot,
  contributions,
  modules,
  snapshot,
  refresh,
  journal,
  onProposalStored,
  readCurrentEditor,
}: {
  projectId: string;
  authorScope: string;
  slot: UiContribution["slot"];
  contributions: UiContribution[];
  modules: ModuleStatus[];
  snapshot: SnapshotId;
  refresh: () => Promise<void>;
  journal: BrowserJournal | null;
  onProposalStored: () => void;
  readCurrentEditor: () => BrowserEditorDocument | null;
}) {
  const allowedModules = useMemo(
    () => new Set(modules.filter((module) => module.availability === "enabled-idle" || module.availability === "active").map((module) => module.id)),
    [modules],
  );
  const visible = contributions.filter((item) => item.slot === slot && allowedModules.has(item.module));
  if (visible.length === 0) return null;

  return (
    <section className={`contribution-host contribution-host-${slot}`} aria-label={SLOT_LABELS[slot]}>
      <h2>{SLOT_LABELS[slot]}</h2>
      {visible.map((item) => (
        <MountedContribution
          key={item.id}
          item={item}
          projectId={projectId}
          authorScope={authorScope}
          snapshot={snapshot}
          refresh={refresh}
          journal={journal}
          onProposalStored={onProposalStored}
          readCurrentEditor={readCurrentEditor}
        />
      ))}
    </section>
  );
}

function MountedContribution({
  item,
  projectId,
  authorScope,
  snapshot,
  refresh,
  journal,
  onProposalStored,
  readCurrentEditor,
}: {
  item: UiContribution;
  projectId: string;
  authorScope: string;
  snapshot: SnapshotId;
  refresh: () => Promise<void>;
  journal: BrowserJournal | null;
  onProposalStored: () => void;
  readCurrentEditor: () => BrowserEditorDocument | null;
}) {
  const elementRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState("");
  const snapshotId = snapshotKey(snapshot);

  useEffect(() => {
    let cancelled = false;
    let dispose: (() => void) | undefined;
    const controller = new AbortController();
    setError("");
    const loader = moduleBrowserLoaders[item.module];
    if (!loader) {
      setError("この機能のブラウザーパネルは選択中の Core プロファイルに含まれていません。");
      return;
    }

    void (async () => {
      try {
        const definition = await loader();
        const element = elementRef.current;
        if (!element || cancelled) return;
        const context: BrowserModuleContext = {
          projectId,
          snapshot,
          signal: controller.signal,
          readCurrentEditor,
          invoke: async (actionId, input) => {
            const result = await api.action(projectId, actionId, input, controller.signal);
            if (result.ok && result.proposals?.length) {
              if (!journal) throw new Error("Browser recovery storage is unavailable; the module proposal was not delivered to its panel.");
              for (const proposal of result.proposals) await journal.putProposal(snapshot.repository, authorScope, proposal);
              if (result.proposals.length > 0) onProposalStored();
            }
            if (snapshotKey(result.snapshot) !== snapshotId) throw new Error("Action result belongs to a different repository snapshot.");
            return result;
          },
          propose: async (operations: ChangeOperation[], evidence) => {
            const submitted: ChangeProposal = {
              id: crypto.randomUUID(), snapshot, operations, source: "module", ...(evidence ? { evidence } : {}),
            };
            if (!journal) throw new Error("Browser recovery storage is unavailable; the module proposal was not delivered to its panel.");
            await journal.putProposal(snapshot.repository, authorScope, submitted);
            onProposalStored();
            const proposal = await api.propose(projectId, submitted);
            await journal.putProposal(snapshot.repository, authorScope, proposal);
            if (proposal.id !== submitted.id) await journal.removeProposal(snapshot.repository, authorScope, submitted.id);
            onProposalStored();
            return proposal;
          },
          refresh,
        };
        const cleanup = await definition.mount(item.id, element, context);
        if (cancelled) {
          cleanup?.();
        } else if (cleanup) {
          dispose = cleanup;
        }
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : "Contribution panel could not be loaded.");
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
      dispose?.();
    };
  }, [authorScope, item.action, item.id, item.module, journal, onProposalStored, projectId, readCurrentEditor, refresh, snapshot, snapshotId]);

  return (
    <article className="contribution-card" aria-label={item.title}>
      <h3>{item.title}</h3>
      {error && <p className="status" data-kind="error" role="status">{error}</p>}
      <div ref={elementRef} data-contribution={item.id} />
    </article>
  );
}
