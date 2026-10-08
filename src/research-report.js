'use strict';
// Deterministic research interpretation. Evidence is reference data, never
// instructions, execution authority, approval or an implementation plan.
const {randomUUID}=require('node:crypto');
const path=require('node:path');
const {unsafeText,unsafeEvidenceText,hash}=require('./research-baseline');
const {ResearchNetwork,MAX_DOWNLOAD_BYTES}=require('./research-network');
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SHA=/^[a-f0-9]{64}$/;
const MAX_MARKDOWN=12000;
const PRIVATE_CATEGORIES=Object.freeze(['dashboard','projects','settings','billing','team','integrations','activity','analytics','documentation','support','profile','transactions','accounts','balances','cashflow','forecasts','expenses','budgets','reconciliation','reports','payments','goals','recurring','insights']);
const SURVEY_AREAS=Object.freeze([
 {id:'homepage',label:'Homepage and marketing',signal:/marketing|business|platform|product/i,path:/^\/$/},
 {id:'features',label:'Product features',signal:/features?|capabilit|cash.?flow|forecast|budget|expense/i,path:/features?|products?/i},
 {id:'pricing',label:'Pricing plans',signal:/pricing|plans?|(?:CAD|USD|EUR|GBP|[$€£])\s*\d/i,path:/pricing|plans?/i},
 {id:'onboarding',label:'Registration and onboarding',signal:/sign up|signup|register|registration|onboarding|create.{0,12}account/i,path:/signup|register|onboard/i},
 {id:'dashboard',label:'Dashboard and navigation',signal:/dashboard|command center|navigation/i,path:/dashboard/i,privateCategory:'dashboard'},
 {id:'financial_tools',label:'Transactions and financial tools',signal:/transactions?|financial tools?|ledger|cash.?flow|forecast|reconcil/i,privateCategories:['transactions','accounts','balances','cashflow','forecasts','expenses','budgets','reconciliation','payments']},
 {id:'analytics',label:'Analytics and reporting',signal:/analytics|reports?|reporting/i,path:/analytics|reports?/i,privateCategories:['analytics','reports']},
 {id:'integrations',label:'Integrations',signal:/integrations?|connect.{0,20}banks?|open banking/i,path:/integrations?/i,privateCategory:'integrations'},
 {id:'settings',label:'Settings',signal:/settings|preferences/i,path:/settings/i,privateCategory:'settings'},
 {id:'mobile',label:'Mobile and responsive',signal:/mobile|responsive/i},
 {id:'help',label:'Help and documentation',signal:/documentation|help center|support|frequently asked|\bFAQ\b/i,path:/docs?|help|support/i,privateCategory:'documentation'}
].map(Object.freeze));
const NAV_FEATURES=Object.freeze({cashflow:['cashflow'],transactions:['transactions'],forecast:['forecasts'],budgeting:['budgets'],expense_management:['expenses']});
const FEATURE_SIGNALS=Object.freeze({
 cashflow:/cash[ -]?flow|cash position|cash movement/i,
 transactions:/transactions?|ledger|transaction explorer/i,
 forecast:/forecast|cash runway|future cash/i,
 reconciliation:/reconcil/i,
 data_quality:/data quality|data freshness|confidence score/i,
 merchant_dashboard:/merchant dashboard|command center|financial dashboard|finance dashboard/i,
 bank_connections:/bank connections?|connect.{0,25}bank|linked accounts?|open banking/i,
 finance_copilot:/financial (?:assistant|copilot)|finance (?:assistant|copilot)|AI[ -](?:powered )?(?:financial|finance)/i,
 conversational_finance:/financial chat|chat.{0,25}financ|ask.{0,20}(?:your|my).{0,20}(?:finances|cashflow|cash flow)/i,
 assistant_payments:/assistant.{0,35}(?:send|execute|make).{0,20}payments|AI.{0,25}payment execution/i,
 automated_payments:/automated payments|bill pay|pay bills|payment automation/i,
 budgeting:/budget(?:ing|s| planning)?/i,
 expense_management:/expense management|expense tracking|reimbursement/i
});
const freeze=value=>{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;};
const markdown=value=>String(value??'').replace(/[\u0000-\u001f\u007f-\u009f]/g,' ').replace(/([\\`*_{}\[\]<>|])/g,'\\$1');
function safeURL(value){
 if(typeof value!=='string'||value.length>2000||/[\u0000-\u0020\u007f]/.test(value)||unsafeEvidenceText(value))throw Error('Unsafe research URL');
 let url;try{url=new URL(value);}catch{throw Error('Invalid research URL');}
 if(!['https:','http:'].includes(url.protocol)||url.username||url.password||[...url.searchParams.keys()].some(k=>/token|secret|password|credential|signature|auth|api.?key|^code$/i.test(k)))throw Error('Unsafe research URL');
 return url.href;
}
function label(value,maximum=120){if(typeof value!=='string'||!value.trim()||value.length>maximum||unsafeText(value))throw Error('Invalid research label');return value.trim();}
function checkedReceipt(row){
 if(!row||!UUID.test(row.id)||!SHA.test(row.sha256)||row.untrusted!==true||row.authority!==false||!row.evidence_ref||row.evidence_ref.id!==row.id||!SHA.test(row.evidence_ref.sha256))throw Error('Host-verified browser evidence required');
 const url=safeURL(row.url),text=row.text??row.content;
 if(typeof text!=='string'||text.length>(row.download_ref?MAX_DOWNLOAD_BYTES:24000)||row.download_ref&&Buffer.byteLength(text)>MAX_DOWNLOAD_BYTES||hash(text)!==row.sha256||unsafeEvidenceText(text)||row.content!==undefined&&row.content!==text||row.title!==undefined&&(typeof row.title!=='string'||row.title.length>600||unsafeEvidenceText(row.title)))throw Error('Browser research content integrity denied');
 if(!['observed','inaccessible'].includes(row.classification)||row.classification==='inaccessible'&&(text!==''||!['blocked','authentication_required','human_takeover_required'].includes(row.state)||row.screenshot_ref))throw Error('Invalid browser evidence classification');
 if(row.screenshot_ref&&(!UUID.test(row.screenshot_ref.id)||!SHA.test(row.screenshot_ref.sha256)||row.screenshot_ref.mimeType!=='image/png'))throw Error('Invalid screenshot evidence');
 if(row.download_ref&&(row.download_ref.id!==row.id||row.download_ref.sha256!==row.sha256||!['text/plain','text/csv','application/json'].includes(row.download_ref.mimeType)||row.private_context||row.state!=='downloaded'||row.classification!=='observed'||row.title!=='Public text download'||row.screenshot_ref||!Array.isArray(row.forms)||row.forms.length||!Array.isArray(row.links)||row.links.length))throw Error('Public download evidence boundary denied');
 if(row.state==='downloaded'&&!row.download_ref)throw Error('Download artifact provenance required');
 if(row.private_context!==undefined&&row.private_context!==true)throw Error('Invalid private evidence boundary');
 if(row.private_context===true){
  if(new URL(url).pathname!=='/'||new URL(url).search||new URL(url).hash||!SHA.test(row.source_url_sha256)||row.screenshot_ref)throw Error('Private account evidence boundary denied');
  if(row.classification==='observed'&&(!Array.isArray(row.categories)||row.categories.length>PRIVATE_CATEGORIES.length||new Set(row.categories).size!==row.categories.length||row.categories.some(id=>!PRIVATE_CATEGORIES.includes(id))||text!=='Verified account navigation categories: '+row.categories.join(', ')||row.title!=='Authorized account navigation'||!Array.isArray(row.forms)||row.forms.length||!Array.isArray(row.links)||row.links.some(link=>Object.keys(link).some(k=>!['id','category'].includes(k))||!UUID.test(link.id)||!row.categories.includes(link.category))))throw Error('Private account evidence boundary denied');
  if(row.classification==='inaccessible'&&(row.title!==''||row.categories!==undefined||row.forms?.length||row.links?.length||row.login_forms!==undefined&&(row.state!=='authentication_required'||!Array.isArray(row.login_forms)||row.login_forms.length>5||row.login_forms.some(f=>Object.keys(f).some(k=>!['id','fields'].includes(k))||!UUID.test(f.id)||!Array.isArray(f.fields)||f.fields.length!==2||new Set(f.fields.map(v=>v.type)).size!==2||f.fields.some(v=>Object.keys(v).some(k=>!['id','type'].includes(k))||!UUID.test(v.id)||!['username','password'].includes(v.type))))))throw Error('Private login evidence boundary denied');
 }
 return {row,url,text};
}
function competitorIdentity(value,evidence){
 if(typeof value==='string'&&/^https?:\/\//i.test(value)){const url=safeURL(value);return {name:new URL(url).hostname,url};}
 if(typeof value==='string')return {name:label(value),url:evidence[0]?.url||null};
 if(value&&typeof value==='object'&&Object.keys(value).every(k=>['name','url'].includes(k))){const url=value.url?safeURL(value.url):evidence[0]?.url||null;return {name:label(value.name||new URL(url).hostname),url};}
 if(evidence.length)return {name:new URL(evidence[0].url).hostname,url:evidence[0].url};
 throw Error('Bounded competitor identity required');
}
// This boundary is for the already independently verified operator report only.
// Generic audit/transport redaction must not use it. The sealed Mission scope,
// never a URL supplied by the report itself, controls every public citation.
const RESPONSE_KEYS=new Set(('mission_id markdown report screenshots accepted authority version id competitor name url baseline head digest unavailable_count sections references screenshot_refs download_refs automatic_implementation estimates_only coverage downloads overview observed documented inferred inaccessible pricing positioning comparison recommendations not_worth_copying label classification reason evidence_refs description evidence_id download_ref pages_captured captures private_navigation_captures pages_inaccessible baseline_head baseline_scope categories feature_id feature status competitor_classification competitor_refs baseline_refs evidence_ids claims currency limitations priority title complexity estimate effort_days min max amount assumed_day_rate basis security compliance infrastructure_impact fixed_incremental_cost compute_and_storage vendor_fees kind path lines start end sha256 dirty evidence_type private_context source_url_sha256 evidence_ref screenshot_ref mimeType viewport width height').split(' '));
const HOST_PATH=/(?:^|[\s"'`(<])(?:\/(?:Users|home|private|tmp|var|etc|opt|Volumes)(?:\/|\b)|[A-Za-z]:[\\/]|file:\/\/)/i;
function projectResearchResponse(response,{scope}={}){
 const network=new ResearchNetwork({scope}),originRoots=new Set([...network.origins].map(origin=>origin+'/'));
 if(!response||typeof response!=='object'||Array.isArray(response)||!UUID.test(response.mission_id||'')||response.authority!==false||typeof response.markdown!=='string'||response.markdown.length>MAX_MARKDOWN||!response.report||typeof response.report!=='object'||Array.isArray(response.report)||response.report.authority!==false||response.report.automatic_implementation===true||response.report.estimates_only===false)throw Error('Verified operator research response required');
 if(response.report.markdown!==undefined&&response.report.markdown!==response.markdown||response.report.digest!==undefined&&(response.report.digest!==hash(response.markdown)||!SHA.test(response.report.digest)))throw Error('Research response report integrity denied');
 const urls=new Set(originRoots),refs=response.report.references||[];
 if(!Array.isArray(refs)||refs.length>71)throw Error('Bounded research response references required');
 for(const ref of refs){
  if(ref?.kind!=='website')continue;
  if(!UUID.test(ref.id||'')||!SHA.test(ref.sha256||'')||!['observed','inaccessible'].includes(ref.classification))throw Error('Verified website reference required');
  const url=network.validate(ref.url);
  if(ref.private_context!==undefined&&(ref.private_context!==true||!originRoots.has(url)||ref.screenshot_ref||ref.categories!==undefined&&(!Array.isArray(ref.categories)||ref.categories.some(category=>!PRIVATE_CATEGORIES.includes(category)))))throw Error('Private research response boundary denied');
  urls.add(url);
 }
 const competitor=response.report.competitor;
 if(competitor?.url){const url=network.validate(competitor.url);if(!urls.has(url))throw Error('Competitor citation provenance denied');}
 const provenance=new Set();
 for(const item of [response.report.baseline,...refs,...(response.report.screenshot_refs||[]),...(response.report.download_refs||[])])for(const name of ['id','head','sha256','digest'])if(typeof item?.[name]==='string'&&(UUID.test(item[name])||/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(item[name])))provenance.add(item[name]);
 let nodes=0;
 function project(value,key='',depth=0){
  if(++nodes>6000||depth>12)throw Error('Bounded research response required');
  if(value===null||typeof value==='boolean')return value;
  if(typeof value==='number'){if(!Number.isFinite(value))throw Error('Invalid research response number');return value;}
  if(typeof value==='string'){
   // Verified fixed-format provenance digests can contain digit runs which are
   // deliberately rejected as account numbers in free-form content.
   if(['sha256','digest','source_url_sha256'].includes(key)){if(!SHA.test(value))throw Error('Research response digest denied');return value;}
   if(['head','baseline_head'].includes(key)){if(!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value))throw Error('Research response repository identity denied');return value;}
   if(['mission_id','id','evidence_id','evidence_refs','evidence_ids','competitor_refs','baseline_refs'].includes(key)&&UUID.test(value))return value;
   let inspected=value;if(key==='markdown')for(const token of provenance)inspected=inspected.split(token).join('verified provenance');
   if(value.length>(key==='markdown'?MAX_MARKDOWN:8192)||/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(value)||unsafeEvidenceText(inspected)||HOST_PATH.test(value))throw Error('Private or unsafe research response content denied ('+key+')');
   if(key==='path'){
    if(path.isAbsolute(value)||/^[A-Za-z]:[\\/]/.test(value))return undefined;
    if(value.includes('\\')||value.split('/').some(part=>!part||part==='.'||part==='..')||/(?:^|[/. _-])(?:env|secret|password|credential|keychain|vault)(?:[/. _-]|$)/i.test(value))throw Error('Research source path boundary denied');
   }
   const citations=value.match(/https?:\/\/[^\s<>"'`]+/gi)||[];
   for(let citation of citations){if(key!=='url'&&!urls.has(citation))citation=citation.replace(/[)\],.;]+$/,'');const url=network.validate(citation);if(!urls.has(url))throw Error('Unverified research citation denied');}
   if(key==='url'&&(network.validate(value)!==value||!urls.has(value)))throw Error('Research citation scope denied');
   return value;
  }
  if(Array.isArray(value)){
   if(value.length>128||key==='categories'&&(new Set(value).size!==value.length||value.some(category=>!PRIVATE_CATEGORIES.includes(category))))throw Error('Bounded research response array required');
   return value.map(item=>project(item,key,depth+1));
  }
  if(!value||typeof value!=='object'||![Object.prototype,null].includes(Object.getPrototypeOf(value)))throw Error('Plain research response data required');
  const result={};
  for(const [name,child]of Object.entries(value)){
   // Explicit safe schema drops credential/private fields and host artifact paths.
   if(!RESPONSE_KEYS.has(name)||name==='path'&&typeof child==='string'&&(path.isAbsolute(child)||/^[A-Za-z]:[\\/]/.test(child)))continue;
   const safe=project(child,name,depth+1);if(safe!==undefined)result[name]=safe;
  }
  return result;
 }
 const result=project({mission_id:response.mission_id,markdown:response.markdown,report:response.report,screenshots:response.screenshots||[],accepted:response.accepted===true,authority:false});
 if(Buffer.byteLength(JSON.stringify(result))>262144)throw Error('Research response size exceeded');
 return freeze(result);
}
function surveyCoverage(accessible,privateRecords,blocked){
 return SURVEY_AREAS.map(area=>{
  const menuCategories=area.privateCategories||[area.privateCategory].filter(Boolean),navigation=privateRecords.filter(e=>menuCategories.some(id=>e.row.categories.includes(id)));
  const rendered=area.path?accessible.filter(e=>area.path.test(new URL(e.url).pathname)):[];
  const documented=accessible.filter(e=>area.signal.test(e.text));
  const responsive=area.id==='mobile'?accessible.filter(e=>accessible.some(other=>other.url===e.url&&e.row.viewport?.width<600&&other.row.viewport?.width>=1024)):[];
  const observed=[...rendered,...navigation,...responsive];let classification='inaccessible',reason='Not established by captured evidence; no missing capability is asserted.',sources=[];
  if(observed.length){classification='observed';sources=observed;reason=navigation.length?'Only a fixed account navigation label was observed; functionality and private content were not inspected.':responsive.length?'Public pages were captured at desktop and mobile widths; usability and responsive correctness remain unverified.':'A public page for this area rendered; functionality, account flows and marketing claims remain unverified.';}
  else if(documented.length){classification='documented';sources=documented;reason='Captured public text mentions this area; behavior and account availability remain unverified.';}
  else if(area.id==='onboarding'&&blocked.length){sources=blocked;reason='Authentication or sensitive-content boundary prevented inspection; registration and onboarding were not tested.';}
  return {id:area.id,label:area.label,classification,reason,evidence_refs:[...new Set(sources.map(e=>e.row.id))].slice(0,1)};
 });
}
class ResearchReport {
 constructor({baseline,evidenceStore,estimateDayRate=1000,estimateCurrency='CAD'}={}){
  if(!baseline||typeof baseline.capture!=='function'||typeof baseline.verify!=='function'||!evidenceStore||typeof evidenceStore.verify!=='function')throw Error('Host baseline and evidence verifier required');
  if(!Number.isFinite(estimateDayRate)||estimateDayRate<0||estimateDayRate>100000||!['CAD','USD','EUR'].includes(estimateCurrency))throw Error('Invalid host planning estimate');
  this.baseline=baseline;this.evidenceStore=evidenceStore;this.estimateDayRate=estimateDayRate;this.estimateCurrency=estimateCurrency;Object.freeze(this);
 }
 async build(input={}){
  if(Object.keys(input).some(k=>!['competitor','evidence','baselineSnapshot','features'].includes(k))||!Array.isArray(input.evidence)||input.evidence.length>39)throw Error('Bounded research report input required');
  const snapshot=input.baselineSnapshot||this.baseline.capture();this.baseline.verify(snapshot);
  const seen=new Set(),records=[];
  for(const row of input.evidence){const record=checkedReceipt(row);if(seen.has(row.id))throw Error('Duplicate browser evidence');seen.add(row.id);if(await this.evidenceStore.verify(row)!==true)throw Error('Browser evidence verification denied');records.push(record);}
  const competitor=competitorIdentity(input.competitor,records),downloads=records.filter(e=>e.row.download_ref),accessible=records.filter(e=>e.row.classification==='observed'&&!e.row.private_context&&!e.row.download_ref),privateRecords=records.filter(e=>e.row.private_context===true&&e.row.classification==='observed'),blocked=records.filter(e=>e.row.classification==='inaccessible');
  if(downloads.length>3||records.length-downloads.length>36)throw Error('Bounded navigation and download receipt limits exceeded');
  if(new Set(accessible.map(e=>e.url)).size>12)throw Error('Research public page bound exceeded');
  let requested=input.features;
  if(requested!==undefined&&(!Array.isArray(requested)||requested.length>12||requested.some(id=>typeof id!=='string'||!FEATURE_SIGNALS[id])))throw Error('Unknown research feature category');
  const categories=[...new Set(requested||Object.keys(FEATURE_SIGNALS).filter(id=>accessible.some(e=>FEATURE_SIGNALS[id].test(e.text))||privateRecords.some(e=>(NAV_FEATURES[id]||[]).some(c=>e.row.categories.includes(c)))))].slice(0,10);
  const findings=categories.map(id=>{
   const seenURLs=new Set(),sources=accessible.filter(e=>{if(!FEATURE_SIGNALS[id].test(e.text)||seenURLs.has(e.url))return false;seenURLs.add(e.url);return true;}).slice(0,2);
   const navigation=privateRecords.filter(e=>(NAV_FEATURES[id]||[]).some(c=>e.row.categories.includes(c))).slice(0,2),known=snapshot.features.find(f=>f.id===id);
   return {id,label:known?.label||id.replaceAll('_',' '),classification:navigation.length?'observed':sources.length?'documented':'inaccessible',evidence_ids:(navigation.length?navigation:sources).map(e=>e.row.id),description:navigation.length?'Only the associated account navigation label was observed; functional capability and financial content remain unverified.':sources.length?'Captured public text mentions this capability; functional behavior and account availability were not verified.':'This category was requested but was not established by the captured public evidence.'};
  });
  const comparison=findings.map(f=>{const base=snapshot.features.find(b=>b.id===f.id);return {feature_id:f.id,feature:f.label,competitor_classification:f.classification,status:f.classification==='documented'?base?.status||'unknown':'unknown',reason:f.classification==='inaccessible'?'Competitor capability was not established, so no gap is asserted.':f.classification==='observed'?'Competitor navigation label only; functionality is unverified. '+(base?.reason||'Arecibo coverage is unknown.'):base?.reason||'Approved baseline does not establish this feature or its absence.',competitor_refs:f.evidence_ids,baseline_refs:base?.refs||[]};});
  const prices=[],seenPrices=new Set();
  for(const e of accessible)for(const line of e.text.split(/\r?\n/))if(/(?:[$€£]\s*\d|\b(?:CAD|USD|EUR|GBP)\s*\d|\d\s*(?:CAD|USD|EUR|GBP)\b)/i.test(line)&&!unsafeEvidenceText(line)&&prices.length<5&&!seenPrices.has(e.url+'|'+line.trim())){seenPrices.add(e.url+'|'+line.trim());prices.push({text:line.trim().slice(0,150),classification:'documented',evidence_id:e.row.id,currency:/\bCAD\b/i.test(line)?'CAD':/\bUSD\b/i.test(line)?'USD':/€|\bEUR\b/i.test(line)?'EUR':'unknown'});}
  const budget=(min,max)=>({classification:'estimate',effort_days:{min,max},currency:this.estimateCurrency,amount:{min:min*this.estimateDayRate,max:max*this.estimateDayRate},assumed_day_rate:this.estimateDayRate,basis:'Illustrative engineering planning assumption, not a vendor quote or approved budget; excludes external fees and ongoing operation.'});
  const recommendations=[{priority:'P0',title:'Validate evidence and access limitations before changing Arecibo',complexity:'low',estimate:budget(1,3),security:'Use public read-only evidence; do not bypass authentication, authorize accounts or send private repository data.',compliance:'Confirm consent, retention and applicable privacy/product boundaries with the responsible owner; no compliance certification is implied.',evidence_refs:[...accessible.slice(0,1),...blocked.slice(0,1)].map(e=>e.row.id),automatic_implementation:false}];
  for(const item of comparison.slice(0,4)){
   const unknown=item.status==='unknown',present=item.status==='already_has',unsupported=item.feature_id==='assistant_payments';
   recommendations.push({priority:unknown?'P0':present||unsupported?'P2':'P1',title:unknown?'Verify Arecibo coverage for '+item.feature:present?'Compare and polish the existing '+item.feature:unsupported?'Keep assistant payment execution outside current authority':'Evaluate a bounded extension of '+item.feature,complexity:unknown||present?'low':unsupported?'high':'medium',estimate:budget(unknown||present?1:5,unknown||present?3:15),security:'Retain tenant scope, permission/consent checks, erasure, verified provenance and qualification; any later data egress or execution needs its own review.',compliance:'Review financial-product and privacy implications before implementation; captured competitor claims are not permission or proof of compliance.',evidence_refs:[...item.competitor_refs,...item.baseline_refs],automatic_implementation:false});
  }
  for(const r of recommendations){const existing=/^Validate|^Verify|^Compare and polish/.test(r.title);r.infrastructure_impact={classification:'rough planning assumption',fixed_incremental_cost:existing?'No new fixed infrastructure is assumed if existing UI, services and evidence storage are reused.':'Unknown; no new infrastructure or vendor charge has been established.',compute_and_storage:existing?'Bounded local evidence and existing storage; measured utilization is unknown.':'Additional aggregation, storage or integration load requires measurement; magnitude is unknown.',vendor_fees:'Unknown unless separately established by verified current vendor pricing.',basis:'Scope-dependent assumption, not a measured workload, price quote or approved budget.'};}
  const coverage=surveyCoverage(accessible,privateRecords,blocked);
  const baselineRefs=snapshot.evidence.map(e=>({id:e.id,kind:e.kind,path:e.path,lines:e.lines,sha256:e.sha256,dirty:e.dirty,head:snapshot.head})),webRefs=records.map(e=>({id:e.row.id,kind:'website',url:e.url,title:e.row.title||new URL(e.url).hostname,sha256:e.row.sha256,classification:e.row.classification,...(e.row.download_ref?{evidence_type:'download',download_ref:{id:e.row.download_ref.id,sha256:e.row.download_ref.sha256,mimeType:e.row.download_ref.mimeType}}:{}),...(e.row.private_context?{private_context:true,...(e.row.classification==='observed'?{categories:[...e.row.categories]}:{}),source_url_sha256:e.row.source_url_sha256}:{}),evidence_ref:{id:e.row.evidence_ref.id,sha256:e.row.evidence_ref.sha256},...(e.row.screenshot_ref?{screenshot_ref:{id:e.row.screenshot_ref.id,sha256:e.row.screenshot_ref.sha256,mimeType:e.row.screenshot_ref.mimeType}}:{})}));
  const sections={coverage,downloads:downloads.map(e=>({classification:'observed',description:'Protected public text artifact retained and byte-hash verified; not interpreted as navigation, product functionality or pricing.',evidence_id:e.row.id,download_ref:{id:e.row.download_ref.id,sha256:e.row.download_ref.sha256,mimeType:e.row.download_ref.mimeType}})),overview:{competitor:competitor.name,pages_captured:new Set(accessible.map(e=>e.url)).size,captures:accessible.length,downloads:downloads.length,private_navigation_captures:privateRecords.length,pages_inaccessible:blocked.length,baseline_head:snapshot.head,baseline_scope:'Approved product documentation and implementation in the current checkout; this is not a live/production qualification.'},observed:accessible.map(e=>({description:'Public page rendered and captured; '+(e.row.forms?.length||0)+' forms and '+(e.row.links?.length||0)+' links observed. No account or paid flow was tested.',evidence_id:e.row.id})).concat(privateRecords.map(e=>({description:'Authorized account navigation labels observed: '+e.row.categories.join(', ')+'. No private content or functional capability was retained.',categories:[...e.row.categories],evidence_id:e.row.id}))),documented:findings.filter(f=>f.classification==='documented'),inferred:[{classification:'inferred',description:findings.some(f=>f.classification==='documented')?'The captured capability claims suggest a focus on '+findings.filter(f=>f.classification==='documented').map(f=>f.label).slice(0,4).join(', ')+'. This positioning is an interpretation, not a verified capability.':'Insufficient public evidence to infer product positioning.',evidence_refs:accessible.map(e=>e.row.id)}],inaccessible:blocked.map(e=>({classification:'inaccessible',reason:'A public/authentication boundary prevented access; no gated content was retained.',evidence_id:e.row.id})).concat(findings.filter(f=>f.classification==='inaccessible')),pricing:{claims:prices,limitations:prices.length?'Captured public pricing claims only. Effective currency, billing cadence, taxes and purchase availability require confirmation.':'No price was established by captured public evidence; no monetary comparison is asserted.'},positioning:{classification:'inferred',description:'Compare the documented outcomes against Arecibo’s approved product scope; marketing claims do not establish operational completeness.'},comparison,recommendations,not_worth_copying:[{description:'Bypassing login, consent, anti-bot or paid-access boundaries to fill evidence gaps.',evidence_refs:blocked.map(e=>e.row.id)},{description:'Model-granted financial actions, automatic account authorization or private-ledger disclosure; each would require a separate approved authority/privacy decision.',evidence_refs:snapshot.features.filter(f=>['finance_copilot','assistant_payments'].includes(f.id)).flatMap(f=>f.refs)},{description:'Rebuilding an existing Arecibo capability solely to imitate a competitor’s branding or public claim.',evidence_refs:comparison.filter(c=>c.status==='already_has').flatMap(c=>c.baseline_refs)}]};
  const references=[...webRefs,...baselineRefs],refLabels=new Map(references.map((e,i)=>[e.id,e.kind==='website'?'E'+(webRefs.indexOf(e)+1):'B'+(baselineRefs.indexOf(e)+1)]));
  const cite=ids=>[...new Set(ids)].map(id=>{const e=webRefs.find(r=>r.id===id),name=refLabels.get(id);return name?(e?'['+name+'](<'+e.url+'>)':'['+name+'](#'+name.toLowerCase()+')'):'';}).filter(Boolean).join(' ');
  let lines=[`# ${markdown(competitor.name)} — competitor research`, `Arecibo baseline HEAD: ${snapshot.head}. ${sections.overview.pages_captured} captured public pages; ${blocked.length} inaccessible captures; ${privateRecords.length} sanitized private navigation captures. Current checkout evidence; no production qualification.`, '## Survey coverage',...coverage.map(c=>'- '+c.label+' — '+c.classification+'. '+(c.reason.startsWith('Only a fixed')?'Account navigation label only.':c.reason.startsWith('Public pages were captured')?'Desktop/mobile captures; usability unverified.':c.classification==='observed'?'Public page rendered; functionality unverified.':c.classification==='documented'?'Public claim; functionality unverified.':'Not established; no missing capability asserted.')+' '+cite(c.evidence_refs)),'## Observed / documented / inferred / inaccessible',...sections.observed.slice(0,5).map(f=>'- Observed: '+f.description+' '+cite([f.evidence_id])),...findings.map(f=>'- '+f.classification+': '+markdown(f.label)+'. '+f.description+' '+cite(f.evidence_ids)),...sections.inaccessible.filter(f=>f.evidence_id).slice(0,3).map(f=>'- Inaccessible: '+f.reason+' '+cite([f.evidence_id])),'- Inferred positioning: '+markdown(sections.inferred[0].description),'## Pricing and positioning',...prices.map(p=>'- Documented price claim: '+markdown(p.text)+' (currency: '+p.currency+'). '+cite([p.evidence_id])),sections.pricing.limitations,sections.positioning.description,'## Arecibo comparison',...comparison.map(c=>'- **'+markdown(c.feature)+' — '+c.status.replaceAll('_',' ')+'**. '+c.reason+' '+cite([...c.competitor_refs,...c.baseline_refs])),'## Recommendations — estimates only',`Cost assumption: ${this.estimateCurrency} ${this.estimateDayRate}/engineer-day, illustrative only; excludes vendor fees and operation. No budget or implementation is authorized.`,...recommendations.map(r=>'- **'+r.priority+': '+markdown(r.title)+'**. Complexity: '+r.complexity+'. Estimate: '+r.estimate.effort_days.min+'–'+r.estimate.effort_days.max+' engineer-days; '+r.estimate.currency+' '+r.estimate.amount.min+'–'+r.estimate.amount.max+'. Infrastructure (rough assumption): '+(r.infrastructure_impact.fixed_incremental_cost.startsWith('No new fixed')?'Reuse existing services; no fixed increase assumed; utilization and vendor fees unmeasured.':'Incremental compute/storage and vendor fees unknown; measure before budgeting.')+'. Security: '+r.security+' Compliance: '+r.compliance+' '+cite(r.evidence_refs)),'## Not worth copying',...sections.not_worth_copying.map(r=>'- '+r.description+' '+cite(r.evidence_refs)),'## Protected public downloads',...sections.downloads.map(d=>'- '+d.description+' '+cite([d.evidence_id])),'## Evidence and screenshots'];
  const used=new Set([...comparison.flatMap(c=>[...c.competitor_refs,...c.baseline_refs]),...prices.map(p=>p.evidence_id),...records.map(e=>e.row.id),...recommendations.flatMap(r=>r.evidence_refs),...sections.not_worth_copying.flatMap(r=>r.evidence_refs)]);
  const refURLs=new Set();const selectedRefs=references.filter(r=>{if(!used.has(r.id))return false;if(r.kind!=='website')return true;const key=r.url+'|'+r.classification+'|'+!!r.private_context+'|'+!!r.download_ref;if(refURLs.has(key))return false;refURLs.add(key);return true;});
  for(const e of selectedRefs){const name=refLabels.get(e.id);lines.push('### '+name);lines.push(e.kind==='website'?'['+markdown(e.title.slice(0,100))+'](<'+e.url+'>) · text SHA-256 '+e.sha256.slice(0,12)+'…':(markdown(e.path)+':'+e.lines.start+'–'+e.lines.end+' @ baseline HEAD · SHA-256 '+e.sha256.slice(0,12)+'…'+(e.dirty?' · uncommitted checkout content':'')));const screenshots=webRefs.filter(r=>r.url===e.url&&r.screenshot_ref).map(r=>r.screenshot_ref);if(e.download_ref)lines.push('Download ref: '+e.download_ref.id+' · '+e.download_ref.mimeType+' · byte SHA-256 '+e.download_ref.sha256+'.');if(screenshots.length)lines.push('Screenshot ref: '+screenshots[0].id+(screenshots.length>1?' (+'+(screenshots.length-1)+' verified viewport captures)':'')+'. All IDs and full digests are in structured references.');}
  let text=lines.join('\n\n');
  if(text.length>MAX_MARKDOWN){lines=lines.map(line=>line.startsWith('- **P')?line.replace(/ Security: .*? Compliance: .*?(?= \[|$)/,' Security/compliance: retain tenant scope, consent, erasure and independent review.'):line);text=lines.join('\n\n');}
  if(text.length>MAX_MARKDOWN){
   const compactCite=ids=>[...new Set(ids)].map(id=>{const name=refLabels.get(id);return name?'['+name+'](#'+name.toLowerCase()+')':'';}).filter(Boolean).join(' ');
   const reason={already_has:'Canonical docs/code present; live availability unverified.',partial:'Bounded foundation evidence; completeness/activation unverified.',lacks:'Explicit canonical exclusion supported by code, limited to this named capability.',unknown:'Insufficient evidence to assert presence or absence.'};
   lines=[`# ${markdown(competitor.name)} — competitor research`,`Baseline HEAD ${snapshot.head}; ${sections.overview.pages_captured} public pages; ${blocked.length} inaccessible and ${privateRecords.length} sanitized account captures. No production qualification.`,
    '## Survey coverage — observed / documented / inferred / inaccessible',...coverage.map(c=>'- '+c.label+' — '+c.classification+'. '+(c.reason.startsWith('Only a fixed')?'Navigation label only.':c.reason.startsWith('Public pages')?'Viewport captures; usability unverified.':c.classification==='observed'?'Rendered page; behavior unverified.':c.classification==='documented'?'Public claim; behavior unverified.':'Not established; no gap asserted.')+' '+compactCite(c.evidence_refs)),
    '- Inferred positioning: '+markdown(sections.inferred[0].description),'## Pricing and positioning',...prices.map(p=>'- Documented: '+markdown(p.text)+' ('+p.currency+'). '+compactCite([p.evidence_id])),sections.pricing.limitations,
    '## Arecibo comparison',...comparison.map(c=>'- **'+markdown(c.feature)+' — '+c.status.replaceAll('_',' ')+'** (competitor: '+c.competitor_classification+'). '+reason[c.status]+' '+compactCite([...c.competitor_refs,...c.baseline_refs])),
    '## P0 / P1 / P2 recommendations — estimates only',`Illustrative assumption: ${this.estimateCurrency} ${this.estimateDayRate}/engineer-day. No implementation or budget is approved.`,...recommendations.map(r=>'- **'+r.priority+': '+markdown(r.title)+'**. Complexity '+r.complexity+'; '+r.estimate.effort_days.min+'–'+r.estimate.effort_days.max+' days / '+r.estimate.currency+' '+r.estimate.amount.min+'–'+r.estimate.amount.max+'. Infrastructure estimate: '+(r.infrastructure_impact.fixed_incremental_cost.startsWith('No new fixed')?'reuse existing; no fixed increase assumed, utilization/vendor fees unmeasured.':'compute, storage and vendor costs unknown; measure before budgeting.')+' Security/compliance: retain tenant scope, consent, erasure, financial-product boundaries and independent review. '+compactCite(r.evidence_refs)),
    '## Not worth copying',...sections.not_worth_copying.map(r=>'- '+r.description+' '+compactCite(r.evidence_refs)),'## Protected public downloads',...sections.downloads.map(d=>'- Verified '+d.download_ref.mimeType+' artifact '+d.download_ref.id+'; not interpreted as product functionality or pricing. '+compactCite([d.evidence_id])),'## Evidence and screenshots','Digest prefixes below; full hashes, URLs and all screenshot IDs are retained in the verified structured references.'];
   for(const e of selectedRefs){lines.push('### '+refLabels.get(e.id));lines.push(e.kind==='website'?(e.url.length<=300?'['+markdown(e.title.slice(0,60))+'](<'+e.url+'>)':'Website URL is recorded in structured references.')+' · SHA-256 '+e.sha256.slice(0,12)+'…':markdown(e.path)+':'+e.lines.start+'–'+e.lines.end+' · SHA-256 '+e.sha256.slice(0,12)+'…'+(e.dirty?' · uncommitted':''));if(e.download_ref)lines.push('Download '+e.download_ref.id+' · '+e.download_ref.mimeType+'; full byte digest in structured references.');if(e.screenshot_ref)lines.push('Screenshot '+e.screenshot_ref.id+'; other viewport IDs are in structured references.');}
   text=lines.join('\n\n');
  }
  if(text.length>MAX_MARKDOWN)throw Error('Research report exceeds its bounded result contract; reduce captured pages or feature categories.');
  // Recheck current provenance immediately before the report becomes visible.
  this.baseline.verify(snapshot);for(const e of records)if(await this.evidenceStore.verify(e.row)!==true)throw Error('Research evidence became unavailable');
  return freeze({version:1,id:randomUUID(),competitor,baseline:{id:snapshot.id,head:snapshot.head,digest:snapshot.digest,unavailable_count:snapshot.unavailable.length},sections,references,screenshot_refs:webRefs.filter(e=>e.screenshot_ref).map(e=>e.screenshot_ref),download_refs:webRefs.filter(e=>e.download_ref).map(e=>e.download_ref),markdown:text,digest:hash(text),authority:false,automatic_implementation:false,estimates_only:true});
 }
}
module.exports={ResearchReport,FEATURE_SIGNALS,SURVEY_AREAS,MAX_MARKDOWN,safeURL,markdown,projectResearchResponse};
