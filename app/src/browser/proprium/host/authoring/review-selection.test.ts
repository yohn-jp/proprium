import assert from "node:assert/strict";
import test from "node:test";
import { selectReviewUnit } from "./review-selection.js";
const units = [{id:"scene",depends_on:[]},{id:"chapter",depends_on:["scene"]},{id:"volume",depends_on:["chapter"]},{id:"independent",depends_on:[]}];
test("partial review includes transitive prerequisites and preserves independent choices",()=>{
  assert.deepEqual(selectReviewUnit(units,["independent"],"volume",true),["scene","chapter","volume","independent"]);
  assert.deepEqual(selectReviewUnit(units,["scene","chapter","volume","independent"],"scene",false),["independent"]);
});
test("invalid dependency graphs cannot silently authorize a subset",()=>{
  assert.throws(()=>selectReviewUnit([{id:"a",depends_on:["b"]}],[],"a",true));
  assert.throws(()=>selectReviewUnit([{id:"a",depends_on:["b"]},{id:"b",depends_on:["a"]}],[],"a",true));
});
