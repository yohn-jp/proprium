import assert from "node:assert/strict";
import test from "node:test";
import { checkProjectConsistency, findingId, type ProjectFile } from "../src/projectConsistency.js";

const revision = (value: string) => value.repeat(64).slice(0, 64);
const file = (path: string, text: string): ProjectFile => ({ path, text, revision: revision(String.fromCharCode(97 + path.length % 6)) });

test("consistency reports duplicate IDs, absent manuscript, broken links and thread gaps with source evidence", () => {
  const files = [
    file("plot/volumes/one/volume.yaml", "id: vol-1\norder: 1\ncustom: {preserve: true}\n"),
    file("plot/volumes/one/chapters/first/chapter.yaml", "id: ch-1\nvolume: vol-1\norder: 1\n"),
    file("plot/volumes/one/chapters/first/scenes/a.yaml", "id: sc-1\nchapter: ch-1\norder: 1\nmanuscript: manuscript/a.md\nappears: [unknown-character]\nplants: [thread-2]\n"),
    file("plot/volumes/one/chapters/first/scenes/b.yaml", "id: sc-1\nchapter: ch-1\norder: 2\nmanuscript: manuscript/missing.md\n"),
    file("plot/threads/unplanted.yaml", "id: thread-1\nstatus: open\n"),
    file("plot/threads/planted.yaml", "id: thread-2\nstatus: open\n"),
    file("manuscript/a.md", "本文\n"),
  ];
  const result = checkProjectConsistency(files);
  assert.equal(result.recognized, true);
  assert.ok(result.findings.some((finding) => finding.code === "DUPLICATE_ID" && finding.entityId === "sc-1"));
  const duplicate = result.findings.find((finding) => finding.code === "DUPLICATE_ID");
  assert.deepEqual(duplicate?.evidence?.map((item) => item.path), [
    "plot/volumes/one/chapters/first/scenes/a.yaml",
    "plot/volumes/one/chapters/first/scenes/b.yaml",
  ]);
  assert.ok(result.findings.some((finding) => finding.code === "MISSING_LINK_TARGET" && finding.entityId === "sc-1"));
  assert.ok(result.findings.some((finding) => finding.code === "MISSING_MANUSCRIPT" && finding.message.includes("missing.md")));
  assert.ok(result.findings.some((finding) => finding.code === "THREAD_NO_PLANT" && finding.entityId === "thread-1"));
  assert.ok(result.findings.some((finding) => finding.code === "THREAD_NO_PAYOFF" && finding.entityId === "thread-2"));
  assert.equal(result.counts.error, 2);
  assert.ok(result.findings.filter((finding) => finding.filePath).every((finding) => finding.sourceRevision));
  assert.equal(findingId("snapshot-1", result.findings[0]), findingId("snapshot-1", result.findings[0]));
});

test("generic Git workspaces are not classified as invalid narrative projects", () => {
  const result = checkProjectConsistency([file("README.md", "A generic workspace."), file("docs/overview.yaml", "id: arbitrary\n")]);
  assert.deepEqual(result, { recognized: false, findings: [], counts: { error: 0, warning: 0 } });
});

test("malformed YAML remains untouched and has a path-specific finding", () => {
  const source = file("plot/volumes/one/chapters/first/scenes/bad.yaml", "id: [not closed\n");
  const result = checkProjectConsistency([
    file("plot/volumes/one/volume.yaml", "id: vol-1\n"),
    file("plot/volumes/one/chapters/first/chapter.yaml", "id: ch-1\nvolume: vol-1\n"),
    source,
  ]);
  assert.equal(result.findings[0].code, "MALFORMED_YAML");
  assert.equal(result.findings[0].filePath, source.path);
  assert.equal(source.text, "id: [not closed\n");
});
