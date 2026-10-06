'use strict';
const {AgentAdapter,AgentAdapterError}=require('../agent-adapter');
const {agentRuntimeProfile}=require('../agent-runtime-profile');
// ACP reachability is not qualification of write authority or vendor credits.
// Fail-closed seam until the transport is governed by the bridge capability policy.
class CursorAdapter extends AgentAdapter {
 constructor(){super({id:'cursor',label:'Cursor'});}
 contextPacket(pack){if(require('../memory-identity').hasLegacyIdentifiers(pack))throw new AgentAdapterError('AGENT_ADAPTER_UNAVAILABLE','Legacy memory identity requires migration');return require('../architecture-memory').packet(pack);}
 capabilities(){return['runtime_status'];}
 health(observation={}){return agentRuntimeProfile('cursor',observation);}
 async readiness({observation={}}={}){const h=this.health(observation);return{agentId:this.id,ready:false,reason:h.reason,availability:h.availability};}
 async dispatch(){throw new AgentAdapterError('AGENT_ADAPTER_UNAVAILABLE','Cursor execution is unqualified');}
 async status({observation={}}={}){return this.health(observation);}
}
module.exports={CursorAdapter};
