import {test} from "node:test";
import assert from "node:assert/strict";
import {buildContinuationContext, renderContinuationPrompt, generateContinuation} from "../src/continuation.js";
test("continuation preserves newest sentences, priority and approximate token accounting",()=>{
 const result=buildContinuationContext({recentSentences:["古い", "新しい"],k:1,chapterSummary:{chapterId:"c",text:"要約"},retrievalHits:[{entityId:"e",text:"根拠"}],tokenBudget:100});
 assert.equal(result.text,"新しい\n\n要約\n\n根拠");assert.equal(result.manifest.tokenCountMode,"approximate");
 assert.deepEqual(result.manifest.parts.map(x=>x.kind),["recent-sentences","chapter-summary","retrieval-hit"]);
 assert.match(renderContinuationPrompt(result.text),/新しい\n\n要約\n\n根拠/u);
});
test("continuation drops oldest sentences then entire lower-priority parts",()=>{
 const r=buildContinuationContext({recentSentences:["古い文", "新しい"],chapterSummary:{chapterId:"c",text:"要約"},tokenBudget:4});
 assert.equal(r.text,"新しい"); assert.equal(r.manifest.totalTokens,3);
});
test("generation uses the exact preview prompt and validates three provider options",()=>{
 const prepared=buildContinuationContext({recentSentences:["出発。"]}); const calls:unknown[]=[];
 function* provider(_h:any,_r:any,input:any):Generator<any,any,any>{calls.push(input);return {text:JSON.stringify({options:[{direction:"一",rationale:"理由"},{direction:"二",rationale:"理由"},{direction:"三",rationale:"理由"}]}),provenance:{provider:"p",model:"m",promptVersion:"continuation-options.v3",requestId:"r",untrusted:true}};}
 const result=generateContinuation({} as any,{} as any,prepared,provider).next();
 assert.equal(result.done,true);assert.equal((calls[0] as any).prompt,renderContinuationPrompt(prepared.text));
 assert.equal((result.value as any).options.length,3);
});
