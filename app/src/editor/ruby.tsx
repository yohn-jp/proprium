import type { ReactNode } from "react";

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

export function renderRubySegmentNodes(line: string): ReactNode[] {
  return parseRubySegments(line).map((segment) => segment.kind === "ruby" ? (
    <ruby key={segment.key}>{segment.base}<rt>{segment.reading}</rt></ruby>
  ) : (
    <span key={segment.key}>{segment.value || "\u00a0"}</span>
  ));
}

export function RubyText({ text, className }: { text: string; className?: string }) {
  return (
    <div className={className}>
      {text.split("\n").map((line, index) => (
        <p className="ruby-line" key={index}>{renderRubySegmentNodes(line)}</p>
      ))}
    </div>
  );
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
