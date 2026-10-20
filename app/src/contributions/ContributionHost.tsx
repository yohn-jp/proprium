import { useEffect, useId, useRef, useState } from "react";
import { snapshotKey, type BrowserEditorDocument, type BrowserModuleContext, type BrowserModuleDefinition, type ChangeOperation, type ChangeProposal, type ModuleStatus, type SnapshotId, type UiContribution } from "@scriptorium/contracts";
import { api } from "../api";
import { moduleBrowserLoaders } from "../generated/browser-modules";
import type { BrowserJournal, JournalProposalOwnership } from "../storage/journal";
import { discoverableContributions, workspaceContributions } from "./catalog";

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
  const visible = discoverableContributions(contributions, modules, slot);
  const [selection, setSelection] = useState("");
  const headingId = useId();
  const selectorId = useId();
  const selected = visible.find((item) => item.id === selection);
  useEffect(() => {
    if (selection && !selected) setSelection("");
  }, [selection, selected]);
  if (visible.length === 0) return null;

  return (
    <section className={`contribution-host contribution-host-${slot}`} aria-labelledby={headingId}>
      <h2 id={headingId}>{SLOT_LABELS[slot]}</h2>
      <label className="contribution-selector" htmlFor={selectorId}>
        <span>機能を選択</span>
        <select id={selectorId} value={selected?.id ?? ""} onChange={(event) => setSelection(event.currentTarget.value)}>
          <option value="">選択してください</option>
          {visible.map((item) => (
            <option key={item.id} value={item.id}>{item.title}（{item.module}）</option>
          ))}
        </select>
      </label>
      {selected && (
        <MountedContribution
          key={selected.id}
          item={selected}
          projectId={projectId}
          authorScope={authorScope}
          snapshot={snapshot}
          refresh={refresh}
          journal={journal}
          onProposalStored={onProposalStored}
          readCurrentEditor={readCurrentEditor}
        />
      )}
    </section>
  );
}

export function MountedContribution({
  item,
  projectId,
  authorScope,
  snapshot,
  refresh,
  journal,
  onProposalStored,
  readCurrentEditor,
  navigateDocument,
}: {
  item: UiContribution;
  projectId: string;
  authorScope: string;
  snapshot: SnapshotId;
  refresh: () => Promise<void>;
  journal: BrowserJournal | null;
  onProposalStored: () => void;
  readCurrentEditor: () => BrowserEditorDocument | null;
  navigateDocument?: (path: string) => Promise<void>;
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
          navigateDocument: navigateDocument ? async (path) => {
            if (controller.signal.aborted) throw new DOMException("Panel closed", "AbortError");
            await navigateDocument(path);
          } : undefined,
          invoke: async (actionId, input) => {
            const result = await api.action(projectId, actionId, input, controller.signal, snapshot);
            if (controller.signal.aborted) throw new DOMException("Panel closed", "AbortError");
            if (snapshotKey(result.snapshot) !== snapshotId) throw new Error("Action result belongs to a different repository snapshot.");
            if (result.ok && result.proposals?.length) {
              if (!journal) throw new Error("Browser recovery storage is unavailable; the module proposal was not delivered to its panel.");
              for (const proposal of result.proposals) await journal.putProposal(snapshot.repository, authorScope, proposal);
              if (result.proposals.length > 0) onProposalStored();
            }
            return result;
          },
          propose: async (operations: ChangeOperation[], evidence) => {
            const isCancelled = () => cancelled || controller.signal.aborted;
            const abortError = () => new DOMException("Panel closed", "AbortError");
            if (isCancelled()) throw abortError();
            if (!journal) throw new Error("Browser recovery storage is unavailable; the module proposal was not delivered to its panel.");
            const proposalJournal = journal;
            const ownedProposals = new Map<string, JournalProposalOwnership>();
            // A cancelled POST may already be durable in Core even if no reply arrived.
            // Once dispatch begins, the browser copy must survive for ID-based reconciliation.
            let submissionMayHaveReachedCore = false;
            const removeCancelledProposals = async () => {
              if (submissionMayHaveReachedCore) return;
              let removedAny = false;
              for (const [proposalId, ownership] of ownedProposals) {
                removedAny = await proposalJournal.removeProposal(snapshot.repository, authorScope, proposalId, ownership) || removedAny;
                ownedProposals.delete(proposalId);
              }
              if (removedAny) onProposalStored();
            };
            const persistWhileActive = async (proposal: ChangeProposal) => {
              try {
                const ownership = await proposalJournal.putProposal(snapshot.repository, authorScope, proposal);
                if (ownership) ownedProposals.set(proposal.id, ownership);
              } catch (cause) {
                if (!isCancelled()) throw cause;
                await removeCancelledProposals();
                throw abortError();
              }
              if (isCancelled()) {
                await removeCancelledProposals();
                throw abortError();
              }
            };

            const submitted: ChangeProposal = {
              // The cookie-owner proposals endpoint assigns "author" regardless of the browser request's source.
              // Keep the strict local journal identity identical to the server's canonical proposal.
              id: crypto.randomUUID(), snapshot, operations, source: "author", ...(evidence ? { evidence } : {}),
            };
            await persistWhileActive(submitted);
            onProposalStored();
            if (isCancelled()) {
              await removeCancelledProposals();
              throw abortError();
            }

            let proposal: ChangeProposal;
            try {
              submissionMayHaveReachedCore = true;
              proposal = await api.propose(projectId, submitted, controller.signal);
            } catch (cause) {
              if (!isCancelled()) throw cause;
              await removeCancelledProposals();
              throw abortError();
            }
            if (isCancelled()) {
              await removeCancelledProposals();
              throw abortError();
            }

            await persistWhileActive(proposal);
            if (proposal.id !== submitted.id && ownedProposals.has(submitted.id)) {
              const ownership = ownedProposals.get(submitted.id)!;
              await proposalJournal.removeProposal(snapshot.repository, authorScope, submitted.id, ownership);
              ownedProposals.delete(submitted.id);
              if (isCancelled()) {
                await removeCancelledProposals();
                throw abortError();
              }
            }
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
  }, [authorScope, item.action, item.id, item.module, journal, navigateDocument, onProposalStored, projectId, readCurrentEditor, refresh, snapshot, snapshotId]);

  return (
    <article className="contribution-card" aria-label={item.title}>
      <h3>{item.title}</h3>
      {error && <p className="status" data-kind="error" role="status">{error}</p>}
      <div ref={elementRef} data-contribution={item.id} />
    </article>
  );
}

/** A registered, enabled panel instance; mounting remains subject to the live host catalog. */
export function WorkspaceContribution(props: Parameters<typeof MountedContribution>[0] & {
  contributions: UiContribution[];
  modules: ModuleStatus[];
}) {
  const allowed = workspaceContributions(props.contributions, props.modules).some((item) =>
    item.id === props.item.id && item.module === props.item.module && item.action === props.item.action);
  return allowed ? <MountedContribution {...props} /> : <p role="status">このパネルは利用できません。</p>;
}
