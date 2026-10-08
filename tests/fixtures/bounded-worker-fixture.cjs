'use strict';
const fs=require('node:fs'),path=require('node:path');
function executable(root,id='codex',mode='valid'){
 const file=path.join(root,'bounded-'+id+'-'+mode);
 fs.writeFileSync(file,`#!${process.execPath}
'use strict';const fs=require('node:fs');let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{
 const p=JSON.parse(input);if(!process.env.HOME.includes('airo-worker-')||process.env.CLAUDE_CODE_OAUTH_TOKEN||process.env.OPENAI_API_KEY||process.env.ANTHROPIC_API_KEY)process.exit(2);
 if(${JSON.stringify(mode)}==='hang'){setInterval(()=>{},1000);return;}
 const result={status:'completed',summary:'Synthetic bounded proposal',changes:p.allowed_changes.map(path=>({path,content:'beta\\n'}))};const emit=e=>console.log(JSON.stringify(e));
 if(${JSON.stringify(id)}==='codex'){emit({type:'thread.started',thread_id:'fixture-session'});if(${JSON.stringify(mode)}==='tool')emit({type:'item.completed',item:{type:'command_execution',command:'synthetic'}});emit({type:'item.completed',item:{type:'agent_message',text:JSON.stringify(result)}});emit({type:'turn.completed',usage:{input_tokens:7,output_tokens:5}});}
 else{emit({type:'system',subtype:'init',model:${JSON.stringify(mode==='drift'?'other-model':'fixture-model')},session_id:'fixture-session',tools:[],mcp_servers:[]});emit({type:'result',subtype:'success',is_error:false,structured_output:result,usage:{input_tokens:7,output_tokens:5}});}
});`,{mode:0o700});return file;
}
const options=(root,id='codex',mode='valid')=>({fixture:true,executable:executable(root,id,mode)});
module.exports={executable,options};
