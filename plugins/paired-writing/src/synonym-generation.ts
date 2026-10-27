import type { ActionRequest } from '../../../app/src/browser/proprium/authoring/types.js';
import type { GuestHost, HostCall } from '../../shared/guest.js';
import { previewSynonyms } from './synonym-preview.js';
import type { DialogueGenerate } from './dialogue.js';
import { PairedError } from './types.js';
import { exactKeys, identity, record } from './validation.js';
import { sha256 } from './sha256.js';

type Preview = {prompt:string;promptVersion:string;presetId:string;model:string;provider_invoked:false;settings_revision:string|null};
/** Generate suggestions only after Host consent; terminology records are never changed here. */
export function* suggestSynonyms(input:unknown,host:GuestHost,request:ActionRequest,generate:DialogueGenerate):Generator<HostCall,unknown,unknown> {
  const row=record(input,'input');exactKeys(row,['suggestions'],'input');
  if(!Array.isArray(row.suggestions)||row.suggestions.length<1||row.suggestions.length>8)throw new PairedError('invalid_input','suggestions must contain 1–8 entries');
  if(!request.idempotency_key)throw new PairedError('invalid_input','Synonym generation requires an idempotency key');
  const inputs=row.suggestions.map(value=>{const item=record(value,'suggestion');exactKeys(item,['original','sentence','reason'],'suggestion');const original=identity(item.original,'original',256),sentence=identity(item.sentence,'sentence',8000);if(!original.trim()||!sentence.includes(original))throw new PairedError('invalid_input','sentence must contain the original term');const reason=item.reason===undefined?undefined:identity(item.reason,'reason',512);return {original,sentence,...(reason===undefined?{}:{reason})};});
  const results=[];
  for(let index=0;index<inputs.length;index++) {
    const item=inputs[index]!, preview=(yield* previewSynonyms(item,host,request)) as Preview;
    const childRequest={...request,idempotency_key:sha256(new TextEncoder().encode(JSON.stringify([request.idempotency_key,'synonym-suggest',index])))};
    const generated=yield* generate(host,childRequest,{feature:'synonym-suggest',prompt:preview.prompt,promptVersion:preview.promptVersion,maxOutputTokens:512,sourceManifest:{scope:request.scope,snapshot:request.snapshot,kind:'author-supplied-sentence',index,settings_revision:preview.settings_revision}});
    let parsed:unknown;try{parsed=JSON.parse(generated.text);}catch{throw new PairedError('unsupported_format','Synonym provider output is not JSON');}
    if(!parsed||typeof parsed!=='object'||Array.isArray(parsed)||Object.keys(parsed).some(key=>key!=='candidates'))throw new PairedError('unsupported_format','Synonym provider output is malformed');
    const candidates=(parsed as {candidates?:unknown}).candidates;
    if(!Array.isArray(candidates)||candidates.length<3||candidates.length>5||candidates.some(value=>typeof value!=='string'||!value.trim()||value.length>256))throw new PairedError('unsupported_format','Provider must return 3–5 bounded candidates');
    const clean=(candidates as string[]).map(value=>value.trim());
    if(new Set(clean).size!==clean.length||clean.includes(item.original.trim()))throw new PairedError('unsupported_format','Synonym candidates must be distinct and exclude the original');
    results.push({term:item.original,sentence:item.sentence,...(item.reason===undefined?{}:{reason:item.reason}),candidates:clean,prompt:preview.prompt,model:generated.provenance.model,provider:generated.provenance.provider,promptVersion:preview.promptVersion,citations:[],provenance:generated.provenance});
  }
  return {suggestions:results};
}
