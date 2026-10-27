import type { ActionRequest } from '../../../app/src/browser/proprium/authoring/types.js';
import type { GuestHost, HostCall } from '../../shared/guest.js';
import { invokeAction, readText } from './host.js';
import { PairedError } from './types.js';
import { exactKeys, identity, record, finiteInteger } from './validation.js';
import { buildDialogueSketchSpeakerContext } from '../../../modules/assistant/src/dialogue-context.js';


const COMMON = "あなたは小説執筆支援アシスタントです。\n主張には根拠の引用を付けてください。引用できない内容は断言しないでください。\n出力は日本語で行ってください。";
const SINGLE = "あなたは小説のキャラクター対話シミュレーターです。\n次の話者として、セリフをちょうど1つだけ生成してください。\n地の文・ト書き・説明は禁止。話者は口調・声紋を厳守すること。\n\n## 話者\n{{speakerName}}\n\n## 口調・声紋（厳守）\n{{voiceBlock}}{{fingerprintBlock}}\n\n## 図鑑ノート\n{{notesExcerpt}}{{blankHeadingsBlock}}\n\n## 本編の確定帰属セリフ例\n{{exampleDialogues}}\n\n## 会話\n相手: {{otherParticipants}}\nお題: {{topic}}\n場面設定: {{situation}}\nこれまでのセリフ:\n{{precedingLines}}\n\n## 出力\ntext にセリフ本文のみ。鉤括弧・話者名ラベル・地の文を付けない。話者は {{speakerName}}。";
const MULTI = "あなたは小説のキャラクター対話シミュレーターです。\n以下の参加者だけで、自然に噛み合う対話をちょうど {{lineCount}} 行、まとめて生成してください。\n地の文・ト書き・説明は禁止。各話者は口調・声紋を厳守すること。\n話者は毎行、参加者の中から適切な人物を選んで交互・自然に割り振ること（不自然な連続発話は避ける）。\n\n## 参加者\n{{speakerRoster}}\n\n## 会話\nお題: {{topic}}\n場面設定: {{situation}}\nこれまでのセリフ:\n{{precedingLines}}\n\n## 出力\nlines にちょうど {{lineCount}} 件。各要素は speakerEntityId（参加者idそのまま）と text（セリフ本文のみ）。\n鉤括弧・話者名ラベル・地の文を付けない。";
function render(template: string, values: Record<string,string>): string { return template.replace(/\{\{(\w+)\}\}/gu, (_match,key: string) => values[key] ?? ""); }
type Generated = { text: string; provenance: { provider: string; model: string; promptVersion: string; requestId: string; untrusted: true } };
export type DialogueGenerate = (host: GuestHost, request: ActionRequest, input: { feature: string; prompt: string; promptVersion: string; maxOutputTokens: number; sourceManifest?: unknown }) => Generator<HostCall, Generated, unknown>;
type Source = { path: string; revision: string; quote: string };
type Profile = { id: string; name: string; raw: Record<string, unknown>; source?: Source };
const optional = (error: unknown) => !!error && typeof error === 'object' && 'code' in error && ['dependency_unavailable','plugin_unavailable'].includes(String(error.code));
function text(value: unknown, label: string, max: number): string { if (typeof value !== 'string' || !value.trim() || value.length > max) throw new PairedError('invalid_input', `${label} must be nonempty and at most ${max} characters`); return value; }
function ids(value: unknown, minimum: number): string[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > 8) throw new PairedError('invalid_input', `participantEntityIds must contain ${minimum}–8 IDs`);
  const result = value.map((id) => identity(id, 'participantEntityId'));
  if (new Set(result).size !== result.length) throw new PairedError('invalid_input', 'participant IDs must be distinct');
  return result;
}
function* entity(host: GuestHost, request: ActionRequest, id: string, expected: string): Generator<HostCall, Profile, unknown> {
  const result = yield* invokeAction<{ entity: unknown }>(host, request, 'proprium.knowledge', 'knowledge.entities.get', { id });
  const row = record(result?.entity, 'Knowledge entity');
  if (row.id !== id || row.type !== expected) throw new PairedError('invalid_input', `Entity ${id} is not a ${expected}`);
  const path = identity(row.filePath, 'entity file path', 4096), revision = identity(row.fileRevision, 'entity revision');
  const file = yield* readText(host, request, path);
  if (file.revision !== revision) throw new PairedError('snapshot_stale', 'Knowledge entity revision changed');
  return { id, name: typeof row.name === 'string' ? row.name : id, raw: record(row.raw, 'entity source'), source: { path, revision, quote: file.text.slice(0, 300) } };
}
function* profiles(host: GuestHost, request: ActionRequest, participantIds: string[]): Generator<HostCall, { profiles: Profile[]; unavailable: boolean }, unknown> {
  const profiles: Profile[] = [];
  for (const id of participantIds) {
    try { profiles.push(yield* entity(host, request, id, 'character')); }
    catch (error) { if (!optional(error)) throw error; return { profiles: participantIds.map(id => ({ id, name: id, raw: {} })), unavailable: true }; }
  }
  return { profiles, unavailable: false };
}
function bounded(result: unknown): void { if (new TextEncoder().encode(JSON.stringify(result)).length > 768 * 1024) throw new PairedError('capacity', 'Dialogue preview exceeds the output limit'); }
function cleanLine(value: unknown): string { if (typeof value !== 'string' || !value.trim() || value.length > 8000) throw new PairedError('unsupported_format','Provider dialogue text is invalid'); const result = value.trim().replace(/^[「『]|[」』]$/gu, '').trim(); if (!result) throw new PairedError('unsupported_format','Provider returned an empty dialogue line'); return result; }
function outputKeys(row: Record<string, unknown>, keys: string[]): void { if (Object.keys(row).some(key => !keys.includes(key))) throw new PairedError('unsupported_format','Provider output contains unknown fields'); }
function outputText(value: unknown, label: string, max: number): string { if (typeof value !== 'string' || !value.trim() || value.length > max) throw new PairedError('unsupported_format',`Provider ${label} is invalid`); return value; }
function jsonOutput(value: string): Record<string, unknown> { try { return record(JSON.parse(value), 'provider output'); } catch { throw new PairedError('unsupported_format', 'Provider output must be a JSON object'); } }
function* topicContext(input: unknown, host: GuestHost, request: ActionRequest) {
  const row = record(input, 'input'); exactKeys(row, ['participantEntityIds'], 'input'); const participantEntityIds = ids(row.participantEntityIds, 2);
  const result = yield* profiles(host, request, participantEntityIds), selected = new Set(participantEntityIds), relations: string[] = [];
  for (const p of result.profiles) if (Array.isArray(p.raw.relations)) for (const raw of p.raw.relations) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue; const rel = raw as Record<string, unknown>;
    if (rel.auto === true || typeof rel.target !== 'string' || !selected.has(rel.target) || rel.target === p.id) continue;
    const kind = typeof rel.kind === 'string' ? rel.kind : 'related', note = typeof rel.note === 'string' ? `: ${rel.note}` : '';
    relations.push(`${p.name} ↔ ${result.profiles.find(x => x.id === rel.target)?.name ?? rel.target}: ${kind}${note}`);
  }
  for (const p of result.profiles) {
    const related = Array.isArray(p.raw.related) ? p.raw.related : typeof p.raw.related === 'string' ? [p.raw.related] : [];
    for (const raw of related) {
      const item = typeof raw === 'string' ? { target: raw } : raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
      if (!item || item.auto === true) continue;
      const target = item.target ?? item.id;
      if (typeof target !== 'string' || !selected.has(target) || target === p.id) continue;
      const note = typeof item.note === 'string' ? `: ${item.note}` : '';
      relations.push(`${p.name} ↔ ${result.profiles.find(x => x.id === target)?.name ?? target}: related${note}`);
    }
  }
  const prompt = `${COMMON}\n\n${['あなたは小説のセリフ問答（SS）用お題の提案者です。','参加キャラの関係性ラベルを種に、対比・緊張・親密さが際立つお題を3〜5個提案してください。','各お題は title（タイトル）と situation（場面設定）の組で構成してください。','title は名詞で終わる体言止めの短いタイトル（例:「エレベーター閉じ込め」「すれ違う本音」）。','title の文末を「〜する」「〜られる」のような用言で終わらせないこと。','situation は場所・時間・状況を1文で具体的に（例:「停電した夜のオフィスビル、二人きりのエレベーターの中」）。','セリフ・地の文・説明文は禁止。',`参加者: ${result.profiles.map(p => `${p.name} (${p.id})`).join('、')}`,`関係種:\n${relations.length ? [...new Set(relations)].map(x => `- ${x}`).join('\n') : '（関係ラベル未登録 — 参加者の対比・緊張を想像してよい）'}`,'\n\nJSONのみを返してください。スキーマ: {"topics":[{"title":"...","situation":"..."},{"title":"...","situation":"..."},{"title":"...","situation":"..."}]}'].join('\n')}`;
  const prepared = { prompt, promptVersion: 'v4', participantEntityIds, citations: result.profiles.flatMap(p => p.source ? [p.source] : []), knowledge: result.unavailable ? 'unavailable' : 'available', provider_invoked: false, snapshot: request.snapshot }; bounded(prepared); return prepared;
}
export function* previewDialogueTopics(input: unknown, host: GuestHost, request: ActionRequest) { return yield* topicContext(input, host, request); }
export function* suggestDialogueTopics(input: unknown, host: GuestHost, request: ActionRequest, generate: DialogueGenerate) {
  const prepared = yield* topicContext(input, host, request);
  const result = yield* generate(host, request, { feature: 'dialogue-sketch', prompt: prepared.prompt, promptVersion: prepared.promptVersion, maxOutputTokens: 4096, sourceManifest: prepared.citations });
  const parsed = jsonOutput(result.text); outputKeys(parsed, ['topics']);
  if (!Array.isArray(parsed.topics) || parsed.topics.length < 3 || parsed.topics.length > 5) throw new PairedError('unsupported_format', 'Provider must return 3–5 topics');
  const topics = parsed.topics.map(raw => { const row = record(raw, 'topic'); outputKeys(row, ['title','situation']); return { title: outputText(row.title,'title',512), situation: outputText(row.situation,'situation',2000) }; });
  return { ...prepared, provider_invoked: true, topics, model: result.provenance.model, provider: result.provenance.provider, provenance: result.provenance };
}
function* turnContext(input: unknown, host: GuestHost, request: ActionRequest) {
  const row = record(input,'input'); exactKeys(row,['participantEntityIds','precedingLines','speakerEntityId','lineCount','sketchId','topic','situation'],'input');
  const participantEntityIds = ids(row.participantEntityIds,1), selected = new Set(participantEntityIds);
  if ((row.speakerEntityId === undefined) === (row.lineCount === undefined)) throw new PairedError('invalid_input','Choose exactly one speaker or line count');
  const speakerEntityId = row.speakerEntityId === undefined ? undefined : identity(row.speakerEntityId,'speakerEntityId');
  if (speakerEntityId && !selected.has(speakerEntityId)) throw new PairedError('invalid_input','Speaker is not a selected participant');
  const lineCount = speakerEntityId ? 1 : finiteInteger(row.lineCount,'lineCount',1,30);
  const lines = row.precedingLines ?? []; if (!Array.isArray(lines) || lines.length > 80) throw new PairedError('invalid_input','precedingLines must have at most 80 entries');
  const preceding = lines.map(x => { const line = record(x,'line'); exactKeys(line,['speakerEntityId','text'],'line'); const speaker = identity(line.speakerEntityId,'speakerEntityId'); if (!selected.has(speaker)) throw new PairedError('invalid_input','Line speaker is not selected'); return { speakerEntityId: speaker, text: text(line.text,'line text',8000) }; });
  const topic = row.topic === undefined ? '（白紙）' : text(row.topic,'topic',2000), situation = row.situation === undefined ? '（白紙）' : text(row.situation,'situation',2000);
  const result = yield* profiles(host,request,participantEntityIds); let sketch: Profile | undefined;
  if (row.sketchId !== undefined) { sketch = yield* entity(host,request,identity(row.sketchId,'sketchId'),'dialogue_sketch'); const saved = sketch.raw.participantEntityIds; if (Array.isArray(saved) && saved.some(id => typeof id !== 'string' || !selected.has(id))) throw new PairedError('snapshot_stale','Saved sketch participants differ from selection'); }
  const dialogueSources: Source[] = [];
  const speakerContexts = [];
  for (const p of result.profiles) {
    const examples: Array<{text:string;sceneId:string;sceneName:string;sentenceIndex:number;confidence:'high';reason:string}> = [];
    try {
      const found = yield* invokeAction<{lines:unknown}>(host,request,'proprium.speaker','speaker.dialogue.list',{character_id:p.id,limit:6,min_confidence:'high'});
      if (!Array.isArray(found.lines) || found.lines.length > 6) throw new PairedError('unsupported_format','Speaker dialogue result is malformed');
      for (const raw of found.lines) {
        const line = record(raw,'Speaker dialogue'); if (line.confidence !== 'high') continue;
        const span = record(line.source_span,'Speaker source span'); const path = identity(span.path,'source path',4096), revision = identity(span.revision,'source revision');
        const start = finiteInteger(span.start,'source start',0), end = finiteInteger(span.end,'source end',start), quote = text(span.quote,'source quote',8000);
        const file = yield* readText(host,request,path);
        if (file.revision !== revision || file.text.slice(start,end) !== quote || line.text !== quote) throw new PairedError('snapshot_stale','Speaker dialogue evidence changed');
        dialogueSources.push({path,revision,quote});
        examples.push({text:quote,sceneId:typeof line.scene_id === 'string' ? line.scene_id : '',sceneName:typeof line.scene_name === 'string' ? line.scene_name : '',sentenceIndex:finiteInteger(line.sentence_index,'sentence index',1),confidence:'high',reason:typeof line.reason === 'string' ? line.reason : ''});
      }
    } catch (error) { if (!optional(error)) throw error; }
    const context = buildDialogueSketchSpeakerContext({entityId:p.id,name:p.name,raw:p.raw,speakerDialogues:{characterId:p.id,count:examples.length,minConfidence:'high',lines:examples}});
    speakerContexts.push({...p, voice:context.voiceProfileExcerpt ?? '',notes:context.notesExcerpt ?? '',examples:context.exampleDialogues,blankHeadings:context.blankHeadings});
  }
  const roster = speakerContexts.map(p => [`### ${p.name}（id: ${p.id}）`, '口調・声紋（厳守）:', p.voice || '（未登録 — 図鑑ノートと本編セリフ例を優先すること）', '図鑑ノート:', p.notes || '（なし）', '本編の確定帰属セリフ例:', p.examples.length ? p.examples.map(line => `- ${line}`).join('\n') : '（なし）'].join('\n')).join('\n\n');
  const precedingText = preceding.slice(-24).map(x => `${result.profiles.find(p => p.id === x.speakerEntityId)?.name ?? x.speakerEntityId}: ${x.text}`).join('\n') || '(まだセリフなし)';
  let prompt: string, promptVersion: string;
  if (speakerEntityId) {
    const selectedSpeaker = speakerContexts.find(p => p.id === speakerEntityId)!;
    const body = render(SINGLE, {speakerName:selectedSpeaker.name,voiceBlock:selectedSpeaker.voice || '（未登録 — 図鑑ノートと本編セリフ例を優先すること）',fingerprintBlock:'',notesExcerpt:selectedSpeaker.notes || '（なし）',blankHeadingsBlock:selectedSpeaker.blankHeadings.length ? `\n図鑑の未記入項目（余裕があれば話題に絡めてよい。無理に触れなくてよい）:\n${selectedSpeaker.blankHeadings.join('、')}` : '',exampleDialogues:selectedSpeaker.examples.length ? selectedSpeaker.examples.map(line=>`- ${line}`).join('\n') : '（なし）',otherParticipants:speakerContexts.filter(p=>p.id!==speakerEntityId).map(p=>p.name).join('、') || 'なし',topic,situation,precedingLines:precedingText});
    prompt = `${COMMON}\n\n${body}\n\nJSONのみを返してください。スキーマ: {"text":"..."}`; promptVersion = 'dialogue-sketch-line@3';
  } else {
    const body = render(MULTI,{lineCount:String(lineCount),speakerRoster:roster,topic,situation,precedingLines:precedingText});
    const rows = Array.from({length:lineCount},()=>'{"speakerEntityId":"participant-id","text":"..."}').join(',');
    prompt = `${COMMON}\n\n${body}\n\nJSONのみを返してください。スキーマ: {"lines":[${rows}]}`; promptVersion = 'dialogue-sketch-lines@1';
  }
  const prepared = { prompt, promptVersion, participantEntityIds, lineCount, ...(speakerEntityId ? {speakerEntityId} : {}), ...(sketch ? {sketchId: sketch.id} : {}), citations: [...result.profiles, ...(sketch ? [sketch] : [])].flatMap(p => p.source ? [p.source] : []).concat(dialogueSources), knowledge: result.unavailable ? 'unavailable' : 'available', provider_invoked: false, snapshot: request.snapshot }; bounded(prepared); return prepared;
}
export function* previewDialogueTurns(input: unknown, host: GuestHost, request: ActionRequest) { return yield* turnContext(input,host,request); }
export function* suggestDialogueTurns(input: unknown, host: GuestHost, request: ActionRequest, generate: DialogueGenerate) {
  const prepared = yield* turnContext(input,host,request); const generated = yield* generate(host,request,{ feature:'dialogue-sketch-turn',prompt:prepared.prompt,promptVersion:prepared.promptVersion,maxOutputTokens:prepared.speakerEntityId ? 256 : 4096,sourceManifest:prepared.citations });
  const parsed = jsonOutput(generated.text); let lines: Array<{speakerEntityId:string;text:string}>;
  if (prepared.speakerEntityId) { outputKeys(parsed,['text']); lines = [{speakerEntityId:prepared.speakerEntityId,text:cleanLine(parsed.text)}]; }
  else { outputKeys(parsed,['lines']); if (!Array.isArray(parsed.lines) || parsed.lines.length !== prepared.lineCount) throw new PairedError('unsupported_format','Provider returned the wrong number of lines'); lines = parsed.lines.map(raw => {const line=record(raw,'line');outputKeys(line,['speakerEntityId','text']);return {speakerEntityId:outputText(line.speakerEntityId,'speakerEntityId',256),text:cleanLine(line.text)};}); }
  if (lines.some(line => !prepared.participantEntityIds.includes(line.speakerEntityId))) throw new PairedError('unsupported_format','Provider returned an unselected speaker');
  return {...prepared,provider_invoked:true,lines,model:generated.provenance.model,provider:generated.provenance.provider,provenance:generated.provenance};
}
