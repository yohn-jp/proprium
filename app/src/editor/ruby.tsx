import type { ReactNode } from "react";
import type { EditorTermSpan } from "./terms";

/** Source behavior from app/src/features/editor/manuscriptRuby.tsx: explicit Aozora `|漢字《よみ》` only. */
const RUBY_RE = /\|([^《|\n]+?)《([^》]+)》/g;

export type RubySegment =
  | { kind: "text"; value: string; key: string }
  | { kind: "ruby"; base: string; reading: string; key: string };

export function parseRubySegments(line: string): RubySegment[] {
  const segments: RubySegment[] = [];
  let last = 0;
  RUBY_RE.lastIndex = 0;
  let match = RUBY_RE.exec(line);
  while (match !== null) {
    if (match.index > last) segments.push({ kind: "text", value: line.slice(last, match.index), key: `text-${last}` });
    segments.push({ kind: "ruby", base: match[1] ?? "", reading: match[2] ?? "", key: `ruby-${match.index}` });
    last = match.index + match[0].length;
    match = RUBY_RE.exec(line);
  }
  if (last < line.length) segments.push({ kind: "text", value: line.slice(last), key: `text-${last}` });
  return segments.length > 0 ? segments : [{ kind: "text", value: line, key: "text-0" }];
}

export function renderRubySegmentNodes(
  line: string,
  lineOffset = 0,
  termSpans: readonly EditorTermSpan[] = [],
  onTermNavigate?: (targetPath: string, termId: string) => void,
): ReactNode[] {
  return parseRubySegments(line).map((segment) => {
    const localStart = Number(segment.key.slice(segment.key.lastIndexOf("-") + 1));
    if (segment.kind === "ruby") {
      const baseStart = lineOffset + localStart + 1;
      return <ruby key={segment.key}>{renderTermText(segment.base, baseStart, termSpans, onTermNavigate)}<rt>{segment.reading}</rt></ruby>;
    }
    return <span key={segment.key}>{renderTermText(segment.value || "\u00a0", lineOffset + localStart, termSpans, onTermNavigate)}</span>;
  });
}

export function RubyText({ text, className, termSpans = [], onTermNavigate }: {
  text: string;
  className?: string;
  termSpans?: readonly EditorTermSpan[];
  onTermNavigate?: (targetPath: string, termId: string) => void;
}) {
  let sourceOffset = 0;
  return (
    <div className={className}>
      {text.split("\n").map((line, index) => {
        const lineOffset = sourceOffset;
        sourceOffset += line.length + 1;
        return <p className="ruby-line" key={index} data-source-start={lineOffset} data-source-end={lineOffset + line.length}>
          {renderRubySegmentNodes(line, lineOffset, termSpans, onTermNavigate)}
        </p>;
      })}
    </div>
  );
}

function renderTermText(
  value: string,
  sourceOffset: number,
  termSpans: readonly EditorTermSpan[],
  onTermNavigate?: (targetPath: string, termId: string) => void,
): ReactNode[] {
  if (!onTermNavigate || termSpans.length === 0) return [value];
  const sourceEnd = sourceOffset + value.length;
  const matches = termSpans
    .filter((span) => span.start >= sourceOffset && span.end <= sourceEnd && span.end > span.start)
    .sort((left, right) => left.start - right.start || left.end - right.end);
  if (matches.length === 0) return [value];

  const nodes: ReactNode[] = [];
  let cursor = 0;
  for (const span of matches) {
    const start = span.start - sourceOffset;
    const end = span.end - sourceOffset;
    if (start < cursor) continue;
    if (start > cursor) nodes.push(<span key={`text-${cursor}`}>{value.slice(cursor, start)}</span>);
    const label = value.slice(start, end);
    nodes.push(<button
      type="button"
      className="term-navigation"
      key={`term-${span.start}-${span.termId}`}
      aria-label={`${label}、用語を開く`}
      data-term-id={span.termId}
      onClick={() => onTermNavigate(span.targetPath, span.termId)}
    >{label}</button>);
    cursor = end;
  }
  if (cursor < value.length) nodes.push(<span key={`text-${cursor}`}>{value.slice(cursor)}</span>);
  return nodes.length > 0 ? nodes : [value];
}

export function documentBody(content: string): { prefix: string; body: string } {
  const lines = content.split(/(?<=\n)/u);
  const first = (lines[0] ?? "").replace(/^\uFEFF/u, "").replace(/\r?\n$/u, "");
  if (first !== "---") return { prefix: "", body: content };
  let offset = lines[0]?.length ?? 0;
  for (let index = 1; index < lines.length; index++) {
    const line = (lines[index] ?? "").replace(/\r?\n$/u, "");
    offset += lines[index]?.length ?? 0;
    if (line === "---" || line === "...") {
      if (index + 1 < lines.length && /^\r?\n$/u.test(lines[index + 1] ?? "")) offset += lines[index + 1]?.length ?? 0;
      const prefix = content.slice(0, offset);
      return { prefix, body: content.slice(offset) };
    }
  }
  return { prefix: "", body: content };
}

export function replaceDocumentBody(content: string, nextBody: string): string {
  const { prefix } = documentBody(content);
  return `${prefix}${nextBody}`;
}
