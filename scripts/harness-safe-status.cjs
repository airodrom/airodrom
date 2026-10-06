'use strict';
// Whitelisted status only. Never print or return runtime discovery documents.
const fs=require('node:fs'),path=require('node:path');
async function status({runtime=path.resolve(__dirname,'../.runtime'),request=fetch}={}){
 const file=path.join(runtime,'ui.json');
 const discovery=require('../src/private-json').readPrivateJSON(file),u=new URL(discovery.url);
 if(u.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(u.hostname)||u.username||u.password)throw Error('Loopback discovery required');
 const token=new URLSearchParams(u.hash.slice(1)).get('token');if(!token)throw Error('Private discovery unavailable');
 const response=await request(u.origin+'/api/control-v2/health',{headers:{Authorization:'Bearer '+token},redirect:'error',signal:AbortSignal.timeout(5000)});
 if(!response.ok)throw Error('Health request unavailable');const h=await response.json();
 return{healthy:h.bridge?.healthy===true,mcp_ready:h.bridge?.mcp_ready===true,pid:Number.isInteger(h.bridge?.pid)?h.bridge.pid:null,pending_approvals:Number.isInteger(h.pending_approvals)?h.pending_approvals:null,pending_decisions:Number.isInteger(h.pending_decisions)?h.pending_decisions:null,quarantined_leases:Number.isInteger(h.quarantined_leases)?h.quarantined_leases:null,outbox_pending:Number.isInteger(h.outbox?.counts?.pending)?h.outbox.counts.pending:0};
}
if(require.main===module)status().then(value=>console.log(JSON.stringify(value))).catch(()=>{console.error('Safe health observation unavailable. No discovery data exported.');process.exitCode=1;});
module.exports={status};
