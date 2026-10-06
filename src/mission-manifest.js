"use strict";
const fs=require('node:fs'),path=require('node:path');
const {fingerprint,object,text}=require('./control-plane-store');
const {canonical,inside}=require('./mission-manifest-paths');
const GROUPS={filesystem:['read','write','delete'],repository:['branch','commit','push','merge'],runtime:['test','lint','typecheck','restart_local'],network:['localhost','internet'],providers:['local_reasoning','approved_external'],memory:['read','search','write','delete']};
const BUDGETS=['max_files_changed','max_commits','max_runtime_hours','max_external_reasoning_calls','max_memory_injections'];
const EVIDENCE=['tests','typecheck','lint','diff_check','benchmark'];
function pattern(value){
 text(value,'scope pattern',300);
 if(value.includes('\\')||path.isAbsolute(value)||value.split('/').some(p=>!p||p==='.'||p==='..')||/[^a-zA-Z0-9_./* -]/.test(value)||value.includes('***'))throw Error('Invalid manifest scope pattern');
 return value;
}
function matches(glob,file){const expression=glob.split('**').map(part=>part.split('*').map(p=>p.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('[^/]*')).join('.*');return new RegExp('^'+expression+'$').test(file);}
function normalizeManifest(input,{workspace,allowedFiles,verification,now=Date.now()}={}){
 object(input,['mission']);const m=input.mission;object(m,['id','version','title','repository','authority','duration','scope','permissions','evidence','settlement','budget']);
 if(m.version!==1)throw Error('Unsupported Mission Manifest version');text(m.id,'manifest id',120);text(m.title,'manifest title',240);
 object(m.repository,['root','branch']);const root=fs.realpathSync(m.repository.root);if(root!==workspace)throw Error('Manifest repository mismatch');text(m.repository.branch,'manifest branch',240);
 if(!/^[a-zA-Z0-9_./-]+$/.test(m.repository.branch)||m.repository.branch.includes('..'))throw Error('Invalid manifest branch');
 object(m.authority,['level']);if(m.authority.level!=='Development')throw Error('Manifest V1 requires Development authority');
 object(m.duration,['expires_after']);const duration=/^(\d+)(m|h)$/.exec(m.duration.expires_after);if(!duration)throw Error('Invalid manifest duration');const ttl=Number(duration[1])*(duration[2]==='h'?3600000:60000);if(ttl<60000||ttl>86400000)throw Error('Manifest duration must be within 24 hours');
 object(m.scope,['repositories','include','exclude']);if(!Array.isArray(m.scope.repositories)||m.scope.repositories.length!==1||fs.realpathSync(m.scope.repositories[0])!==root)throw Error('Manifest V1 binds one repository');
 for(const key of ['include','exclude'])if(!Array.isArray(m.scope[key])||m.scope[key].length>40||m.scope[key].some(p=>{pattern(p);return false;}))throw Error('Invalid manifest scope');
 if(!m.scope.include.length)throw Error('Manifest include scope required');
 object(m.permissions,Object.keys(GROUPS));for(const [group,flags]of Object.entries(GROUPS)){object(m.permissions[group],flags);if(flags.some(f=>typeof m.permissions[group][f]!=='boolean'))throw Error('Explicit manifest permissions required');}
 if(m.permissions.filesystem.delete||m.permissions.repository.push||m.permissions.repository.merge||m.permissions.memory.delete)throw Error('Manifest V1 forbids destructive or publication permissions');
 object(m.evidence,['required','optional']);for(const key of ['required','optional'])if(!Array.isArray(m.evidence[key])||new Set(m.evidence[key]).size!==m.evidence[key].length||m.evidence[key].some(e=>!EVIDENCE.includes(e)))throw Error('Unknown manifest evidence');
 if(!['tests','diff_check'].every(e=>m.evidence.required.includes(e)))throw Error('Tests and diff_check evidence required');
 object(m.settlement,['review_required','merge_allowed','deploy_allowed']);if(m.settlement.review_required!==true||m.settlement.merge_allowed!==false||m.settlement.deploy_allowed!==false)throw Error('Manifest settlement requires review and forbids merge/deploy');
 object(m.budget,BUDGETS);for(const key of BUDGETS)if(!Number.isFinite(m.budget[key])||m.budget[key]<0||m.budget[key]>1000000||(key!=='max_runtime_hours'&&!Number.isSafeInteger(m.budget[key])))throw Error('Finite manifest budgets required');
 if(m.budget.max_runtime_hours<=0||m.budget.max_runtime_hours>24||m.budget.max_files_changed<1)throw Error('Invalid runtime/file budget');
 const result=JSON.parse(JSON.stringify(m));result.repository.root=root;result.scope.repositories=[root];result.scope.exclude=[...new Set([...result.scope.exclude,'.git/**','.runtime/**','secrets/**','production/**','.env','.env.*'])];result.verification_tasks=JSON.parse(JSON.stringify(verification));result.approved_at=now;result.expires_at=now+Math.min(ttl,m.budget.max_runtime_hours*3600000);
 for(const file of allowedFiles){if(!allowsPath(result,path.join(root,file),'write'))throw Error('Allowed file outside manifest scope');}
 if(allowedFiles.length>result.budget.max_files_changed)throw Error('Declared files exceed manifest budget');
 for(const kind of result.evidence.required){const labels=kind==='tests'?verification.tests:kind==='diff_check'?[verification.diff_check]:verification[kind];if(!Array.isArray(labels)||!labels.length)throw Error('Required manifest evidence has no registered verifier: '+kind);}
 return result;
}
function allowsPath(m,target,mode){let resolved;try{resolved=canonical(target);}catch{return false;}if(!inside(m.repository.root,resolved))return false;const relative=path.relative(m.repository.root,resolved).split(path.sep).join('/');if(!relative)return mode==='read'&&m.permissions.filesystem.read;return m.permissions.filesystem[mode]===true&&m.scope.include.some(p=>matches(p,relative))&&!m.scope.exclude.some(p=>matches(p,relative));}
function checkManifest(m,call,workspace,now=Date.now()){
 if(!m)return {allow:true};if(now>=m.expires_at)return{allow:false,reason:'Mission Manifest expired'};
 const req=require('./mission-permissions').callRequirements(call,workspace),p=m.permissions;
 if(req.unknown)return{allow:false,reason:'Operation has no manifest mapping'};
 const mapping={repository:{read:p.filesystem.read,write:p.filesystem.write,branch:p.repository.branch,commit:p.repository.commit,push:false,merge:false},runtime:{diagnostic:p.filesystem.read,test:p.runtime.test,build:false,restart:p.runtime.restart_local},network:p.network,secrets:{},data:{read:p.filesystem.read,workspace_write:p.filesystem.write,personal_memory:p.memory.read||p.memory.write,project_memory:p.memory.read||p.memory.write}};
 for(const [dimension,flags]of Object.entries(req)){if(dimension==='filesystem')continue;for(const flag of flags)if(mapping[dimension]?.[flag]!==true)return{allow:false,reason:'Manifest denies '+dimension+':'+flag};}
 for(const mode of ['read','write'])for(const target of req.filesystem?.[mode]||[]){
 // Registered verification executes against immutable protected inputs, and
 // independently checks the entire workspace afterward. It is never a file-write grant.
 const name=call.toolName==='capability'?call.input.name:call.toolName;
 if(name==='vscode_run_task'&&canonical(target)===m.repository.root){const label=call.input.input.label;const kinds=Object.entries(m.verification_tasks||{}).filter(([,labels])=>Array.isArray(labels)?labels.includes(label):labels===label).map(([kind])=>kind);if(!kinds.length||kinds.some(kind=>['typecheck','lint'].includes(kind)&&!p.runtime[kind]))return{allow:false,reason:'Manifest registered verifier denied'};continue;}
 if(['git_status','git_diff','git_log','git_show','git_branch_list'].includes(name)&&mode==='read'&&canonical(target)===m.repository.root)continue;
 if(!allowsPath(m,target,mode))return{allow:false,reason:'Manifest filesystem '+mode+' boundary exceeded'};
 }
 if(call.toolName?.includes('memory')||call.toolName?.startsWith('project_')){if(/search/.test(call.toolName)&&!p.memory.search)return{allow:false,reason:'Manifest memory search denied'};const writing=!/search|get|recent|list|summary|next_action/.test(call.toolName);if(!(writing?p.memory.write:p.memory.read))return{allow:false,reason:'Manifest memory permission denied'};}
 return{allow:true};
}
module.exports={normalizeManifest,allowsPath,matches,checkManifest,fingerprint};
