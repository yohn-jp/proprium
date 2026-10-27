import type { ActionRequest } from '../../../app/src/browser/proprium/authoring/types.js';
import type { GuestHost, HostCall } from '../../shared/guest.js';
import { invokeAction, readText } from './host.js';
import { PairedError } from './types.js';

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
