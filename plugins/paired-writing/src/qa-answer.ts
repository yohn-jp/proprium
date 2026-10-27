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
  if (query.length > 512) throw new PairedError("capacity", "The question exceeds the bounded Research search query");
  const result = yield* invokeAction<SearchResult>(host,request,"proprium.research","research.query",{query,mode:"lexical",limit:24,includeTerms:false});
  if (!result || result.indexSnapshot !== request.snapshot.id || !Array.isArray(result.hits) || result.hits.length>24) throw new PairedError("snapshot_stale", "Research result is not bound to the current snapshot");
  const citations:Citation[]=[];
  for (const hit of result.hits) {
    if (!hit || hit.kind !== "document") continue;
    if (typeof hit.path!=="string" || typeof hit.fileRevision!=="string" || !Array.isArray(hit.matchRanges)) throw new PairedError("invalid_input", "Research returned an invalid source hit");
    const span=hit.matchRanges[0];
    if (!span) continue;
    if (!Number.isSafeInteger(span.start) || !Number.isSafeInteger(span.end) || span.start<0 || span.end<=span.start || span.end-span.start>1024) throw new PairedError("invalid_input", "Research returned an invalid match range");
    const file=yield* readText(host,request,hit.path);
    if (file.revision!==hit.fileRevision || span.end>file.text.length) throw new PairedError("snapshot_stale", "Search evidence changed before it could be checked");
    citations.push({kind:"document",id:hit.path,quote:file.text.slice(span.start,span.end),path:hit.path,revision:file.revision});
  }
  return {answer:citations.length ? `関連する記述が見つかりました。解釈は確認してください。\n${citations.map(item=>`「${item.quote}」`).join("\n")}` : "関連する根拠は見つかりませんでした。",
    citations,confidence:"low",snapshot:request.snapshot,provenance:{provider:"local",source:"research.query",query,coverage:result.nextCursor ? "partial" : "complete"}};
}
