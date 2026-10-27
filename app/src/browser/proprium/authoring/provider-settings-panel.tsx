import { useEffect, useRef, useState, type FormEvent, type ReactElement } from 'react';
import type { ProviderSettingsStore } from './provider-settings.js';

/** Host-owned UI; plugin declarations cannot configure a provider or read credentials. */
export function ProviderSettingsPanel({store,onChanged}:{store:ProviderSettingsStore;onChanged:()=>void}):ReactElement {
  const [revision,setRevision]=useState(0);
  const [providerId,setProviderId]=useState('');const [name,setName]=useState('');const [endpoint,setEndpoint]=useState('');const [models,setModels]=useState('');const [message,setMessage]=useState('');
  const credential=useRef<HTMLInputElement>(null);
  useEffect(()=>store.subscribe(()=>setRevision(value=>value+1)),[store]);
  void revision;
  const submit=(event:FormEvent<HTMLFormElement>)=>{
    event.preventDefault();
    const secret=credential.current?.value ?? '';
    try {
      const modelRows=models.split(/\r?\n/u).map(value=>value.trim()).filter(Boolean).map(modelId=>({modelId,label:modelId}));
      store.configure({providerId:providerId.trim(),label:name.trim(),endpoint:endpoint.trim(),models:modelRows,credential:secret});
      if(credential.current)credential.current.value='';
      setMessage('このタブで提供先を設定しました。送信のたびに内容を確認します。');onChanged();
    } catch(error) {if(credential.current)credential.current.value='';setMessage(error instanceof Error ? error.message : '設定を保存できませんでした。');}
  };
  const remove=(id:string)=>{store.remove(id);onChanged();setMessage('提供先を削除しました。');};
  return <section aria-labelledby="provider-settings-title">
    <h2 id="provider-settings-title">外部プロバイダー</h2>
    <p>Propriumのプロバイダー要求形式に対応するHTTPSエンドポイントを設定します。通常のモデルAPIを直接指定する場合は、この形式を受けるアダプターが必要です。</p>
    <p>認証情報と設定はこのページのメモリーにのみ保存され、ページを閉じると消えます。設定だけでは送信されず、毎回、宛先と内容の確認が必要です。</p>
    <form onSubmit={submit}>
      <label>提供先ID<input required maxLength={128} value={providerId} onChange={event=>setProviderId(event.currentTarget.value)} /></label>
      <label>表示名<input required maxLength={128} value={name} onChange={event=>setName(event.currentTarget.value)} /></label>
      <label>互換エンドポイント（HTTPS）<input type="url" required maxLength={2048} value={endpoint} onChange={event=>setEndpoint(event.currentTarget.value)} /></label>
      <p>モデルIDは、執筆ツールのモデル設定にあるIDと完全に一致させてください。</p>
      <label>許可するモデルID（1行に1つ）<textarea required value={models} onChange={event=>setModels(event.currentTarget.value)} /></label>
      <label>Bearer認証情報<input ref={credential} type="password" required maxLength={8192} autoComplete="off" spellCheck={false} /></label>
      <button type="submit">このページで設定</button>
    </form>
    <p role="status" aria-live="polite">{message}</p>
    <ul>{store.list().map(item=><li key={item.providerId}><strong>{item.label}</strong> <code>{item.providerId}</code> <span>{item.endpoint}</span> <span>{item.models.map(model=>model.modelId).join('、')}</span> <button type="button" onClick={()=>remove(item.providerId)}>削除</button></li>)}</ul>
  </section>;
}
