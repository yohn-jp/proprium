import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_LINT_RULES } from "../src/core.js";
import { parseLintRulesConfig } from "../src/config.js";

test("missing rules in a valid lint config use the documented defaults", () => {
  assert.deepEqual(parseLintRulesConfig("severity: {}\nunknown: retained\n"), DEFAULT_LINT_RULES);
});

test("lint config parses all supported source rule types and preserves their semantics", () => {
  const rules = parseLintRulesConfig(`rules:
  - id: replace
    kind: regex_sequence
    pattern: "abc"
    replacement: "xyz"
  - id: spacing
    kind: line_spacing
    startPattern: "^[「『]"
  - id: length
    kind: sentence_length
    maxLength: 80
  - id: commas
    kind: punctuation_count
    maxCount: 2
  - id: endings
    kind: ending_repetition
    maxRepeat: 3
  - id: marks
    kind: narration_forbidden_marks
    forbiddenMarks: ["…", "!?"]
`);
  assert.equal(rules.length, 6);
  assert.deepEqual(rules[0], { id: "replace", kind: "regex_sequence", pattern: "abc", replacement: "xyz" });
  assert.deepEqual(rules[5], { id: "marks", kind: "narration_forbidden_marks", forbiddenMarks: ["…", "!?"] });
});

test("malformed, duplicate-key, unsupported and duplicate-id configs fail closed", () => {
  for (const input of [
    "rules: [\n",
    "rules:\n  - id: one\n    kind: line_spacing\n    kind: sentence_length\n",
    "rules:\n  - id: unknown\n    kind: made_up\n",
    "rules:\n  - id: same\n    kind: line_spacing\n    startPattern: x\n  - id: same\n    kind: line_spacing\n    startPattern: y\n",
  ]) assert.throws(() => parseLintRulesConfig(input));
});
