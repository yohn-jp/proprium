import { useEffect, useMemo, useState } from "react";
import { snapshotKey, type SnapshotId } from "@scriptorium/contracts";
import { api, type ManuscriptSnapshot, type ManuscriptSnapshotMeta } from "../api";

interface DiffLine { type: "same" | "add" | "remove"; text: string }

function diffLines(before: string, after: string): DiffLine[] {
  const left = before.split("\n");
  const right = after.split("\n");
  if (left.length * right.length > 250_000) {
    let prefix = 0;
    while (prefix < left.length && prefix < right.length && left[prefix] === right[prefix]) prefix++;
    let suffix = 0;
    while (suffix < left.length - prefix && suffix < right.length - prefix && left[left.length - suffix - 1] === right[right.length - suffix - 1]) suffix++;
    return [
      ...left.slice(0, prefix).map((text) => ({ type: "same" as const, text })),
      ...left.slice(prefix, left.length - suffix).map((text) => ({ type: "remove" as const, text })),
      ...right.slice(prefix, right.length - suffix).map((text) => ({ type: "add" as const, text })),
      ...left.slice(left.length - suffix).map((text) => ({ type: "same" as const, text })),
    ];
  }
  const lengths: number[][] = Array.from({ length: left.length + 1 }, () => Array<number>(right.length + 1).fill(0));
  for (let i = left.length - 1; i >= 0; i--) {
    for (let j = right.length - 1; j >= 0; j--) {
      const row = lengths[i];
      if (row) row[j] = left[i] === right[j] ? (lengths[i + 1]?.[j + 1] ?? 0) + 1 : Math.max(lengths[i + 1]?.[j] ?? 0, row[j + 1] ?? 0);
    }
  }
  const result: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) {
      result.push({ type: "same", text: left[i] ?? "" }); i++; j++;
    } else if ((lengths[i + 1]?.[j] ?? 0) >= (lengths[i]?.[j + 1] ?? 0)) {
      result.push({ type: "remove", text: left[i] ?? "" }); i++;
    } else {
      result.push({ type: "add", text: right[j] ?? "" }); j++;
    }
  }
  while (i < left.length) result.push({ type: "remove", text: left[i++] ?? "" });
  while (j < right.length) result.push({ type: "add", text: right[j++] ?? "" });
  return result;
}

export function ManuscriptHistoryPanel({
  projectId,
  manuscriptId,
  sceneId,
  snapshot,
  currentBody,
  onRestore,
  onClose,
}: {
  projectId: string;
  manuscriptId: string;
  sceneId: string;
  snapshot: SnapshotId;
  currentBody: string;
  onRestore: (body: string) => void;
  onClose: () => void;
}) {
  const pinnedKey = snapshotKey(snapshot);
  const [versions, setVersions] = useState<ManuscriptSnapshotMeta[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [selected, setSelected] = useState<ManuscriptSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let current = true;
    setLoading(true);
    setError("");
    setVersions([]);
    setSelectedId("");
    setSelected(null);
    void api.manuscriptSnapshots(projectId, manuscriptId, sceneId, snapshot)
      .then((result) => {
        if (!current) return;
        if (snapshotKey(result.snapshot) !== pinnedKey) throw new Error("履歴一覧のスナップショットが現在の原稿と一致しません。再読み込みしてください。");
        setVersions(result.snapshots);
        setSelectedId(result.snapshots[0]?.id ?? "");
      })
      .catch((caught: unknown) => { if (current) setError(caught instanceof Error ? caught.message : "履歴を読み込めませんでした。"); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [projectId, manuscriptId, sceneId, snapshot, pinnedKey]);

  useEffect(() => {
    if (!selectedId) { setSelected(null); return; }
    let current = true;
    setSelected(null);
    setError("");
    void api.manuscriptSnapshot(projectId, manuscriptId, selectedId, snapshot)
      .then((result) => {
        if (!current) return;
        if (snapshotKey(result.snapshot) !== pinnedKey) throw new Error("履歴本文のスナップショットが一覧と一致しません。再読み込みしてください。");
        if (result.manuscript.id !== selectedId || result.manuscript.sceneId !== sceneId) throw new Error("履歴本文が選択中の原稿と一致しません。");
        setSelected(result.manuscript);
      })
      .catch((caught: unknown) => { if (current) setError(caught instanceof Error ? caught.message : "履歴本文を読み込めませんでした。"); });
    return () => { current = false; };
  }, [projectId, manuscriptId, sceneId, selectedId, snapshot, pinnedKey]);

  const diff = useMemo(() => selected ? diffLines(selected.body, currentBody) : [], [selected, currentBody]);
  const added = diff.filter((line) => line.type === "add").length;
  const removed = diff.filter((line) => line.type === "remove").length;

  return (
    <section className="history-panel manuscript-history" aria-labelledby="history-title">
      <header>
        <div>
          <h2 id="history-title">改稿の履歴</h2>
          <p>確認済みリモート版 {snapshot.remoteCommit.slice(0, 12)} から、当時の原稿と現在との差を表示します。</p>
        </div>
        <button type="button" className="quiet-button" onClick={onClose}>閉じる</button>
      </header>
      {loading && <p role="status">履歴を読み込んでいます…</p>}
      {error && <p className="status" data-kind="error" role="alert">{error}</p>}
      {!loading && !error && versions.length === 0 && <p>この原稿の Git 履歴はまだありません。</p>}
      {versions.length > 0 && (
        <div className="manuscript-history-layout">
          <ol aria-label="原稿の各バージョン">
            {versions.map((version) => (
              <li key={version.id}>
                <button type="button" aria-current={selectedId === version.id ? "true" : undefined} onClick={() => setSelectedId(version.id)}>
                  <strong>{version.label || new Date(version.createdAt).toLocaleString("ja-JP")}</strong>
                  <span>{version.charCount} 字 · {version.id.slice(0, 12)}</span>
                </button>
              </li>
            ))}
          </ol>
          <div className="manuscript-history-detail">
            {selected ? (
              <>
                <div className="history-detail-heading">
                  <p>現在との差: +{added} / −{removed} 行</p>
                  <button type="button" onClick={() => { onRestore(selected.body); onClose(); }}>この版を下書きとして開く</button>
                </div>
                <pre aria-label="原稿の差分">{diff.map((line, index) => (
                  <span className={"diff-line is-" + line.type} key={line.type + "-" + index}>
                    {line.type === "add" ? "+ " : line.type === "remove" ? "− " : "  "}{line.text || " "}{"\n"}
                  </span>
                ))}</pre>
                <details>
                  <summary>この版の Markdown と frontmatter</summary>
                  <pre>{selected.document.content}</pre>
                </details>
              </>
            ) : !error && <p role="status">選択した版を読み込んでいます…</p>}
          </div>
        </div>
      )}
    </section>
  );
}
