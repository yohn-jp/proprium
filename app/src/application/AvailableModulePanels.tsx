import type { BrowserEditorDocument, ModuleStatus, SnapshotId, UiContribution } from "@scriptorium/contracts";
import type { WorkspacePanel } from "./contracts";
import { WorkspaceContribution } from "../contributions/ContributionHost";
import type { BrowserJournal } from "../storage/journal";

export function availableModulePanels({
  items,
  contributions,
  modules,
  projectId,
  authorScope,
  snapshot,
  journal,
  refresh,
  onProposalStored,
  readCurrentEditor,
  navigateDocument,
}: {
  items: UiContribution[];
  contributions: UiContribution[];
  modules: ModuleStatus[];
  projectId: string | null;
  authorScope: string;
  snapshot: SnapshotId | null;
  journal: BrowserJournal | null;
  refresh: () => Promise<void>;
  onProposalStored: () => void;
  readCurrentEditor: () => BrowserEditorDocument | null;
  navigateDocument: (path: string) => Promise<void>;
}): WorkspacePanel[] {
  return items.map((item) => ({
    id: `module:${item.id}`,
    title: item.title,
    render: () => projectId !== null && snapshot
      ? <WorkspaceContribution item={item} contributions={contributions} modules={modules}
          projectId={projectId} authorScope={authorScope} snapshot={snapshot}
          refresh={refresh} journal={journal} onProposalStored={onProposalStored}
          readCurrentEditor={readCurrentEditor} navigateDocument={navigateDocument} />
      : <p>作品を選択してください。</p>,
  }));
}
