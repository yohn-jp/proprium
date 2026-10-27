import type { ActionRequest } from '../../../app/src/browser/proprium/authoring/types.js';
import type { GuestHost, HostCall } from '../../shared/guest.js';
import { invokeAction, readText } from './host.js';
import { PairedError } from './types.js';
import { answerQa } from './qa-answer.js';

type Aspect = 'tempo' | 'pov-shift' | 'over-explain';
export interface AspectRequest { chapterId: string; aspects?: Aspect[]; cursor?: string; limit?: number }
export interface SpeakerRequest { scene_id: string; text?: string; draft_generation?: string }
/** Keep analysis with Diagnostics; Host dispatch enforces the same snapshot and owner permissions. */
export function* delegateAspect(host: GuestHost, request: ActionRequest, input: AspectRequest, preview = false): Generator<HostCall, unknown, unknown> {
  return yield* invokeAction(host, request, 'proprium.diagnostics', preview ? 'proprium.diagnostics.chapter.aspects.preview.v1' : 'proprium.diagnostics.chapter.aspects.review.v1', { ...input });
}
/** Speaker owns attribution; text, when present, must carry its Host-issued draft generation. */
export function* delegateSpeaker(host: GuestHost, request: ActionRequest, input: SpeakerRequest): Generator<HostCall, unknown, unknown> {
  if (typeof input.scene_id !== 'string' || !input.scene_id || (input.text !== undefined && (typeof input.text !== 'string' || !input.draft_generation || input.draft_generation !== request.snapshot.draft_generation))) {
    throw new PairedError('invalid_input', 'Speaker draft requires the current Host draft generation');
  }
  return yield* invokeAction(host, request, 'proprium.speaker', 'speaker.attribute', { ...input });
}
interface Evidence { path:string; revision:string; start:number; end:number; quote:string; sceneId:string; sentenceIndex:number }
interface Candidate { id:string; evidenceA:Evidence; evidenceB:Evidence }
interface CandidatePage { candidates:Candidate[]; nextCursor:string|null; complete:boolean }
/** A Semantic candidate is only a hypothesis; current source bytes must confirm each quote. */
export function* gatherContradictionEvidence(host: GuestHost, request: ActionRequest, candidateId:string): Generator<HostCall, { candidate:Candidate | null; citations:Evidence[]; diagnostic?:string }, unknown> {
  if (typeof candidateId !== 'string' || !candidateId || candidateId.length > 256) throw new PairedError('invalid_input', 'Candidate ID is invalid');
  let cursor:string | null = null; let candidate:Candidate | undefined; const cursors = new Set<string>();
  for (let page=0; page<100; page++) {
    const value:CandidatePage = yield* invokeAction<CandidatePage>(host, request, 'proprium.semantic', 'proprium.semantic.contradictions.candidates', { limit:100, ...(cursor ? {cursor} : {}) });
    if (!value || !Array.isArray(value.candidates) || value.candidates.length > 100 || typeof value.complete !== 'boolean' || !(value.nextCursor === null || typeof value.nextCursor === 'string')) throw new PairedError('invalid_input','Semantic returned an invalid candidate page');
    candidate = value.candidates.find(item => item.id === candidateId);
    if (candidate) break;
    if (value.nextCursor === null) { if (!value.complete) throw new PairedError('dependency_unavailable','Semantic candidate results are incomplete'); return {candidate:null,citations:[],diagnostic:'candidate_not_found'}; }
    if (cursors.has(value.nextCursor)) throw new PairedError('invalid_input','Semantic candidate cursor did not advance');
    cursors.add(value.nextCursor); cursor=value.nextCursor;
    if (page === 99) throw new PairedError('capacity','Semantic candidate page limit exceeded');
  }
  if (!candidate) return {candidate:null,citations:[],diagnostic:'candidate_not_found'};
  const citations:Evidence[]=[];
  for (const evidence of [candidate.evidenceA,candidate.evidenceB]) {
    if (!evidence || typeof evidence.path !== 'string' || !evidence.path || typeof evidence.revision !== 'string' || !evidence.revision || typeof evidence.quote !== 'string' || !evidence.quote || evidence.quote.length > 8000 || !Number.isSafeInteger(evidence.start) || !Number.isSafeInteger(evidence.end) || evidence.start < 0 || evidence.end < evidence.start || typeof evidence.sceneId !== 'string' || !Number.isSafeInteger(evidence.sentenceIndex)) throw new PairedError('invalid_input','Semantic evidence is malformed');
    const file = yield* readText(host,request,evidence.path);
    if (file.revision !== evidence.revision || file.text.slice(evidence.start,evidence.end) !== evidence.quote) throw new PairedError('snapshot_stale','Semantic evidence no longer matches the pinned source');
    citations.push({ path:evidence.path,revision:evidence.revision,start:evidence.start,end:evidence.end,quote:evidence.quote,sceneId:evidence.sceneId,sentenceIndex:evidence.sentenceIndex });
  }
  return {candidate,citations};
}

/** Bounded lexical evidence for free-text review; no contradiction is asserted. */
export function* gatherTextEvidence(host: GuestHost, request: ActionRequest, candidateText: string): Generator<HostCall, { citations: Array<{kind:string;id:string;quote:string;path:string;revision:string}>; provenance: unknown }, unknown> {
  if (typeof candidateText !== 'string' || !candidateText.trim() || candidateText.length > 8000) throw new PairedError('invalid_input', 'Candidate text is invalid');
  const result = (yield* answerQa({ question: candidateText }, host, request)) as {citations:Array<{kind:string;id:string;quote:string;path:string;revision:string}>;provenance:unknown};
  return {citations:result.citations.slice(0,2),provenance:result.provenance};
}

export interface VerifiedContradictionCitation { path:string; revision:string; quote:string; [key:string]:unknown }
export type ContradictionProvider = (host:GuestHost, request:ActionRequest, options:{feature:string;prompt:string;promptVersion:string;maxOutputTokens:number;sourceManifest?:unknown}) => Generator<HostCall,{text:string;provenance:unknown},unknown>;
/** Only verified citations may support a model judgement; a missing source never triggers generation. */
export function* judgeContradiction(
  host:GuestHost, request:ActionRequest, candidate:{candidateId?:string;candidateText?:string;candidateContext?:string},
  citations:readonly VerifiedContradictionCitation[], evidenceProvenance:unknown, generate:ContradictionProvider,
): Generator<HostCall, {verdict:'contradiction'|'compatible'|'insufficient';reason:string;quotes:string[];citations:VerifiedContradictionCitation[];provenance:unknown;diagnostic?:string}, unknown> {
  const id=candidate.candidateId, text=candidate.candidateText;
  if ((typeof id==='string') === (typeof text==='string') || (id !== undefined && (!id || id.length>256)) || (text !== undefined && (!text.trim() || text.length>8000)) || (candidate.candidateContext !== undefined && (typeof candidate.candidateContext !== 'string' || candidate.candidateContext.length>8000))) throw new PairedError('invalid_input','Exactly one contradiction candidate is required');
  if (citations.length>2 || citations.some(item=>!item || typeof item.path!=='string' || !item.path || typeof item.revision!=='string' || !item.revision || typeof item.quote!=='string' || !item.quote || item.quote.length>8000)) throw new PairedError('invalid_input','Verified contradiction citations are invalid');
  if (!citations.length) return {verdict:'insufficient',reason:'根拠が見つかりませんでした。',quotes:[],citations:[],provenance:{source:evidenceProvenance,provider:null},diagnostic:'no_verified_evidence'};
  const prompt = `次の候補と引用を比較し、JSONのみを返してください。verdictはcontradiction、compatible、insufficientのいずれか、reasonは短い説明、quotesは引用から完全一致で選ぶ配列（最大2件）です。引用の外の事実を断定しないでください。\n候補: ${JSON.stringify(candidate)}\n検証済み引用: ${JSON.stringify(citations.map(item=>item.quote))}`;
  const generated = yield* generate(host,request,{feature:'contradiction-check',prompt,promptVersion:'contradiction-check.v1',maxOutputTokens:1024,sourceManifest:citations.map(item=>({path:item.path,revision:item.revision}))});
  let parsed:unknown; try { parsed=JSON.parse(generated.text); } catch { throw new PairedError('invalid_input','Provider contradiction response is not JSON'); }
  if (!parsed || typeof parsed!=='object' || Array.isArray(parsed)) throw new PairedError('invalid_input','Provider contradiction response is malformed');
  const row=parsed as Record<string,unknown>;
  if (Object.keys(row).some(key=>!['verdict','reason','quotes'].includes(key)) || !['contradiction','compatible','insufficient'].includes(String(row.verdict)) || typeof row.reason!=='string' || !row.reason.trim() || row.reason.length>2000 || !Array.isArray(row.quotes) || row.quotes.length>2 || row.quotes.some(q=>typeof q!=='string' || !citations.some(item=>item.quote===q))) throw new PairedError('invalid_input','Provider contradiction response contains invalid verdict or quote');
  const quotes=row.quotes as string[];
  if (new Set(quotes).size!==quotes.length || (row.verdict!=='insufficient' && !quotes.length)) throw new PairedError('invalid_input','Provider verdict requires unique verified quotes');
  const selected=quotes.map(quote=>citations.find(item=>item.quote===quote)!);
  return {verdict:row.verdict as 'contradiction'|'compatible'|'insufficient',reason:row.reason,quotes,citations:selected,provenance:{source:evidenceProvenance,provider:generated.provenance}};
}
