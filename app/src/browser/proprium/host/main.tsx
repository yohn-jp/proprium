import { EditorView } from "@codemirror/view";
import { createRoot } from "react-dom/client";
import { BrowserLocalGit } from "../git/index.js";
import { isGitHubWorkspaceIdentity } from "../git/protocol.js";
import type { WorkspaceIdentity } from "../git/protocol.js";
import "../register-offline-shell.js";
import { HostApp } from "./HostApp.js";
import { BrowserRouter } from "react-router-dom";
import "../../../../styles.css";
import "./restored-host.css";
import "./LiveMcpPanel.css";

const root = document.getElementById("root");
if (!root) throw new Error("Missing Proprium Host root");

createRoot(root).render(<BrowserRouter><HostApp /></BrowserRouter>);

interface PropriumHostTestApi {
  openWorkspace(identity: WorkspaceIdentity, files?: Record<string, string>): Promise<void>;
}
declare global {
  interface Window {
    propriumHostTest?: PropriumHostTestApi;
    propriumHostEditorText?: () => string | null;
    propriumHostOpenLocalWorkspace?: (entry: { identity: WorkspaceIdentity; title: string; lastOpened: number }) => Promise<void>;
  }
}

if (import.meta.env.VITE_PROPRIUM_E2E === "true") {
  window.propriumHostEditorText = () => { const node = document.querySelector<HTMLElement>(".cm-editor"); return node ? EditorView.findFromDOM(node)?.state.doc.toString() ?? null : null; };
  window.propriumHostTest = Object.freeze({
    async openWorkspace(identity: WorkspaceIdentity, files: Record<string, string> = {}): Promise<void> {
      const git = new BrowserLocalGit(identity);
      try {
        await git.init();
        for (const [path, text] of Object.entries(files)) {
          const existing = await git.read(path);
          if (existing.data === null) await git.write(path, new TextEncoder().encode(text), existing.revision);
        }
      } finally { git.close(); }
      const detail = { identity, title: isGitHubWorkspaceIdentity(identity) ? `${identity.owner}/${identity.repository}` : identity.name, lastOpened: Date.now() };
      for (let attempt = 0; !window.propriumHostOpenLocalWorkspace && attempt < 200; attempt += 1) {
        await new Promise(resolve => window.setTimeout(resolve, 10));
      }
      if (!window.propriumHostOpenLocalWorkspace) throw new Error("Proprium Host is not ready to open a test workspace.");
      await window.propriumHostOpenLocalWorkspace(detail);
    },
  });
}
