import type { GestureAuthority, ProviderBrokerOptions, ProviderConfiguration, ProviderCredentialResolver } from './providers.js';

/** Host-local provider endpoint implementing the Proprium provider request envelope. */
export interface ProviderSettingsInput {
  providerId: string;
  label: string;
  endpoint: string;
  models: ReadonlyArray<{ modelId: string; label: string }>;
  credential: string;
}
export interface ProviderSettingsSummary {
  providerId: string;
  label: string;
  endpoint: string;
  models: ReadonlyArray<{ modelId: string; label: string }>;
}
const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const MODEL=/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,511}$/u;
function label(value:string,max:number):boolean { return typeof value==='string' && !!value.trim() && value.length<=max && !/[\u0000-\u001f\u007f]/u.test(value); }
function validate(input:ProviderSettingsInput):void {
  if (!input || !ID.test(input.providerId) || !label(input.label,128) || typeof input.endpoint!=='string' || input.endpoint.length>2048) throw new Error('提供先のID、名前、URLを確認してください。');
  let endpoint:URL; try { endpoint=new URL(input.endpoint); } catch { throw new Error('提供先のURLを確認してください。'); }
  if(endpoint.protocol!=='https:' || !endpoint.hostname || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error('提供先には、認証情報やクエリを含まないHTTPS URLを指定してください。');
  if(!Array.isArray(input.models)||input.models.length<1||input.models.length>128) throw new Error('モデルを1〜128件指定してください。');
  const ids=new Set<string>();for(const model of input.models){if(!model || !MODEL.test(model.modelId) || !label(model.label,128) || ids.has(model.modelId))throw new Error('モデルIDと名前を確認してください。');ids.add(model.modelId);}
  if(typeof input.credential!=='string'||! /^[\x21-\x7e]{1,8192}$/u.test(input.credential)) throw new Error('認証情報を確認してください。');
  let decodedEndpoint=input.endpoint; try { decodedEndpoint=decodeURIComponent(input.endpoint); } catch { /* Invalid escapes are left to URL validation. */ }
  const visible=[input.providerId,input.label,input.endpoint,decodedEndpoint,...input.models.flatMap(m=>[m.modelId,m.label])];
  if(visible.some(value=>value.includes(input.credential)))throw new Error('認証情報を提供先やモデルの設定に含めないでください。');
}
function makeHandle():string { const bytes=new Uint8Array(24);globalThis.crypto.getRandomValues(bytes);return `host:${Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('')}`; }

/**
 * Page-lifetime Host authority. Nothing is written to Git, localStorage or a
 * guest. Replacing/removing an entry immediately revokes its old handle.
 */
export class ProviderSettingsStore {
  readonly #providers=new Map<string,ProviderConfiguration>();
  readonly #secrets=new Map<string,string>();
  readonly #listeners=new Set<()=>void>();
  readonly #credentials:ProviderCredentialResolver={resolve:async handle=>this.#secrets.get(handle)};
  list():ProviderSettingsSummary[] { return [...this.#providers.values()].map(p=>({providerId:p.provider_id,label:p.label,endpoint:p.endpoint,models:p.models.map(m=>({modelId:m.model_id,label:m.label}))})); }
  subscribe(listener:()=>void):()=>void { this.#listeners.add(listener);return ()=>this.#listeners.delete(listener); }
  configure(input:ProviderSettingsInput):void {
    validate(input);
    if(!this.#providers.has(input.providerId)&&this.#providers.size>=16)throw new Error('提供先は16件まで登録できます。');
    const previous=this.#providers.get(input.providerId),handle=makeHandle();
    const config:ProviderConfiguration={provider_id:input.providerId,label:input.label,endpoint:new URL(input.endpoint).toString(),credential_handle:handle,models:input.models.map(m=>({model_id:m.modelId,label:m.label}))};
    this.#secrets.set(handle,input.credential);this.#providers.set(config.provider_id,config);
    if(previous)this.#secrets.delete(previous.credential_handle);
    for(const listener of this.#listeners)listener();
  }
  remove(providerId:string):void {const old=this.#providers.get(providerId);if(!old)return;this.#providers.delete(providerId);this.#secrets.delete(old.credential_handle);for(const listener of this.#listeners)listener();}
  clear():void {if(!this.#providers.size)return;this.#providers.clear();this.#secrets.clear();for(const listener of this.#listeners)listener();}
  /** Supply to the Host service; it adds its own trusted gesture authority. */
  brokerConfiguration():Omit<ProviderBrokerOptions,'gestures'> {return {providers:[...this.#providers.values()].map(p=>({...p,models:p.models.map(m=>({...m}))})),credentials:this.#credentials};}
  /** A standalone broker can use the same configuration with a Host gesture authority. */
  brokerOptions(gestures:GestureAuthority):ProviderBrokerOptions {return {...this.brokerConfiguration(),gestures};}
}
