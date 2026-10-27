import type { ActionRequest } from "../../../app/src/browser/proprium/authoring/types.js";
import type { GuestHost, HostCall } from "../../shared/guest.js";
import type { ProviderGenerator } from "./continuation.js";
import { PairedError } from "./types.js";
import { invokeAction, readText } from "./host.js";
import { exactKeys, identity, record } from "./validation.js";
import { parse } from "yaml";
import { sha256 } from "./sha256.js";

export interface ReaderSummary {chapterId:string;summaryLines:readonly string[];path:string;revision:string;source_files:readonly {path:string;revision:string}[]}
const COMMON="あなたは小説執筆支援アシスタントです。\n主張には根拠の引用を付けてください。引用できない内容は断言しないでください。\n出力は日本語で行ってください。";
/** Port of the pinned first-read-reaction-v3 template; callers supply verified accepted summaries. */
export function renderReaderReactionPrompt(chapterId:string,summaries:readonly Pick<ReaderSummary,"chapterId"|"summaryLines">[]):string {
 const blocks=summaries.map(item=>`chapter_id: ${item.chapterId}\n${item.summaryLines.map(line=>`- ${line}`).join("\n")}`).join("\n\n")||"(要約なし)";
 return `${COMMON}\n\nあなたは初読の読者です。以下はこれまでに読んだ章の要約だけです。\n後続の章の知識は持っていません。\nいま読んだ章: ${chapterId}\n累積要約:\n${blocks}\n初読の読者が抱く疑問・期待・混乱を挙げてください。\n\nJSONのみを返してください。スキーマ: {"questions":["..."],"expectations":["..."],"confusions":["..."]}`;
}
/** This internal adapter requires callers to verify summary freshness before invocation. */
export function* generateReaderReaction(host:GuestHost,request:ActionRequest,chapterId:string,summaries:readonly ReaderSummary[],generateProvider:ProviderGenerator):Generator<HostCall,unknown,unknown> {
 if(!chapterId||chapterId.length>256||summaries.length>256)throw new PairedError("invalid_input","Reader reaction context is invalid");
 const prompt=renderReaderReactionPrompt(chapterId,summaries);
 if(new TextEncoder().encode(prompt).byteLength>512*1024)throw new PairedError("capacity","Reader reaction context is too large");
 const response=yield* generateProvider(host,request,{feature:"first-read-reaction",prompt,promptVersion:"first-read-reaction-v3",maxOutputTokens:1024,sourceManifest:summaries.map(({chapterId,path,revision,source_files})=>({chapterId,path,revision,source_files}))});
 let raw:unknown;try{raw=JSON.parse(response.text);}catch{throw new PairedError("invalid_input","Reader reaction provider returned invalid JSON");}
 if(!raw||typeof raw!=="object"||Array.isArray(raw)||Object.keys(raw).some(key=>!["questions","expectations","confusions"].includes(key)))throw new PairedError("invalid_input","Reader reaction provider response is invalid");
 const value=raw as Record<string,unknown>;
 for(const key of ["questions","expectations","confusions"]) if(!Array.isArray(value[key])||(value[key] as unknown[]).length>32||(value[key] as unknown[]).some(item=>typeof item!=="string"||item.length>4000))throw new PairedError("invalid_input",`Reader reaction ${key} is invalid`);
 return {...value,sources:summaries.map(({chapterId,path,revision,source_files})=>({chapterId,path,revision,source_files})),provenance:response.provenance};
}

interface TreeItem {id:string;kind:string;metadata_path:string;metadata_revision?:string;manuscript_path?:string}
interface TreePage {items:TreeItem[];next_cursor:string|null;tree_revision:string}
interface FileItem {path:string;revision:string}
interface ChildSource {id:string;metadata_path:string;metadata_revision:string;manuscript_path:string;manuscript_revision:string}

/** Use only Narrative hierarchy and Host file metadata; never read manuscripts for reaction. */
export function* prepareReaderReaction(input:unknown,host:GuestHost,request:ActionRequest):Generator<HostCall,unknown,unknown> {
 const value=record(input,"input");exactKeys(value,["chapterId"],"input");const target=identity(value.chapterId,"chapterId");
 let treeRevision:string|undefined;
 function* children(parent:string|null):Generator<HostCall,TreeItem[],unknown>{
  let cursor:string|null=null;const rows:TreeItem[]=[];let pages=0;
  do {
   if(++pages>64)throw new PairedError("capacity","Narrative hierarchy has too many pages");
   const page:TreePage=yield* invokeAction<TreePage>(host,request,"proprium.narrative","proprium.narrative.hierarchy.tree",{...(parent ? {parent_id:parent}:{}),limit:200,...(cursor?{cursor}:{}),...(treeRevision?{expected_tree_revision:treeRevision}:{})});
   if(!page||!Array.isArray(page.items)||typeof page.tree_revision!=="string"||(treeRevision&&treeRevision!==page.tree_revision))throw new PairedError("snapshot_stale","Narrative hierarchy changed");
   treeRevision=page.tree_revision;rows.push(...page.items);if(rows.length>10000)throw new PairedError("capacity","Narrative hierarchy is too large");
   if(page.next_cursor===cursor&&cursor!==null)throw new PairedError("invalid_input","Narrative cursor did not advance");cursor=page.next_cursor;
  }while(cursor!==null);
  return rows;
 }
 const volumes=yield* children(null);const chapters:TreeItem[]=[];
 for(const volume of volumes){if(volume.kind!=="volume")continue;const list=yield* children(identity(volume.id,"volume id"));chapters.push(...list.filter(item=>item.kind==="chapter"));}
 const targetIndex=chapters.findIndex(item=>item.id===target);if(targetIndex<0)throw new PairedError("invalid_input","The requested chapter is not present in the pinned work");
 const files=new Map<string,string>();let cursor:string|null=null,pages=0;
 do {
  if(++pages>64)throw new PairedError("capacity","Workspace file metadata has too many pages");
  const page:{entries:FileItem[];next_cursor:string|null}=yield* host.request("workspace.file.list",{snapshot:request.snapshot,limit:256,...(cursor?{cursor}:{})});
  if(!page||!Array.isArray(page.entries)||page.entries.length>256||(page.next_cursor!==null&&typeof page.next_cursor!=="string"))throw new PairedError("invalid_input","Workspace file metadata is malformed");
  for(const entry of page.entries){if(typeof entry.path!=="string"||typeof entry.revision!=="string"||files.has(entry.path))throw new PairedError("invalid_input","Workspace file metadata is malformed");files.set(entry.path,entry.revision);if(files.size>10000)throw new PairedError("capacity","Workspace has too many files");}
  if(page.next_cursor===cursor&&cursor!==null)throw new PairedError("invalid_input","Workspace cursor did not advance");cursor=page.next_cursor;
 }while(cursor!==null);
 const summaries:ReaderSummary[]=[];const diagnostics:Array<{chapterId:string;code:string}>=[];
 for(const chapter of chapters.slice(0,targetIndex+1)){
  if(typeof chapter.metadata_path!=="string"||!/\/chapter\.ya?ml$/iu.test(chapter.metadata_path))throw new PairedError("invalid_input","Narrative chapter metadata path is invalid");
  const path=chapter.metadata_path.replace(/\/chapter\.ya?ml$/iu,"/chapter-summary.yaml");const revision=files.get(path);if(!revision){diagnostics.push({chapterId:chapter.id,code:"summary_missing"});continue;}
  const file=yield* readText(host,request,path);if(file.revision!==revision)throw new PairedError("snapshot_stale","Chapter summary changed while reading");
  let raw:unknown;try{raw=parse(file.text);}catch{diagnostics.push({chapterId:chapter.id,code:"summary_invalid"});continue;}
  if(!raw||typeof raw!=="object"||Array.isArray(raw)){diagnostics.push({chapterId:chapter.id,code:"summary_invalid"});continue;}
  const data=raw as Record<string,unknown>;
  if(data.id!==chapter.id||!Array.isArray(data.summaryLines)||!data.summaryLines.length||data.summaryLines.length>12||data.summaryLines.some(line=>typeof line!=="string"||line.length>4000)){diagnostics.push({chapterId:chapter.id,code:"summary_invalid"});continue;}
  if(!Array.isArray(data.children)||!Array.isArray(data.source_files)){diagnostics.push({chapterId:chapter.id,code:"summary_unverified"});continue;}
  const current=(yield* children(chapter.id)).filter(item=>item.kind==="scene");const listed=data.children as ChildSource[];
  const valid=listed.length===current.length && listed.every((child,index)=>{const scene=current[index];return child&&scene&&child.id===scene.id&&child.metadata_path===scene.metadata_path&&child.metadata_revision===scene.metadata_revision&&child.manuscript_path===scene.manuscript_path&&files.get(child.metadata_path)===child.metadata_revision&&files.get(child.manuscript_path)===child.manuscript_revision;});
  if(!valid){diagnostics.push({chapterId:chapter.id,code:"summary_stale"});continue;}
  const expected=listed.flatMap(child=>[{path:child.metadata_path,revision:child.metadata_revision},{path:child.manuscript_path,revision:child.manuscript_revision}]);
  const sourceFiles=data.source_files as unknown[];
  const sourcesValid=sourceFiles.length===expected.length && sourceFiles.every((item,index)=>{
   if(!item||typeof item!=="object"||Array.isArray(item))return false;
   const row=item as Record<string,unknown>, wanted=expected[index]!;
   return Object.keys(row).length===2 && row.path===wanted.path && row.revision===wanted.revision;
  });
  const hash=sha256(new TextEncoder().encode(JSON.stringify(listed.map(child=>[child.id,child.manuscript_revision]))));
  if(!sourcesValid || data.sourceHash!==hash){diagnostics.push({chapterId:chapter.id,code:"summary_stale"});continue;}
  summaries.push({chapterId:chapter.id,summaryLines:data.summaryLines as string[],path,revision,source_files:expected});
 }
 const prompt=renderReaderReactionPrompt(target,summaries);if(new TextEncoder().encode(prompt).byteLength>512*1024)throw new PairedError("capacity","Reader reaction context is too large");
 return {prompt,promptVersion:"first-read-reaction-v3",provider_invoked:false,snapshot:request.snapshot,summaries,diagnostics};
}

/** Public preview and suggest resolve trusted workspace context themselves. */
export const previewReaderReaction=prepareReaderReaction;
export function* suggestReaderReaction(input:unknown,host:GuestHost,request:ActionRequest,provider:ProviderGenerator):Generator<HostCall,unknown,unknown>{
 const prepared=(yield* prepareReaderReaction(input,host,request)) as {summaries:ReaderSummary[];diagnostics:unknown[]};
 const target=identity(record(input,"input").chapterId,"chapterId");
 const value=(yield* generateReaderReaction(host,request,target,prepared.summaries,provider)) as Record<string,unknown>;
 return {...value,snapshot:request.snapshot,diagnostics:prepared.diagnostics};
}
