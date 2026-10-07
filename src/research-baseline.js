'use strict';
// Host configuration only. Website/model content cannot select repository paths.
const fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');
const {createHash,randomUUID}=require('node:crypto');
const {secretLike}=require('./provider-policy');
const {containsSecret}=require('./personal-memory');
const {safePath,resolveGitExecutable}=require('./repository-verification');
const {sensitivePath}=require('./fs-scopes');
const LIMITS=Object.freeze({files:32,fileBytes:128000,totalBytes:1500000,excerpt:2200});
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SHA=/^[a-f0-9]{64}$/;
const exactKeys=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&Object.keys(value).every(key=>keys.includes(key));
const hash=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
const freeze=value=>{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;};
const INJECTION=/\b(?:ignore|override|disregard)\s+(?:(?:all|the|any|previous|prior)\s+)*(?:instructions|system|policy)|\b(?:exfiltrate|reveal|send)\s+(?:all\s+)?(?:credentials|passwords|secrets|system prompt)|<\/?(?:system|assistant|tool)>|\[INST\]/i;
function unsafeText(value){return typeof value!=='string'||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(value)||secretLike(value)||INJECTION.test(value);}
// Evidence is allowed to cite public paths. Generic transport-log path redaction
// is not a credential detector; actual credential/control/instruction content is.
function unsafeEvidenceText(value){return typeof value!=='string'||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(value)||containsSecret(value)||INJECTION.test(value.normalize('NFKC'));}
const DEFAULT_FEATURES=Object.freeze([
 {id:'cashflow',label:'Cash-flow dashboard',docs:['docs/architecture/financial-cashflow-intelligence-m10.md'],code:['server/src/services/financialIntelligence/cashflowSummary.ts'],match:/cash.?flow/i},
 {id:'transactions',label:'Transaction search and detail',docs:['docs/product/merchant-transaction-explorer-v1.md'],code:['server/src/services/financialIntelligence/transactionExplorer.ts'],match:/transaction|explorer/i},
 {id:'forecast',label:'Cash-flow forecasting',docs:['docs/architecture/financial-forecast-v1.md'],code:['server/src/services/financialIntelligence/cashForecast.ts'],match:/forecast/i},
 {id:'reconciliation',label:'Cash-flow reconciliation',docs:['docs/architecture/financial-cashflow-reconciliation-m11.md'],code:['server/src/services/financialIntelligence/cashReconciliation.ts'],match:/reconcil/i},
 {id:'data_quality',label:'Data quality and freshness',docs:['docs/architecture/financial-data-quality-confidence-m12.md'],code:['server/src/services/financialIntelligence/dataQuality.ts'],match:/quality|confidence|freshness/i},
 {id:'merchant_dashboard',label:'Merchant dashboard',docs:['docs/product/merchant-command-center-v1.md'],code:['web/admin/components/cashflow/CashFlowWorkspace.tsx','web/admin/app/(admin)/command-center/page.tsx'],match:/command center|dashboard|workspace/i},
 {id:'bank_connections',label:'Bank-data connections',docs:['docs/architecture/financial-data-plaid-sandbox.md'],code:['server/src/services/financialData/syncAccounts.ts'],match:/plaid|connection|account/i,partial:/LIVE\s*(?:\*\*)?\s*(?:OFF|NO)|sandbox|restricted pilot/i},
 {id:'finance_copilot',label:'Grounded financial assistant',docs:['docs/architecture/financial-copilot-foundation-v1.md'],code:['server/src/services/financialIntelligence/investigations.ts'],match:/copilot|investigation/i,partial:/provider.{0,30}disabled|not.*connect an LLM|free.form.{0,30}out of scope/i},
 {id:'conversational_finance',label:'Live free-form financial chat',docs:['docs/architecture/financial-copilot-foundation-v1.md'],code:['server/src/services/financialIntelligence/investigations.ts'],match:/copilot|investigation/i,negative:/does\s+(?:\*\*)?not(?:\*\*)?\s+connect an LLM|free.form Command Center chat/i,codeNegative:/provider.{0,40}disabled|disabled.{0,40}provider/i},
 {id:'assistant_payments',label:'Financial-assistant payment execution',docs:['docs/architecture/financial-copilot-foundation-v1.md'],code:['server/src/services/financialIntelligence/investigations.ts'],match:/payment|investigation/i,negative:/Advice\s*\/\s*payments\s*\|\s*\*\*Out of scope/i,codeNegative:/provider.{0,40}disabled|disabled.{0,40}provider/i},
 {id:'automated_payments',label:'Automated payments',docs:[],code:[],match:/payment/i},
 {id:'budgeting',label:'Budget planning',docs:[],code:[],match:/budget/i},
 {id:'expense_management',label:'Expense management',docs:[],code:[],match:/expense/i}
]);
const DEFAULT_FILES=Object.freeze([...new Set(['docs/commercial/public-site-positioning.md',...DEFAULT_FEATURES.flatMap(f=>[...f.docs,...f.code])])].map(name=>({path:name,kind:name.endsWith('.md')?'document':'implementation'})));
function approvedPath(name){
 safePath(name);
 if(sensitivePath('/approved/'+name,'/approved')||name.split('/').some(p=>/^(?:data|logs?|runtime|sessions?|uploads?|exports?|backups?|node_modules|fixtures|testdata|test-data)$/i.test(p))||! /\.(?:md|mdc|js|cjs|mjs|ts|tsx)$/.test(name))throw Error('Research baseline path is outside the approved source boundary');
 return name;
}
function regexp(value){return value instanceof RegExp?new RegExp(value.source,value.flags.replace(/[gy]/g,'')):null;}
function featureSpecs(features){
 if(!Array.isArray(features)||features.length>24)throw Error('Invalid host baseline feature configuration');
 const seen=new Set();return features.map(f=>{
  if(!f||Object.keys(f).some(k=>!['id','label','docs','code','match','partial','negative','codeNegative'].includes(k))||typeof f.id!=='string'||! /^[a-z][a-z0-9_]{0,39}$/.test(f.id)||seen.has(f.id)||typeof f.label!=='string'||!f.label.trim()||f.label.length>80||unsafeText(f.label)||!Array.isArray(f.docs)||!Array.isArray(f.code))throw Error('Invalid host baseline feature');
  seen.add(f.id);return {id:f.id,label:f.label,docs:f.docs.map(approvedPath),code:f.code.map(approvedPath),match:regexp(f.match),partial:regexp(f.partial),negative:regexp(f.negative),codeNegative:regexp(f.codeNegative)};
 });
}
function fileRead(root,name){
 let current=root;
 for(const part of name.split('/')){current=path.join(current,part);let stat;try{stat=fs.lstatSync(current);}catch(error){if(error.code==='ENOENT')return null;throw Error('Baseline source unavailable');}if(stat.isSymbolicLink())throw Error('Baseline symlink denied');}
 const stat=fs.lstatSync(current);if(!stat.isFile()||stat.nlink!==1||stat.size>LIMITS.fileBytes)throw Error('Baseline source bounds denied');
 const fd=fs.openSync(current,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
 try{const before=fs.fstatSync(fd),bytes=fs.readFileSync(fd),after=fs.fstatSync(fd),last=fs.lstatSync(current);if(bytes.length>LIMITS.fileBytes||before.dev!==last.dev||before.ino!==last.ino||before.nlink!==1||last.nlink!==1||before.size!==after.size||before.mtimeMs!==after.mtimeMs||after.ctimeMs!==last.ctimeMs)throw Error('Baseline source changed during read');const original=bytes.toString('utf8');if(Buffer.from(original).compare(bytes)!==0||unsafeEvidenceText(original))return {excluded:'unsafe_source_content'};const text=original.split(/\r?\n/).map(line=>unsafeEvidenceText(line)||/process\.env|\b[A-Z][A-Z0-9_]{2,}\s*=/.test(line)?'':line).join('\n');return {text,sha256:hash(original),bytes:bytes.length};}finally{fs.closeSync(fd);}
}
function excerpt(text){
 const lines=text.split(/\r?\n/),selected=[];let size=0;
 for(let i=0;i<lines.length&&size<LIMITS.excerpt;i++){
  const line=lines[i];if(i>32&&!/^\s*(?:export\s+(?:async\s+)?(?:function|const|class)|#{1,3}\s|\*\*Status|Status:)|implemented|provider.{0,30}disabled|not production|live\s*(?:off|no)|out of scope/i.test(line))continue;
  if(/process\.env|\b[A-Z][A-Z0-9_]{2,}\s*=|\b(?:secret|password|api[_ -]?key|access[_ -]?token|refresh[_ -]?token)\b/i.test(line))continue;
  const bounded=line.slice(0,320);if(size+bounded.length>LIMITS.excerpt)break;selected.push({line:i+1,text:bounded});size+=bounded.length+1;
 }
 return {excerpt:selected.map(x=>`${x.line}: ${x.text}`).join('\n'),lines:{start:selected[0]?.line||1,end:selected.at(-1)?.line||1}};
}
class ResearchBaseline {
 constructor({workspace,approvedFiles=DEFAULT_FILES,features=DEFAULT_FEATURES}={}){
  if(typeof workspace!=='string'||!path.isAbsolute(workspace)||workspace.includes('\0')||fs.realpathSync(workspace)!==path.resolve(workspace)||!fs.lstatSync(workspace).isDirectory())throw Error('Configured canonical research workspace required');
  let current=path.parse(workspace).root;for(const part of path.relative(current,workspace).split(path.sep).filter(Boolean)){current=path.join(current,part);if(fs.lstatSync(current).isSymbolicLink())throw Error('Baseline workspace symlink denied');}
  if(!Array.isArray(approvedFiles)||!approvedFiles.length||approvedFiles.length>LIMITS.files)throw Error('Bounded approved baseline files required');
  const identity=fs.lstatSync(workspace);this.workspace=workspace;this.workspaceIdentity=Object.freeze({dev:identity.dev,ino:identity.ino});this.files=approvedFiles.map(file=>{const f=typeof file==='string'?{path:file,kind:file.endsWith('.md')?'document':'implementation'}:file;if(!f||!exactKeys(f,['path','kind'])||!['document','implementation'].includes(f.kind))throw Error('Invalid approved baseline file');return freeze({path:approvedPath(f.path),kind:f.kind});});
  if(new Set(this.files.map(f=>f.path)).size!==this.files.length)throw Error('Duplicate baseline paths denied');this.features=featureSpecs(features);this.git=resolveGitExecutable();freeze(this.files);freeze(this.features);Object.freeze(this);
 }
 workspaceCurrent(){let current=path.parse(this.workspace).root;for(const part of path.relative(current,this.workspace).split(path.sep).filter(Boolean)){current=path.join(current,part);const stat=fs.lstatSync(current);if(stat.isSymbolicLink()||!stat.isDirectory())throw Error('Configured baseline workspace changed');}const stat=fs.lstatSync(this.workspace);if(stat.dev!==this.workspaceIdentity.dev||stat.ino!==this.workspaceIdentity.ino)throw Error('Configured baseline workspace changed');}
 gitRead(args){this.workspaceCurrent();const r=spawnSync(this.git,['-c','core.fsmonitor=false','-c','core.hooksPath=/dev/null',...args],{cwd:this.workspace,encoding:'utf8',timeout:5000,maxBuffer:100000,env:{PATH:path.dirname(this.git)+':/usr/bin:/bin',GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1',GIT_OPTIONAL_LOCKS:'0',GIT_TERMINAL_PROMPT:'0'}});if(r.status!==0)throw Error('Research repository identity unavailable');return r.stdout;}
 derive(evidence,sources){
  return this.features.map(f=>{
   const docs=evidence.filter(e=>e.kind==='document'&&f.docs.includes(e.path)),code=evidence.filter(e=>e.kind==='implementation'&&f.code.includes(e.path));
   const docText=docs.map(e=>sources.get(e.path)).join('\n'),codeText=code.map(e=>sources.get(e.path)).join('\n');
   const refs=[...docs,...code].map(e=>e.id);let status='unknown',reason='Approved baseline does not establish this feature or its absence.';
   if(docs.length&&code.length&&f.negative?.test(docText)&&f.codeNegative?.test(codeText)){status='lacks';reason='Canonical documentation explicitly excludes this capability; implementation evidence supports that narrow exclusion.';}
   else if(docs.length&&code.length&&f.match?.test(docText)&&f.match?.test(codeText)&&/^.{0,25}Status.{0,200}(?:implemented|shipped|✓)|^\*\*Shipment.{0,200}shipped|\bSHIPPED ON MAIN\b/im.test(docText)&&!/\bnot\s+(?:implemented|shipped)\b/i.test(docText)&&/\bexport\s+(?:default\s+)?(?:async\s+)?(?:function|const|class)|export\s*\{/i.test(codeText)){
    status=f.partial?.test(docText)?'partial':'already_has';reason=status==='partial'?'Documented foundation has implementation evidence and explicit capability/activation limits.':'Canonical feature documentation and implementation are present in this checkout; runtime or production availability is not established.';
   }else if(docs.length||code.length){status='partial';reason='Only bounded documentation or implementation evidence is available; completeness and live availability remain unknown.';}
   return {id:f.id,label:f.label,status,refs,reason};
  });
 }
 dirtyPaths(){const status=this.gitRead(['status','--porcelain=v1','-z','--untracked-files=normal','--',...this.files.map(f=>f.path)]),dirty=new Set();for(const row of status.split('\0').filter(Boolean))dirty.add(row.slice(3));return dirty;}
 capture(){
  const head=this.gitRead(['rev-parse','--verify','HEAD']).trim();if(!/^[a-f0-9]{40,64}$/.test(head))throw Error('Invalid research repository HEAD');
  const dirty=this.dirtyPaths();
  const evidence=[],unavailable=[],sources=new Map();let total=0;
  for(const file of this.files){let data;try{data=fileRead(this.workspace,file.path);}catch{unavailable.push({path:file.path,reason:'source_boundary_denied'});continue;}if(!data||data.excluded){unavailable.push({path:file.path,reason:data?.excluded||'not_present'});continue;}total+=data.bytes;if(total>LIMITS.totalBytes)throw Error('Baseline total source bounds exceeded');sources.set(file.path,data.text);evidence.push({id:randomUUID(),...file,sha256:data.sha256,...excerpt(data.text),dirty:dirty.has(file.path)});}
  if(this.gitRead(['rev-parse','--verify','HEAD']).trim()!==head)throw Error('Research repository changed during capture');
  const core={version:1,id:randomUUID(),project:'Arecibo',head,evidence,unavailable,features:this.derive(evidence,sources),authority:false};sources.clear();const snapshot=freeze({...core,digest:hash(core)});this.verify(snapshot);return snapshot;
 }
 workspaceSnapshot(snapshot){
  const current=snapshot||this.capture();this.verify(current);
  const files=Object.fromEntries([...current.evidence].sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0).map(e=>[e.path,e.sha256]));
  const dirty=[...this.dirtyPaths()].filter(name=>this.files.some(f=>f.path===name)).sort();
  const unavailable=[...current.unavailable].sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
  const core={version:1,scope:'approved_research_sources',head:current.head,files,dirty,unavailable,authority:false};this.verify(current);if(JSON.stringify([...this.dirtyPaths()].filter(name=>this.files.some(f=>f.path===name)).sort())!==JSON.stringify(dirty))throw Error('Scoped workspace changed during verification');return freeze({...core,hash:hash(core)});
 }
 verify(snapshot){
  if(!exactKeys(snapshot,['version','id','project','head','evidence','unavailable','features','authority','digest'])||snapshot.version!==1||snapshot.project!=='Arecibo'||snapshot.authority!==false||!UUID.test(snapshot.id)||!SHA.test(snapshot.digest)||! /^[a-f0-9]{40,64}$/.test(snapshot.head)||!Array.isArray(snapshot.evidence)||!Array.isArray(snapshot.unavailable)||!Array.isArray(snapshot.features)||snapshot.evidence.length+snapshot.unavailable.length!==this.files.length)throw Error('Invalid baseline provenance');
  const {digest,...core}=snapshot;if(hash(core)!==digest||this.gitRead(['rev-parse','--verify','HEAD']).trim()!==snapshot.head)throw Error('Baseline evidence is stale or mutated');
  const sources=new Map(),seen=new Set(),ids=new Set(),dirty=this.dirtyPaths();
  for(const item of snapshot.evidence){const approved=this.files.find(f=>f.path===item?.path);if(!exactKeys(item,['id','path','kind','sha256','excerpt','lines','dirty'])||!approved||approved.kind!==item.kind||seen.has(item.path)||ids.has(item.id)||!UUID.test(item.id)||!SHA.test(item.sha256)||item.dirty!==dirty.has(item.path)||!exactKeys(item.lines,['start','end']))throw Error('Unapproved baseline evidence');seen.add(item.path);ids.add(item.id);const data=fileRead(this.workspace,item.path);if(!data||data.excluded||data.sha256!==item.sha256||JSON.stringify(excerpt(data.text))!==JSON.stringify({excerpt:item.excerpt,lines:item.lines}))throw Error('Baseline evidence changed');sources.set(item.path,data.text);}
  for(const item of snapshot.unavailable){if(!exactKeys(item,['path','reason'])||!this.files.some(f=>f.path===item.path)||seen.has(item.path))throw Error('Unapproved baseline omission');seen.add(item.path);let data;try{data=fileRead(this.workspace,item.path);}catch{data={excluded:'source_boundary_denied'};}if((data?.excluded||(!data?'not_present':null))!==item.reason)throw Error('Baseline availability changed');}
  if(JSON.stringify(this.derive(snapshot.evidence,sources))!==JSON.stringify(snapshot.features))throw Error('Baseline feature claims mutated');sources.clear();if(this.gitRead(['rev-parse','--verify','HEAD']).trim()!==snapshot.head)throw Error('Baseline repository changed during verification');return true;
 }
}
module.exports={ResearchBaseline,DEFAULT_FILES,DEFAULT_FEATURES,LIMITS,unsafeText,unsafeEvidenceText,hash};
