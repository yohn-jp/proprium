import assert from "node:assert/strict";
import test from "node:test";
import { analyzeText, DEFAULT_LINT_RULES, bodyOffset, findingFingerprint, findingsForTextAnalysis, formatManuscript, lintText, sha256 } from "../src/core.js";

test("lint offsets point to exact UTF-16 body spans, including surrogate pairs", () => {
  const text = "😀彼は、走り、そして、笑った。\n「せりふ」\n彼は…と言った。";
  const result = lintText(text, [
    { id: "comma", kind: "punctuation_count", maxCount: 1 },
    { id: "forbidden", kind: "narration_forbidden_marks", forbiddenMarks: ["…"] },
  ]);
  assert.equal(result.length, 2);
  const punctuation = result.find((row) => row.ruleId === "comma");
  const ellipsis = result.find((row) => row.ruleId === "forbidden");
  assert.equal(punctuation?.offset, 0);
  assert.equal(text.slice(punctuation!.offset, punctuation!.offset + punctuation!.length), punctuation?.excerpt);
  assert.equal(ellipsis?.offset, text.indexOf("…"));
  assert.equal(ellipsis?.length, 1);
});

test("all six configured rule kinds execute against the same unchanged input", () => {
  const text = "長い文、長い文、さらに長い文。\nそうだった。そうだった。そうだった。\n「会話」\nabc abc";
  const results = lintText(text, [
    { id: "regex", kind: "regex_sequence", pattern: "abc", replacement: "xyz" },
    { id: "spacing", kind: "line_spacing", startPattern: "^[「『]" },
    { id: "length", kind: "sentence_length", maxLength: 4 },
    { id: "punctuation", kind: "punctuation_count", maxCount: 1 },
    { id: "ending", kind: "ending_repetition", maxRepeat: 2 },
    { id: "marks", kind: "narration_forbidden_marks", forbiddenMarks: ["abc"] },
  ]);
  for (const id of ["regex", "spacing", "length", "punctuation", "marks"]) assert.ok(results.some((warning) => warning.ruleId === id), id);
  assert.ok(results.some((warning) => warning.ruleId === "ending"), "ending repetition is detected");
  assert.equal(text, "長い文、長い文、さらに長い文。\nそうだった。そうだった。そうだった。\n「会話」\nabc abc", "analysis must remain read-only");
});

test("text analysis excludes frontmatter offsets and marks Research unavailable", () => {
  const text = "---\ntitle: Sample\n---\n「会話」\nそうだった。そうだった。そうだった。";
  const result = analyzeText(text);
  assert.equal(result.charCount, text.length - bodyOffset(text));
  assert.equal(result.textHash, sha256("「会話」\nそうだった。そうだった。そうだった。"));
  assert.deepEqual(result.providers, { lexical: "unavailable" });
  const findings = findingsForTextAnalysis(text, result, {
    workspaceId: "workspace-a", repositoryId: 42, branch: "main", generation: "gen-1", snapshotId: "snap-1",
    documentPath: "manuscript/sample.md", documentRevision: "a".repeat(64),
  });
  const rhythm = findings.find((finding) => finding.kind === "rhythm");
  assert.equal(rhythm?.range.start, "「会話」\n".length);
  assert.equal(rhythm?.quote, "そうだった。そうだった。そうだった。");
  const otherRepository = findingsForTextAnalysis(text, result, {
    workspaceId: "workspace-b", repositoryId: 43, branch: "main", generation: "gen-1", snapshotId: "snap-1",
    documentPath: "manuscript/sample.md", documentRevision: "a".repeat(64),
  });
  assert.notEqual(rhythm?.fingerprint, otherRepository.find((finding) => finding.kind === "rhythm")?.fingerprint);
  const afterReload = findingsForTextAnalysis(text, result, {
    workspaceId: "workspace-other", repositoryId: 42, branch: "main", generation: "gen-2", snapshotId: "snap-2",
    documentPath: "manuscript/sample.md", documentRevision: "a".repeat(64),
  });
  assert.equal(rhythm?.fingerprint, afterReload.find((finding) => finding.kind === "rhythm")?.fingerprint, "unrelated snapshot/workspace generations do not orphan decisions");
  const afterConfigChange = findingsForTextAnalysis(text, result, {
    workspaceId: "workspace-a", repositoryId: 42, branch: "main", generation: "gen-2", snapshotId: "snap-2",
    documentPath: "manuscript/sample.md", documentRevision: "a".repeat(64), configRevision: "b".repeat(64),
  });
  assert.notEqual(rhythm?.fingerprint, afterConfigChange.find((finding) => finding.kind === "rhythm")?.fingerprint, "a lint config change gets a new decision identity");
});

test("formatter preserves frontmatter bytes and CRLF while previewing body changes", () => {
  const eol = String.fromCharCode(13, 10);
  const text = ["---", "title:  未変更", "custom: [x, y]", "---", "  地の文…", "「会話」", "次の行", ""].join(eol);
  const formatted = formatManuscript(text);
  assert.equal(formatted.text.slice(0, bodyOffset(text)), text.slice(0, bodyOffset(text)));
  assert.equal(formatted.frontmatterPreserved, true);
  assert.equal(formatted.changed, true);
  assert.ok(formatted.text.includes("地の文……"));
  assert.ok(formatted.text.includes("\r\n\r\n「会話」\r\n\r\n"));
  assert.ok(formatted.text.endsWith("次の行"));
});

test("default formatter is stable when rerun", () => {
  const once = formatManuscript("本文…\n「会話」\n次の行").text;
  const twice = formatManuscript(once).text;
  assert.equal(once, twice);
});

test("SHA-256 and findings use exact deterministic UTF-8 identities", () => {
  assert.equal(sha256("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  const input = { actionId: "proprium.diagnostics.lint.run.v1", analyzerVersion: "1", sourcePath: "manuscript/a.md", sourceRevision: "revision", textHash: sha256("abc"), kind: "format", ruleId: "r1", start: 1, end: 2, quote: "b" };
  assert.equal(findingFingerprint(input), findingFingerprint({ ...input }));
  assert.notEqual(findingFingerprint(input), findingFingerprint({ ...input, sourceRevision: "other" }));
});

test("default rules preserve the source defaults", () => {
  const warnings = lintText("彼は…笑った。\n「会話」", DEFAULT_LINT_RULES);
  assert.deepEqual(warnings.map((warning) => warning.ruleId), ["ellipsis-single-piece", "dialogue-blank-line"]);
});
