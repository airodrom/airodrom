'use strict';
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {OpenCodeAdapter}=require('../../src/opencode-adapter');
function runtime(t){
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'opencode-test-'))),fake=path.join(root,'runtime');
 fs.writeFileSync(fake,`#!${process.execPath}
const fs=require('node:fs');if(process.argv.includes('--version')){console.log('opencode v2.0.20');process.exit(0);}
let raw='';process.stdin.on('data',c=>raw+=c);process.stdin.on('end',()=>{const p=JSON.parse(raw),o=p.objective,config=JSON.parse(process.env.OPENCODE_CONFIG_CONTENT);let result={summary:'fixture result',changed_files:[],tests:[],artifacts:[],limitations:[]};
if(o==='timeout'){setTimeout(()=>{},10000);return;}if(o==='nonzero'){console.error('token=syntheticFailureSecret');process.exit(7);}if(o==='malformed'){console.log('broken');return;}
if(o==='change-executable')fs.appendFileSync(process.argv[1],'\\n// changed fixture\\n');
if(o==='undeclared')fs.writeFileSync('outside.txt','not authorized');
if(o==='secret'){result.summary='Bearer syntheticResultSecret';}
if(o==='escalation'){result.authority=true;}
if(o==='environment'){result.summary=Object.keys(process.env).sort().join(',');}
if(o.includes('alpha to beta')){fs.writeFileSync('fixture.txt','beta\\n');result.changed_files=['fixture.txt'];}
if(o==='memory'||o.includes('DEFAULT_MEMORY')){const records=p.current_context?.records||[];const fact=records.find(r=>r.subject==='fixture.color');result.summary=fact?fact.content:'unavailable';}
if(o.includes('test codename')){const records=p.current_context?.records||[];const fact=records.find(r=>r.subject==='test codename');result.summary=fact?fact.content:'unavailable';}
console.log(JSON.stringify({type:'text',sessionID:'ses_fixture',part:{messageID:'message_fixture',text:JSON.stringify(result)}}));
});`,{mode:0o700});
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const options={enabled:true,executable:fake,fixtureExecutable:fake,model:'ollama/fixture'};
 const adapter=new OpenCodeAdapter({options:{allowFixtureWorker:true}},options);
 const workspace=path.join(root,'repo');fs.mkdirSync(workspace);fs.writeFileSync(path.join(workspace,'fixture.txt'),'alpha\n');
 return{adapter,workspace,options,request:{workspace,files:['fixture.txt'],objective:'read',timeoutMs:1000}};
}
function manifest(repo){const {execFileSync}=require('node:child_process');return{mission:{id:'opencode-fixture',version:1,title:'OpenCode qualification fixture',repository:{root:repo,branch:execFileSync('/usr/bin/git',['-C',repo,'branch','--show-current'],{encoding:'utf8'}).trim()},authority:{level:'Development'},duration:{expires_after:'1h'},scope:{repositories:[repo],include:['fixture.txt'],exclude:[]},permissions:{filesystem:{read:true,write:true,delete:false},repository:{branch:false,commit:false,push:false,merge:false},runtime:{test:true,lint:true,typecheck:true,restart_local:false},network:{localhost:true,internet:false},providers:{local_reasoning:true,approved_external:false},memory:{read:true,search:true,write:false,delete:false}},evidence:{required:['tests','diff_check'],optional:[]},settlement:{review_required:true,merge_allowed:false,deploy_allowed:false},budget:{max_files_changed:1,max_commits:0,max_runtime_hours:1,max_external_reasoning_calls:0,max_memory_injections:20}}};}
function qualifyCanonical(bridge){
 const a=bridge.authorityRuntime,by=a.store.operator;a.qualification.prepare(by);
 const c=a.memory.ingest({session_id:'synthetic-runtime-qualification',chunk_id:'synthetic-preference',timestamp:1,speaker:'operator',claim:'No micro-prompts.',kind:'personal_preference',subject_key:'workflow.micro_prompts',value:'forbidden'},by),seed=a.memory.promote(c.id,{},by);a.qualification.proveMemory(seed.id,by);
 a.qualification.prepareRouter(by);a.qualification.proveRouter(by);a.qualification.enableRouter(by);return a;
}
module.exports={runtime,manifest,qualifyCanonical};
