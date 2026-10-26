import type { ReactElement } from "react";
import { computeTextDiff, type TextDiffResult } from "./text-diff.js";
import "./TextDiff.css";

export interface TextDiffProps {
  before: string;
  after: string;
  beforeLabel?: string;
  afterLabel?: string;
}

function endingSummary(result: TextDiffResult | null): string | null {
  if (!result) return null;
  const parts: string[] = [];
  if (result.beforeLineEnding !== result.afterLineEnding) {
    parts.push(`改行コード: ${result.beforeLineEnding} → ${result.afterLineEnding}`);
  }
  if (result.beforeHasFinalNewline !== result.afterHasFinalNewline) {
    parts.push(`末尾の改行: ${result.beforeHasFinalNewline ? "あり" : "なし"} → ${result.afterHasFinalNewline ? "あり" : "なし"}`);
  }
  return parts.length ? parts.join(" · ") : null;
}

export function TextDiff({ before, after, beforeLabel = "変更前", afterLabel = "変更後" }: TextDiffProps): ReactElement {
  const result = computeTextDiff(before, after);
  const lineInfo = endingSummary(result);

  return <section className="text-diff" aria-label={`${beforeLabel}と${afterLabel}の比較`}>
    {result ? <>
      <div className="text-diff-legend" aria-label="差分の凡例">
        <span data-kind="removed">− {beforeLabel}</span>
        <span data-kind="added">＋ {afterLabel}</span>
        <span data-kind="context">変更なし</span>
      </div>
      <ol className="text-diff-lines" aria-label="行ごとの差分">
        {result.lines.map((line, index) => <li className="text-diff-line" data-kind={line.kind} key={`${line.kind}:${line.beforeLine ?? ""}:${line.afterLine ?? ""}:${index}`}>
          <span className="text-diff-line-number" aria-hidden="true">{line.beforeLine ?? ""}</span>
          <span className="text-diff-line-number" aria-hidden="true">{line.afterLine ?? ""}</span>
          <code>{line.kind === "removed" ? "− " : line.kind === "added" ? "+ " : "  "}{line.text || " "}</code>
        </li>)}
      </ol>
    </> : <div className="text-diff-columns">
      <section aria-label={beforeLabel}><h5>{beforeLabel}</h5><pre>{before || "（内容なし）"}</pre></section>
      <section aria-label={afterLabel}><h5>{afterLabel}</h5><pre>{after || "（内容なし）"}</pre></section>
      <p className="text-diff-large-note">ファイルが大きいため、行ごとの差分表示を省略しています。</p>
    </div>}
    {lineInfo && <p className="text-diff-ending-note">{lineInfo}</p>}
  </section>;
}
