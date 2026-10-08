'use strict';
// Fixed approved source, never caller-selected endpoint/headers/bodies.
const {ResearchNetwork,error}=require('./research-network');
const {unsafeEvidenceText}=require('./research-baseline');
const ORIGIN='https://html.duckduckgo.com';
function decode(value){return value.replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#39;/g,"'");}
async function search({query,source,signal,testing,onRequest,onBytes}={}){
 if(source!=='duckduckgo_html')throw error('approved_search_provider_unavailable');
 const transport=new ResearchNetwork({scope:{origins:[ORIGIN]},signal,testing,onRequest,onBytes,maxBytes:262144});
 const url=ORIGIN+'/html/?q='+encodeURIComponent(query),response=await transport.fetch({url,signal});
 const html=response.body.toString('utf8');if(/anomaly-modal|data-sitekey|challenge-form|verify you are human/i.test(html))throw error('search_human_verification_required');
 const results=[];
 for(const match of html.matchAll(/<a\b([^>]*\bclass=["'][^"']*result__a[^"']*["'][^>]*)>([\s\S]*?)<\/a>/gi)){
  const raw=/\bhref=["']([^"']+)["']/i.exec(match[1])?.[1];if(!raw)continue;
  let target;try{const u=new URL(decode(raw),ORIGIN);target=u.origin===ORIGIN?u.searchParams.get('uddg'):u.href;const v=new URL(target);new ResearchNetwork({scope:{origins:[v.origin]}}).validate(target);}catch{continue;}
  const title=decode(match[2].replace(/<[^>]*>/g,' ')).replace(/\s+/g,' ').trim().slice(0,200);if(!title||unsafeEvidenceText(title))continue;
  results.push({title,url:target,classification:'documented',source:'duckduckgo_html',authority:false});if(results.length===5)break;
 }
 if(!results.length)throw error('search_results_unavailable');
 return {source_id:'duckduckgo_html',source_url:ORIGIN+'/html/',fetched_at:Date.now(),source_sha256:require('node:crypto').createHash('sha256').update(response.body).digest('hex'),bytes:response.body.length,results,untrusted:true,authority:false};
}
function plainText(html){return html.replace(/<(script|style|noscript|template)\b[^>]*>[\s\S]*?<\/\1>/gi,' ').replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim();}
module.exports={search,ORIGIN,plainText};
