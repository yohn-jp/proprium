import type { ActionRequest } from '../../../app/src/browser/proprium/authoring/types.js';
import type { GuestHost, HostCall } from '../../shared/guest.js';
import { invokeAction, readText } from './host.js';
import { answerQa } from './qa-answer.js';
import { PairedError } from './types.js';
import { exactKeys, finiteInteger, identity, record } from './validation.js';
import type { DialogueGenerate } from './dialogue.js';

type Span = { path: string; revision: string; start: number; end: number; quote: string };
type Entity = { id: string; name: string; type: string; raw: Record<string, unknown>; path: string; revision: string; text: string; sources: Array<{path:string;revision:string}> };
function string(value: unknown, label: string, max: number): string { if (typeof value !== 'string' || !value.trim() || value.length > max) throw new PairedError('invalid_input', `${label} is invalid`); return value; }
function blockPath(value: unknown): string { const path = string(value,'blockPath',128); if (!/^(?:lead\.(?:0|[1-9]\d*)|sections\.(?:0|[1-9]\d*)\.body\.(?:0|[1-9]\d*))$/u.test(path)) throw new PairedError('invalid_input','blockPath is not an accepted note block'); return path; }
function* getEntity(host: GuestHost, request: ActionRequest, id: string): Generator<HostCall,Entity,unknown> {
  const result = yield* invokeAction<{entity: unknown;sourceFiles:unknown}>(host,request,'proprium.knowledge','knowledge.entities.get',{id});
  const row = record(result?.entity,'Knowledge entity'); if (row.id !== id) throw new PairedError('snapshot_stale','Knowledge returned a different entity');
  const path = identity(row.filePath,'entity path',4096), revision = identity(row.fileRevision,'entity revision'), file = yield* readText(host,request,path);
  if (file.revision !== revision) throw new PairedError('snapshot_stale','Knowledge entity source changed');
  if (!Array.isArray(result.sourceFiles) || result.sourceFiles.length < 1 || result.sourceFiles.length > 16) throw new PairedError('unsupported_format','Knowledge source list is malformed');
  const sources: Array<{path:string;revision:string}> = [];
  for (const value of result.sourceFiles) { const source=record(value,'Knowledge source'), sourcePath=identity(source.path,'source path',4096), sourceRevision=identity(source.revision,'source revision'); if(sources.some(existing=>existing.path===sourcePath))throw new PairedError('unsupported_format','Knowledge source list repeats a path');const current=sourcePath===path ? file : yield* readText(host,request,sourcePath);if(current.revision!==sourceRevision)throw new PairedError('snapshot_stale','Knowledge source changed');sources.push({path:sourcePath,revision:sourceRevision}); }
  if (!sources.some(source=>source.path===path && source.revision===revision)) throw new PairedError('snapshot_stale','Knowledge entity source is absent');
  return {id,name:typeof row.name === 'string' ? row.name : id,type:identity(row.type,'entity type'),raw:record(row.raw,'entity source'),path,revision,text:file.text,sources};
}
function notesPlainExcerpt(value: unknown, maxChars = 2000): string {
  const parts: string[] = [];
  const add = (blocks: unknown) => { if (typeof blocks === 'string') { if (blocks.trim()) parts.push(blocks); return; } if (!Array.isArray(blocks)) return; for (const block of blocks) { if (!block || typeof block !== 'object' || Array.isArray(block)) continue; const row=block as Record<string,unknown>; if (row.type === 'paragraph' && typeof row.text === 'string') parts.push(row.text); } };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  const notes=value as Record<string,unknown>;add(notes.lead);
  const visit=(value:unknown):void=>{if(!value || typeof value!=='object' || Array.isArray(value))return;const section=value as Record<string,unknown>;if(typeof section.heading==='string' && section.heading)parts.push(`# ${section.heading}`);add(section.body);if(Array.isArray(section.children))for(const child of section.children)visit(child);};
  if(Array.isArray(notes.sections))for(const section of notes.sections)visit(section);
  const joined=parts.join('\n').trim();return joined.length<=maxChars ? joined : `${joined.slice(0,maxChars)}…`;
}
function uniqueSpan(file: Entity, quote: string): Span | undefined {
  const start = file.text.indexOf(quote); if (start < 0 || file.text.indexOf(quote,start+1) >= 0) return undefined;
  return {path:file.path,revision:file.revision,start,end:start+quote.length,quote};
}
function outputObject(value: string): Record<string, unknown> { try { return record(JSON.parse(value),'provider output'); } catch { throw new PairedError('unsupported_format','Provider output must be a JSON object'); } }
function* prepare(input: unknown, host: GuestHost, request: ActionRequest) {
  const row=record(input,'input'); const source=row.source;
  if (source === 'manuscript') {
    exactKeys(row,['source','entityId','blockPath','prompt'],'input'); const id=identity(row.entityId,'entityId');
    const target=yield* getEntity(host,request,id), block=row.blockPath === undefined ? 'lead.0' : blockPath(row.blockPath);
    const instruction=row.prompt === undefined ? 'なし' : string(row.prompt,'prompt',4000);
    const search=(yield* answerQa({question:target.name},host,request)) as {citations:Array<{path:string;revision:string;quote:string}>;provenance:{source:string;coverage:string}};
    const evidence:Span[]=[];
    for (const hit of search.citations) { if (!hit.path.startsWith('manuscript/')) continue; const file=yield* readText(host,request,hit.path); if (file.revision!==hit.revision) throw new PairedError('snapshot_stale','Manuscript search evidence changed'); const match=file.text.indexOf(hit.quote); if(match < 0 || file.text.indexOf(hit.quote,match+1)>=0) continue; const start=Math.max(file.text.lastIndexOf('\n',match-1)+1,match-500), next=file.text.indexOf('\n',match+hit.quote.length), end=Math.min(next<0 ? file.text.length : next,match+hit.quote.length+500); const quote=file.text.slice(start,end); if(!quote || quote.length>1024)continue; evidence.push({path:hit.path,revision:file.revision,start,end,quote}); if(evidence.length===8)break; }
    if (!evidence.length) throw new PairedError('file_not_found','No exact manuscript references were found');
    const prompt=['あなたは小説の図鑑ノート編集アシスタントです。新しい言及から現行ノートへの差分追記案を1件だけ作ってください。','図鑑は直接書き換えず、どの節にどの一文を足すかだけ提案します。proposedText は evidence.quote 内の実在表現だけで構成し、入力に無い設定を作らないでください。',`entityId: ${target.id}`,`entityName: ${target.name}`,`推奨 blockPath: ${block}`,`追加指示: ${instruction}`,`現行ノート:\n${JSON.stringify(target.raw.notes ?? '').slice(0,4000)}`,`新規言及:\n${evidence.map(e=>`${e.path}: ${e.quote}`).join('\n')}`,'blockPath は lead.<i> または sections.<si>.body.<bi> 形式。','JSONのみ: {"blockPath":"lead.0","proposedText":"...","evidence":[{"quote":"exact source quote"}]}'].join('\n\n');
    return {source,entityId:id,targetRevision:target.revision,blockPath:block,prompt,promptVersion:'zukan-manuscript@3',evidence,sourceRevisions:[...target.sources,...evidence.map(({path,revision})=>({path,revision}))],coverage:'partial' as const,provider_invoked:false,snapshot:request.snapshot};
  }
  if (source !== 'sandbox') throw new PairedError('invalid_input','source must be manuscript or sandbox');
  exactKeys(row,['source','sourceSessionId','turnRange'],'input'); const id=identity(row.sourceSessionId,'sourceSessionId'), sketch=yield* getEntity(host,request,id);
  if(sketch.type!=='dialogue_sketch') throw new PairedError('invalid_input','Sandbox source is not a dialogue sketch');
  const rawLines=sketch.raw.lines; if(!Array.isArray(rawLines)) throw new PairedError('unsupported_format','Sketch lines are missing');
  const range=row.turnRange === undefined ? {start:0,end:rawLines.length-1} : (()=>{const r=record(row.turnRange,'turnRange');exactKeys(r,['start','end'],'turnRange');return {start:finiteInteger(r.start,'start',0),end:finiteInteger(r.end,'end',0)};})();
  if(rawLines.length===0 || range.end<range.start || range.end>=rawLines.length) throw new PairedError('invalid_input','Turn range is outside the saved sketch');
  if(range.end-range.start+1>80) throw new PairedError('capacity','Select at most 80 sketch turns');
  const participants=Array.isArray(sketch.raw.participantEntityIds) ? sketch.raw.participantEntityIds.map(x=>identity(x,'participant')) : [];
  if(!participants.length || new Set(participants).size!==participants.length || participants.length>8) throw new PairedError('unsupported_format','Sketch participants are invalid');
  const lines=rawLines.slice(range.start,range.end+1).map(value=>{const line=record(value,'sketch line'); const speaker=identity(line.speakerEntityId,'speakerEntityId'); if(!participants.includes(speaker)) throw new PairedError('unsupported_format','Sketch line has a nonparticipant speaker');return {speakerEntityId:speaker,text:string(line.text,'line text',8000)};});
  const profiles:Entity[]=[]; for(const participant of participants){const entity=yield* getEntity(host,request,participant);if(entity.type!=='character')throw new PairedError('unsupported_format','Sketch participant is not a character');profiles.push(entity);}
  const transcript=lines.map((line,index)=>`[${range.start+index}] ${profiles.find(p=>p.id===line.speakerEntityId)?.name ?? line.speakerEntityId}: ${line.text}`).join('\n');
  const evidence=lines.flatMap(line=>{const span=uniqueSpan(sketch,line.text);return span?[span]:[];});
  const prompt=['あなたは小説の図鑑ノート編集アシスタントです。','セリフ問答の対話ログから、図鑑へ追記すべき事実・関係性・言語習慣を抽出してください。','各提案は kind: fact|dynamic|habit、targetEntityId、blockPath、proposedText、evidenceQuote、confidence。','evidenceQuote は対話ログに実在する文言のみ。無い設定を作らない。','図鑑を直接書き換えない。差分提案だけ。',`sketchId (sourceSessionId): ${id}`,`turnRange: ${range.start}-${range.end}`,'参加キャラと現行ノート:',profiles.map(p=>`--- ${p.name} (${p.id}) ---\n現行ノート:\n${notesPlainExcerpt(p.raw.notes) || '(空)'}`).join('\n\n'),'対話ログ:',transcript,'blockPath は lead.<i> または sections.<si>.body.<bi>。','', '=== 出力形式（厳守） ===', '応答は有効なJSONオブジェクト1個のみ（json_object モード）。', 'Markdown・コードフェンス（```）・説明文・前置き・後書きは禁止。', '挨拶・解説・「以下が結果」・思考過程など JSON 以外の文字は禁止。', '応答は `{` で始まり `}` で終わる単一 JSON オブジェクトのみ。', 'キー名・型・配列長は下記スキーマどおり厳守。', '存在しないキーを追加しない。必須キーを省略しない。', 'トップレベルキー "suggestions" のみ。', 'suggestions: オブジェクト配列（0件以上）。', '各要素: kind ("fact"|"dynamic"|"habit"), targetEntityId, blockPath, proposedText, evidenceQuote, confidence ("high"|"low").', 'evidenceQuote は対話ログに実在する文言のみ。無い設定を作らない。', '出力例（この形に合わせる）:', '{"suggestions":[{"kind":"fact","targetEntityId":"char-yuki","blockPath":"lead.0","proposedText":"雨の日は傘を忘れがち。","evidenceQuote":"また傘忘れたの？","confidence":"high"}]}'].join('\n');
  return {source,sourceSessionId:id,turnRange:range,participants,participantRevisions:Object.fromEntries(profiles.map(p=>[p.id,p.revision])),prompt,promptVersion:'zukan-sandbox@3',evidence,sourceRevisions:[sketch,...profiles].flatMap(p=>p.sources),coverage:evidence.length===lines.length ? 'complete' : 'partial',provider_invoked:false,snapshot:request.snapshot};
}
export function* previewZukan(input: unknown,host:GuestHost,request:ActionRequest) { const value=yield* prepare(input,host,request);if(new TextEncoder().encode(JSON.stringify(value)).length>768*1024)throw new PairedError('capacity','Zukan preview exceeds output limit');return value; }
export function* suggestZukan(input: unknown,host:GuestHost,request:ActionRequest,generate:DialogueGenerate) {
  const prepared=yield* previewZukan(input,host,request); const generated=yield* generate(host,request,{feature:'zukan-proposal',prompt:prepared.prompt,promptVersion:prepared.promptVersion,maxOutputTokens:1024,sourceManifest:prepared.sourceRevisions}); const parsed=outputObject(generated.text); const diagnostics:string[]=[];
  if(prepared.source==='manuscript') { exactKeys(parsed,['blockPath','proposedText','evidence'],'provider output'); const path=blockPath(parsed.blockPath);if(path!==prepared.blockPath)throw new PairedError('unsupported_format','Provider changed the requested block path');const proposedText=string(parsed.proposedText,'proposedText',4000);if(!Array.isArray(parsed.evidence)||!parsed.evidence.length)throw new PairedError('unsupported_format','Provider evidence is missing');const quotes=parsed.evidence.map(v=>string(record(v,'evidence').quote,'quote',1024));const evidence=prepared.evidence.filter(e=>quotes.includes(e.quote)&&e.quote.includes(proposedText));if(!evidence.length)throw new PairedError('unsupported_format','Provider suggestion is not grounded in exact source evidence');return {...prepared,provider_invoked:true,suggestion:{targetEntityId:prepared.entityId,targetEntityRevision:prepared.targetRevision,kind:'fact',blockPath:path,proposedText,evidence,confidence:'low'},model:generated.provenance.model,provider:generated.provenance.provider,provenance:generated.provenance,diagnostics}; }
  exactKeys(parsed,['suggestions'],'provider output');if(!Array.isArray(parsed.suggestions))throw new PairedError('unsupported_format','Provider suggestions must be a list');if(parsed.suggestions.length>32)throw new PairedError('capacity','Provider returned more than 32 sandbox suggestions');
  const suggestions=[]; for(const value of parsed.suggestions){const item=record(value,'suggestion');exactKeys(item,['kind','targetEntityId','blockPath','proposedText','evidenceQuote','confidence'],'suggestion');const target=identity(item.targetEntityId,'targetEntityId'),kind=String(item.kind),confidence=String(item.confidence),proposedText=string(item.proposedText,'proposedText',4000),quote=string(item.evidenceQuote,'evidenceQuote',1024),path=blockPath(item.blockPath);if(!prepared.participants?.includes(target)||!['fact','dynamic','habit'].includes(kind)||!['high','low'].includes(confidence))throw new PairedError('unsupported_format','Provider returned invalid suggestion metadata');const evidence=prepared.evidence.filter(e=>e.quote.includes(quote)&&quote.includes(proposedText)).map(e=>{const start=e.start+e.quote.indexOf(quote);return {...e,start,end:start+quote.length,quote};});if(!evidence.length){diagnostics.push('ungrounded suggestion omitted');continue;}suggestions.push({suggestion:{targetEntityId:target,targetEntityRevision:prepared.participantRevisions?.[target],kind,blockPath:path,proposedText,evidence,confidence}});}
  return {...prepared,provider_invoked:true,suggestions,diagnostics,model:generated.provenance.model,provider:generated.provenance.provider,provenance:generated.provenance};
}
