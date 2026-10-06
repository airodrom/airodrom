'use strict';
const {AgentAdapter}=require('../agent-adapter');
class ClaudeCodeAdapter extends AgentAdapter {
 constructor(bridge){super({id:'claude_code',label:'Claude Code'});this.bridge=bridge;}
 capabilities(){return['coding','result_publish','decision_continuation','cancellation_request'];}
 async readiness(){const a=(await this.bridge.missions.agents.refresh()).claude_code;return{agentId:this.id,ready:a.available===true,availability:a.runtime_profile.availability,reason:a.reason};}
 async dispatch({task,repo,prompt,requestId}={}){
  require('../memory-content-erasure').assertContext(this.bridge.controlStore.db,task?.contextPackId);
  if(!task?.controlPlaneMissionId)throw Error('Claude adapter requires a durable Mission');
  const mission=this.bridge.controlStore.requireMission(task.controlPlaneMissionId);
  if(mission.task_id!==task.id||repo!==mission.envelope.workspace)throw Error('Claude dispatch correlation mismatch');
  return this.bridge.invokeCapability(task.id,{name:'claude_code_run_task',input:{repo,prompt,billing:'subscription',timeoutSeconds:120},requestId});
 }
 async status(){return (await this.bridge.missions.agents.refresh()).claude_code.runtime_profile;}
}
module.exports={ClaudeCodeAdapter};
