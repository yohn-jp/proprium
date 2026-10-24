import type { FormEvent } from "react";
import type { RecentActivityDeviceType, RepositoryIdentity } from "@scriptorium/contracts";
import type { Project, Tree } from "../api";
import { formatHandoffHint, sceneTitleInTree, type ContinueCandidate } from "../resume/continueCandidates";
import type { JournalEntry } from "../storage/journal";

export interface LegacyDraftRecord {
  key: string;
  projectId: string;
  sceneId: string;
  text: string;
  revision: string;
  savedAt: number;
}

interface ProjectActionError {
  code?: string;
  message: string;
}

export function projectLabel(project: Project): string {
  try {
    const url = new URL(project.url);
    return `${url.hostname}${url.pathname.replace(/\.git$/u, "").replace(/\/$/u, "")}`;
  } catch {
    return project.url;
  }
}

interface ProjectManagementView {
  project: Project;
  repository: RepositoryIdentity;
  remoteCommit: string;
  busy: string;
  error: ProjectActionError | null;
  onReconstruct(): void;
  onDetach(): void;
}

export interface LibraryOutlineProps {
  hostedMode: boolean;
  busy: string;
  projects: Project[];
  activeProjectId: string | null;
  projectManagement: ProjectManagementView | null;
  tree: Tree | null;
  selectedSceneId: string;
  continueCandidates: ContinueCandidate[];
  deviceType: RecentActivityDeviceType;
  continueError: string;
  legacyDrafts: LegacyDraftRecord[];
  legacySelectedSceneId: string;
  recoverableEntries: JournalEntry[];
  onRegisterProject(event: FormEvent<HTMLFormElement>): void;
  onActivateProject(project: Project): void;
  onContinue(candidate: ContinueCandidate, reading: boolean): void;
  onSelectScene(sceneId: string): void;
  onExportLegacyDrafts(): void;
  onMapLegacyDraft(draft: LegacyDraftRecord): void;
}

export function LibraryOutline({
  hostedMode,
  busy,
  projects,
  activeProjectId,
  projectManagement,
  tree,
  selectedSceneId,
  continueCandidates,
  deviceType,
  continueError,
  legacyDrafts,
  legacySelectedSceneId,
  recoverableEntries,
  onRegisterProject,
  onActivateProject,
  onContinue,
  onSelectScene,
  onExportLegacyDrafts,
  onMapLegacyDraft,
}: LibraryOutlineProps) {
  return (
    <aside className="sidebar" aria-label="作品と構成">
      {tree && <TreeNav tree={tree} selectedSceneId={selectedSceneId} disabled={Boolean(busy)} onSelect={onSelectScene} />}
      {!hostedMode && <form onSubmit={onRegisterProject} className="project-form">
        <h2>作品を追加</h2>
        <label htmlFor="repo-url">GitHub リポジトリ URL</label>
        <input id="repo-url" name="url" type="url" placeholder="https://github.com/owner/work" required />
        <button type="submit" disabled={busy === "register"}>{busy === "register" ? "登録中…" : "リポジトリを登録"}</button>
      </form>}
      <section className="project-list-section" aria-labelledby="projects-title">
        <h2 id="projects-title">作品</h2>
        <ul className="plain-list">
          {projects.map((project) => (
            <li key={project.id}>
              <button type="button" className="project-button" aria-current={activeProjectId === project.id ? "true" : "false"} onClick={() => onActivateProject(project)}>
                {projectLabel(project)}
              </button>
            </li>
          ))}
          {projects.length === 0 && <li className="muted-list-item">登録された作品はありません</li>}
        </ul>
      </section>
      {projectManagement && !hostedMode && <ProjectManagement {...projectManagement} />}
      {tree && activeProjectId !== null && (
        <ContinuePanel
          candidates={continueCandidates}
          tree={tree}
          deviceType={deviceType}
          error={continueError}
          onContinue={(candidate) => onContinue(candidate, false)}
          onRead={(candidate) => onContinue(candidate, true)}
        />
      )}
      {legacyDrafts.length > 0 && <LegacyRecoveryPanel drafts={legacyDrafts} selectedSceneId={legacySelectedSceneId} onExport={onExportLegacyDrafts} onMap={onMapLegacyDraft} />}
      {activeProjectId === null && recoverableEntries.length > 0 && (
        <section className="recovery-panel" aria-labelledby="recovery-title">
          <h2 id="recovery-title">ブラウザーの回復記録</h2>
          <p>同じリポジトリを再登録すると、次の原稿を引き継げます。</p>
          <RecoveryList entries={recoverableEntries} />
        </section>
      )}
    </aside>
  );
}

function ProjectManagement({ project, repository, remoteCommit, busy, error, onReconstruct, onDetach }: ProjectManagementView) {
  return (
    <section className="project-management" aria-labelledby="project-management-title">
      <h2 id="project-management-title">選択中のリポジトリ</h2>
      <dl className="project-facts">
        <div><dt>URL</dt><dd><code>{project.url}</code></dd></div>
        <div><dt>リポジトリ ID</dt><dd><code>{repository.provider}:{repository.repositoryId}</code></dd></div>
        <div><dt>既定ブランチ</dt><dd><code>{repository.defaultBranch}</code></dd></div>
        <div><dt>登録ブランチ</dt><dd><code>{project.branch}</code></dd></div>
        <div><dt>確認したリモート</dt><dd><code>{remoteCommit.slice(0, 12)}</code></dd></div>
      </dl>
      <p className="project-management-help">再構築と解除はローカル作業領域だけに適用されます。未公開の変更がある場合は Core が拒否し、回復記録は保持します。</p>
      <div className="project-management-actions">
        <button type="button" className="compact-button" disabled={Boolean(busy)} onClick={onReconstruct}>
          {busy === "reconstruct" ? "再構築中…" : "ローカルクローンを再構築"}
        </button>
        <button type="button" className="compact-button danger-button" disabled={Boolean(busy)} onClick={onDetach}>
          {busy === "detach" ? "解除中…" : "作品の登録を解除"}
        </button>
      </div>
      {error && (
        <p className="status" data-kind="error" data-code={error.code} role="alert">
          {error.message}{error.code ? ` (${error.code})` : ""}
        </p>
      )}
    </section>
  );
}

function ContinuePanel({
  candidates,
  tree,
  deviceType,
  error,
  onContinue,
  onRead,
}: {
  candidates: ContinueCandidate[];
  tree: Tree;
  deviceType: RecentActivityDeviceType;
  error: string;
  onContinue: (candidate: ContinueCandidate) => void;
  onRead: (candidate: ContinueCandidate) => void;
}) {
  return (
    <section className="continue-panel" aria-labelledby="continue-title">
      <h2 id="continue-title">続きから</h2>
      {error && <p className="continue-error" role="status">再開位置を同期できません: {error}</p>}
      {candidates.length === 0 ? <p className="muted-list-item">再開できるシーンがまだありません</p> : (
        <ul className="continue-list">
          {candidates.map((candidate, index) => {
            const handoff = candidate.source === "server"
              ? formatHandoffHint(candidate.deviceType, candidate.updatedAt, Date.now(), deviceType)
              : null;
            return (
              <li key={candidate.sceneId}>
                <strong>{sceneTitleInTree(tree, candidate.sceneId)}</strong>
                {handoff && <small>{handoff}</small>}
                <button type="button" className="quiet-button compact-button" onClick={() => onContinue(candidate)}>
                  {index === 0 ? "続きを書く" : "こちらを開く"}
                </button>
                {candidate.pageIndex !== null && (
                  <button type="button" className="quiet-button compact-button" onClick={() => onRead(candidate)}>
                    読書位置を開く
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function TreeNav({ tree, selectedSceneId, disabled, onSelect }: { tree: Tree; selectedSceneId: string; disabled: boolean; onSelect: (id: string) => void }) {
  return (
    <nav className="tree" aria-label="作品構成">
      <h2>{tree.title}</h2>
      {tree.volumes.map((volume) => (
        <section className="tree-volume" key={volume.id}>
          <h3>{volume.title}</h3>
          {volume.chapters.map((chapter) => (
            <details key={chapter.id} open>
              <summary>{chapter.title}</summary>
              <ul className="scene-list">
                {chapter.scenes.map((scene) => (
                  <li key={scene.id}>
                    <button type="button" className="scene-button" aria-current={selectedSceneId === scene.id ? "true" : "false"} disabled={disabled} onClick={() => onSelect(scene.id)}>
                      {chapter.title}: {scene.title}
                    </button>
                  </li>
                ))}
              </ul>
            </details>
          ))}
        </section>
      ))}
    </nav>
  );
}

export function RecoveryList({ entries }: { entries: JournalEntry[] }) {
  return (
    <ul className="recovery-list">
      {entries.map((entry) => (
        <li key={entry.key}>
          <strong>{entry.documentPath}</strong>
          <span>{entry.state} · {new Date(entry.updatedAt).toLocaleString("ja-JP")}</span>
          <small>{entry.repository.url} · {entry.repository.defaultBranch}</small>
          <details>
            <summary>保護した変更の範囲</summary>
            <dl className="project-facts">
              <div><dt>操作 / generation</dt><dd><code>{entry.operation.id} / {entry.operation.generation}</code></dd></div>
              <div><dt>元revision</dt><dd><code>{entry.snapshot.remoteCommit}</code></dd></div>
              {entry.checkpoint && <div><dt>Checkpoint revision</dt><dd><code>{entry.checkpoint.localCommit}</code></dd></div>}
              {entry.publicationBatchId && <div><dt>照合する保存バッチ</dt><dd><code>{entry.publicationBatchId}</code></dd></div>}
            </dl>
          </details>
        </li>
      ))}
    </ul>
  );
}

function LegacyRecoveryPanel({
  drafts,
  selectedSceneId,
  onExport,
  onMap,
}: {
  drafts: LegacyDraftRecord[];
  selectedSceneId: string;
  onExport: () => void;
  onMap: (draft: LegacyDraftRecord) => void;
}) {
  return (
    <section className="recovery-panel" aria-labelledby="legacy-recovery-title">
      <h2 id="legacy-recovery-title">旧ブラウザー下書き</h2>
      <p>プロジェクト ID に結び付いた古い下書きです。移行先が確認できるまで元の記録を残します。</p>
      <ul className="recovery-list">
        {drafts.map((draft) => (
          <li key={draft.key}>
            <strong>シーン {draft.sceneId}</strong>
            <span>{draft.text.length} 字 · {new Date(draft.savedAt).toLocaleString("ja-JP")}</span>
            {selectedSceneId && <button type="button" className="quiet-button" onClick={() => onMap(draft)}>選択中のシーンに下書きとして移す</button>}
          </li>
        ))}
      </ul>
      <button type="button" className="quiet-button" onClick={onExport}>回復 JSON をダウンロード</button>
    </section>
  );
}
