'use strict';
const {AgentAdapter,AgentAdapterError}=require('../agent-adapter');
const {agentRuntimeProfile}=require('../agent-runtime-profile');
// ACP reachability is not qualification of write authority or vendor credits.
// ADR 0051: governed execution is delegated to the sandboxed headless CursorWorker
// and only for Missions whose contract authorizes external disclosure to Cursor.
class CursorAdapter extends AgentAdapter {
 constructor(bridge=null){super({id:'cursor',label:'Cursor'});this.bridge=bridge;}
 contextPacket(pack){if(require('../memory-identity').hasLegacyIdentifiers(pack))throw new AgentAdapterError('AGENT_ADAPTER_UNAVAILABLE','Legacy memory identity requires migration');return require('../architecture-memory').packet(pack);}
 capabilities(){return this.bridge?.cursorWorker?['runtime_status','coding','bounded_file_work','result_publish','cancellation','governed_headless']:['runtime_status'];}
 health(observation={}){return agentRuntimeProfile('cursor',observation);}
 async readiness({observation={}}={}){
  const worker=this.bridge?.cursorWorker;
  if(worker){const r=await worker.readiness();worker.lastReadiness=r;return{...r,agentId:this.id};}
  const h=this.health(observation);return{agentId:this.id,ready:false,reason:h.reason,availability:h.availability};
 }
 async dispatch(input){
  const worker=this.bridge?.cursorWorker;
  if(!worker)throw new AgentAdapterError('AGENT_ADAPTER_UNAVAILABLE','Cursor execution is unqualified');
  return worker.dispatch(input);
 }
 async cancel(input){return this.bridge?.cursorWorker?this.bridge.cursorWorker.cancel(input):{cancellation_requested:false,authority:false};}
 async shutdown(){return this.bridge?.cursorWorker?.shutdown();}
 async status({observation={}}={}){return this.bridge?.cursorWorker?this.readiness():this.health(observation);}
}
module.exports={CursorAdapter};
