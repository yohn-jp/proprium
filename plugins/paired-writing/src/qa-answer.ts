import type { ActionRequest } from "../../../app/src/browser/proprium/authoring/types.js";
import type { GuestHost, HostCall } from "../../shared/guest.js";
import { previewQa } from "./assistance-preview.js";
import { invokeAction, readText } from "./host.js";
import { PairedError } from "./types.js";

interface SearchHit {
  kind: "document" | "term";
  path: string;
  title: string;
  fileRevision: string;
  matchRanges: Array<{ start:number; end:number }>;
}
interface SearchResult { hits:SearchHit[]; indexSnapshot:string; nextCursor:string|null }
interface Citation { kind:"document"; id:string; quote:string; path:string; revision:string }

/** Provider-free QA returns verified excerpts, never an inferred model answer. */
export function* answerQa(input:unknown, host:GuestHost, request:ActionRequest):Generator<HostCall,unknown,unknown> {
  const preview = (yield* previewQa(input, host, request)) as { messages:Array<{role:"user"|"assistant";content:string}> };
  const query = [...preview.messages].reverse().find(message => message.role === "user")?.content.trim();
  if (!query) throw new PairedError("invalid_input", "A nonempty user question is required");
  // Preserve the complete question across the Research API's 512-code-unit limit.
  const segments:string[]=[]; let part="";
  for (const scalar of query) { if (part.length + scalar.length > 512) { segments.push(part); part=""; } part += scalar; }
  if (part) segments.push(part);
  const hits:SearchHit[]=[]; let incomplete=false; let source="research.query";
  try {
    for (const segment of segments) {
      if (!segment.trim()) continue;
      const result = yield* invokeAction<SearchResult>(host,request,"proprium.research","research.query",{query:segment,mode:"lexical",limit:24,includeTerms:false});
      if (!result || result.indexSnapshot !== request.snapshot.id || !Array.isArray(result.hits) || result.hits.length>24) throw new PairedError("snapshot_stale", "Research result is not bound to the current snapshot");
      hits.push(...result.hits); incomplete ||= result.nextCursor !== null;
    }
  } catch(error) {
    // Host continuation errors cross WIT as plain ActionError values, not class instances.
    const code=error && typeof error === "object" && "code" in error ? error.code : undefined;
    if (typeof code !== "string" || !["dependency_unavailable","plugin_unavailable"].includes(code)) throw error;
    source="local.lexical"; incomplete=true; hits.length=0;
    // The local fallback follows the pinned Research search roots and bounded file reads.
    const roots=["manuscript/", "bible/", "plot/", "meta/scratch/"];
    const tokens = [...new Set(query.match(/[\p{L}\p{N}_]+/gu) ?? [])].flatMap(word => {
      if (/^[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+$/u.test(word)) {
        const chars=Array.from(word); return chars.length===1 ? chars : chars.slice(0,-1).map((ch,index)=>ch+chars[index+1]);
      }
      return [word];
    });
    let cursor:string|null=null; let count=0; let bytes=0; let pages=0;
    do {
      if (++pages>64) throw new PairedError("capacity","Local search exceeds its bounded page limit");
      const page: {entries:Array<{path:string;revision:string;byte_length:number}>;next_cursor:string|null} = yield* host.request<{entries:Array<{path:string;revision:string;byte_length:number}>;next_cursor:string|null}>("workspace.file.list",{snapshot:request.snapshot,limit:256,...(cursor ? {cursor} : {})});
      if (!page || !Array.isArray(page.entries) || page.entries.length>256 || (page.next_cursor!==null && typeof page.next_cursor!=="string")) throw new PairedError("invalid_input","Host returned an invalid file page");
      for (const entry of page.entries) {
        const path=entry.path;
        if (typeof path!=="string" || !roots.some(root=>path.toLowerCase().startsWith(root)) || path.split("/").some(x=>x.startsWith(".")) || !/\.(?:md|markdown|txt|ya?ml|json)$/iu.test(path)) continue;
        if (++count>256 || !Number.isSafeInteger(entry.byte_length) || entry.byte_length<0 || (bytes+=entry.byte_length)>8*1024*1024) throw new PairedError("capacity","Local search exceeds its bounded corpus");
        const file=yield* readText(host,request,path);
        if (file.revision!==entry.revision) throw new PairedError("snapshot_stale","Local search source changed");
        const token=tokens.find(value=>value && file.text.includes(value));
        if (token) {const start=file.text.indexOf(token); hits.push({kind:"document",path,title:path,fileRevision:file.revision,matchRanges:[{start,end:start+token.length}]});}
      }
      if (page.next_cursor===cursor && cursor!==null) throw new PairedError("invalid_input","Host file cursor did not advance");
      cursor=page.next_cursor;
    } while(cursor!==null);
  }
  const citations:Citation[]=[];
  const seen=new Set<string>();
  for (const hit of hits) {
    if (!hit || hit.kind !== "document") continue;
    if (typeof hit.path!=="string" || typeof hit.fileRevision!=="string" || !Array.isArray(hit.matchRanges)) throw new PairedError("invalid_input", "Research returned an invalid source hit");
    const span=hit.matchRanges[0];
    if (!span) continue;
    if (!Number.isSafeInteger(span.start) || !Number.isSafeInteger(span.end) || span.start<0 || span.end<=span.start || span.end-span.start>1024) throw new PairedError("invalid_input", "Research returned an invalid match range");
    const file=yield* readText(host,request,hit.path);
    if (file.revision!==hit.fileRevision || span.end>file.text.length) throw new PairedError("snapshot_stale", "Search evidence changed before it could be checked");
    const key=JSON.stringify([hit.path,span.start,span.end]);
    if (seen.has(key)) continue;
    seen.add(key);
    citations.push({kind:"document",id:hit.path,quote:file.text.slice(span.start,span.end),path:hit.path,revision:file.revision});
    if (citations.length === 24) { incomplete ||= hits.length > citations.length; break; }
  }
  return {answer:citations.length ? `関連する記述が見つかりました。解釈は確認してください。\n${citations.map(item=>`「${item.quote}」`).join("\n")}` : "関連する根拠は見つかりませんでした。",
    citations,confidence:"low",snapshot:request.snapshot,provenance:{provider:"local",source,query,segments:segments.length,coverage:incomplete ? "partial" : "complete"}};
}

/** Closed output contract for registration of paired.qa.answer. */
export const QA_ANSWER_OUTPUT_SCHEMA = {
  type:"object",additionalProperties:false,required:["answer","citations","confidence","snapshot","provenance"],properties:{
    answer:{type:"string",maxLength:30000}, confidence:{const:"low"},
    citations:{type:"array",maxItems:24,items:{type:"object",additionalProperties:false,required:["kind","id","quote","path","revision"],properties:{
      kind:{const:"document"},id:{type:"string",maxLength:1024},quote:{type:"string",maxLength:1024},path:{type:"string",maxLength:1024},revision:{type:"string",maxLength:256},
    }}},
    snapshot:{type:"object",additionalProperties:false,required:["id","local_commit","worktree_generation","draft_generation"],properties:{
      id:{type:"string",minLength:1,maxLength:256},local_commit:{type:["string","null"],maxLength:256},worktree_generation:{type:"string",maxLength:256},draft_generation:{type:["string","null"],maxLength:256},remote_commit:{type:["string","null"],maxLength:256},
    }},
    provenance:{type:"object",additionalProperties:false,required:["provider","source","query","segments","coverage"],properties:{
      provider:{const:"local"},source:{enum:["research.query","local.lexical"]},query:{type:"string",maxLength:8000},segments:{type:"integer",minimum:1,maximum:16},coverage:{enum:["partial","complete"]},
    }},
  },
} as const;
