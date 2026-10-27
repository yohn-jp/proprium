import type { Scope, Snapshot } from "./types.js";

export const SEMANTIC_PROGRESS_KEY = "semantic-task-progress-v1";
const phases = new Set(["source_scan","embedding","cache_validation","cache_publish","query_embedding","vector_scan","reranking","term_embedding","mention_scan","candidate_scoring","complete"]);
export interface HostTaskProgress { taskId: string; phase: string; completed: number; total: number }
interface ActiveTask {
  requestId: string; epoch: number; scope: Scope; snapshot: Snapshot;
  progress: HostTaskProgress; abort(): void; updatedAt: number;
}
const sameScope=(a:Scope,b:Scope)=>a.workspace_id===b.workspace_id&&a.repository_id===b.repository_id&&a.branch===b.branch&&a.generation===b.generation;
const invalid=()=>Object.assign(new Error("Task progress does not belong to the active Host invocation"),{code:"invalid_input"});

/** Task control stays outside the busy guest Worker and never writes the index cache. */
export class AuthoringTaskRegistry {
  private active?: ActiveTask;
  begin(requestId:string,epoch:number,scope:Scope,snapshot:Snapshot,taskId:string,abort:()=>void):void{
    if(this.active){
      if(this.active.epoch===epoch&&sameScope(this.active.scope,scope))throw Object.assign(new Error("A Semantic task is already active"),{code:"capacity"});
      this.active.abort();
    }
    if(!/^[A-Za-z0-9_-]{1,128}$/u.test(taskId))throw invalid();
    this.active={requestId,epoch,scope:structuredClone(scope),snapshot:structuredClone(snapshot),progress:{taskId,phase:"cache_validation",completed:0,total:1},abort,updatedAt:0};
  }
  update(requestId:string,epoch:number,scope:Scope,value:unknown):{stored:true}{
    const task=this.active;
    if(!task||task.requestId!==requestId||task.epoch!==epoch||!sameScope(task.scope,scope)||!value||typeof value!=="object"||Array.isArray(value))throw invalid();
    const row=value as HostTaskProgress;
    if(Object.keys(row).some(key=>!["taskId","phase","completed","total"].includes(key))||row.taskId!==task.progress.taskId||!phases.has(row.phase)||
      !Number.isSafeInteger(row.completed)||!Number.isSafeInteger(row.total)||row.completed<0||row.total<row.completed||
      (task.progress.phase===row.phase&&row.completed<task.progress.completed))throw invalid();
    const now=Date.now();
    if(now-task.updatedAt>=100||row.phase!==task.progress.phase||row.completed===row.total){task.progress={taskId:row.taskId,phase:row.phase,completed:row.completed,total:row.total};task.updatedAt=now;}
    return {stored:true};
  }
  status(scope:Scope,snapshot:Snapshot,epoch:number):HostTaskProgress[]{
    const task=this.active;
    if(!task||task.epoch!==epoch||!sameScope(task.scope,scope))return [];
    if(task.snapshot.worktree_generation!==snapshot.worktree_generation||task.snapshot.local_commit!==snapshot.local_commit){task.abort();return [];}
    return [{...task.progress}];
  }
  cancel(scope:Scope,epoch:number,taskId:string):boolean{
    const task=this.active;
    if(!task||task.epoch!==epoch||!sameScope(task.scope,scope)||task.progress.taskId!==taskId)return false;
    task.abort();return true;
  }
  finish(requestId:string):void{if(this.active?.requestId===requestId)this.active=undefined;}
  dispose():void{this.active?.abort();this.active=undefined;}
}
