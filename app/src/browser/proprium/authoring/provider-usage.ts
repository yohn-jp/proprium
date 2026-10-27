import type { BrokerStore } from "./brokers.js";
import type { Scope } from "./types.js";
import type { ProviderRequestInput } from "./providers.js";

interface UsageEvent {
  id: string; feature: string; provider: string; model: string; startedAt: string;
  completedAt?: string; durationMs?: number; state: "pending" | "completed" | "aborted" | "failed"; errorCode?: string;
}
interface History { rows: UsageEvent[]; complete: boolean }
export interface ProviderUsageReceipt { key: string; plugin: string; user: string; id: string; startedAt: string }

/** Host-only metadata in the existing broker preference table; never prompt/output text. */
export class ProviderUsageHistory {
  private readonly queues = new Map<string, Promise<unknown>>();
  constructor(private readonly store: BrokerStore) {}
  private partition(plugin: string, actor: string, scope: Scope): string {
    return JSON.stringify([plugin,actor,scope.workspace_id,scope.repository_id,scope.branch]);
  }
  private async load(key: string): Promise<History> {
    const record=await this.store.getPreference(key);
    if(!record)return {rows:[],complete:true};
    const value=record.value as History;
    if(!value || !Array.isArray(value.rows) || value.rows.length>1000 || typeof value.complete!=="boolean")throw Object.assign(new Error("Provider usage metadata is corrupt"),{code:"storage_unknown"});
    return structuredClone(value);
  }
  private serialize<T>(key:string,operation:()=>Promise<T>):Promise<T>{
    const next=(this.queues.get(key)??Promise.resolve()).then(operation,operation);
    this.queues.set(key,next);
    void next.finally(()=>{if(this.queues.get(key)===next)this.queues.delete(key);}).catch(()=>undefined);
    return next;
  }
  async begin(plugin:string,actor:string,scope:Scope,input:ProviderRequestInput):Promise<ProviderUsageReceipt>{
    const user=this.partition(plugin,actor,scope),key=`host-provider-usage:${user}`;
    return this.serialize(key,async()=>{
      const history=await this.load(key);
      if(history.rows.some(row=>row.id===input.request_id))throw Object.assign(new Error("Resolve the recorded provider request instead of sending it again"),{code:"external_state_unknown"});
      const startedAt=new Date().toISOString();
      history.rows.push({id:input.request_id,feature:input.purpose,provider:input.provider_id,model:input.model_id,startedAt,state:"pending"});
      if(history.rows.length>1000){history.rows=history.rows.slice(-1000);history.complete=false;}
      await this.store.putPreference({key,plugin_id:plugin,user_partition:user,preference_key:"provider-usage-v1",schema_version:1,value:history});
      return {key,plugin,user,id:input.request_id,startedAt};
    });
  }
  async finish(receipt:ProviderUsageReceipt,error?:unknown):Promise<void>{
    return this.serialize(receipt.key,async()=>{
      const history=await this.load(receipt.key),row=history.rows.find(item=>item.id===receipt.id);
      if(!row)throw Object.assign(new Error("Provider attempt metadata disappeared"),{code:"storage_unknown"});
      const code=error && typeof error==="object" && "code" in error && typeof error.code==="string" ? error.code : undefined;
      row.state=error ? code==="cancelled" ? "aborted" : "failed" : "completed";
      row.completedAt=new Date().toISOString();row.durationMs=Math.max(0,Date.now()-Date.parse(receipt.startedAt));
      if(code)row.errorCode=code.slice(0,96);
      await this.store.putPreference({key:receipt.key,plugin_id:receipt.plugin,user_partition:receipt.user,preference_key:"provider-usage-v1",schema_version:1,value:history});
    });
  }
  async read(plugin:string,actor:string,scope:Scope){
    const history=await this.load(`host-provider-usage:${this.partition(plugin,actor,scope)}`);
    const pending=history.rows.some(row=>row.state==="pending");
    return {available:true,events:history.rows.filter(row=>row.state!=="pending"),complete:history.complete&&!pending,
      ...(pending?{reason:"Unresolved provider request metadata is retained; no automatic resend is allowed"}:{})};
  }
}
