import type { ReactNode } from "react";
import type { EditorRecoveryStatus } from "./recovery";
import { RecoveryList } from "./LibraryOutline";
import type { JournalEntry } from "../storage/journal";

export function DocumentInspector({
  status,
  editorFacts,
  inspectedDocument,
  recoveryEntries,
}: {
  status: ReactNode;
  editorFacts: { path: string; snapshot: string; recoveryStatus: EditorRecoveryStatus } | null;
  inspectedDocument: { path: string; content: string } | null;
  recoveryEntries: JournalEntry[];
}) {
  return (
    <section aria-label="文書と保存状態">
      {status}
      {editorFacts && <dl className="project-facts">
        <div><dt>原稿</dt><dd><code>{editorFacts.path}</code></dd></div>
        <div><dt>スナップショット</dt><dd><code>{editorFacts.snapshot}</code></dd></div>
        <div><dt>ブラウザー回復</dt><dd>{editorFacts.recoveryStatus}</dd></div>
      </dl>}
      {inspectedDocument && <article>
        <h3>{inspectedDocument.path}</h3><pre className="workspace-document-source">{inspectedDocument.content}</pre>
      </article>}
      <RecoveryList entries={recoveryEntries} />
    </section>
  );
}
