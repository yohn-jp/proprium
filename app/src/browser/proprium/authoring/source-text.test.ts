import assert from "node:assert/strict";
import test from "node:test";
import { sourceTextDecoder } from "./source-text.js";

test("source and editor coordinates retain BOM, CRLF and supplementary characters",()=>{
  const source="\ufeff第一行\r\n「𠮷野です」\r\n";
  const bytes=new TextEncoder().encode(source);
  const decoder=sourceTextDecoder();
  let actual="";
  for(let offset=0;offset<bytes.length;offset++)actual+=decoder.decode(bytes.subarray(offset,offset+1),{stream:offset+1<bytes.length});
  assert.equal(actual,source);
  const start=source.indexOf("𠮷");
  assert.equal(actual.slice(start,start+5),"𠮷野です");
  assert.deepEqual(new TextEncoder().encode(actual),bytes);
});

test("malformed UTF-8 never becomes replacement text in an author document",()=>{
  assert.throws(()=>sourceTextDecoder().decode(new Uint8Array([0xff])));
});
