'use strict';
// Public documents only, after exact URL policy, DNS pinning and byte bounds.
const {error}=require('./research-network');
const {unsafeEvidenceText}=require('./research-baseline');
const hash=v=>require('node:crypto').createHash('sha256').update(v).digest('hex');
function pdfText(){
 // No PDF executable is qualified on this host. Do not run a discovered parser
 // against untrusted documents without a pinned artifact and sandbox review.
 throw error('qualified_pdf_reader_unavailable');
}
async function read({url,network,signal}){
 const response=await network.fetch({url,signal,document:true});let text;
 if(response.contentType==='application/pdf')text=await pdfText(response.body,signal);
 else if(['text/html','application/xhtml+xml'].includes(response.contentType))text=require('./mission-web-search').plainText(response.body.toString('utf8'));
 else if(['text/plain','application/json','text/markdown'].includes(response.contentType))text=response.body.toString('utf8');
 else throw error('public_document_type_denied');
 text=require('node:util').stripVTControlCharacters(text).replace(/[\x00-\x08\x0b-\x1f\x7f]/g,'').slice(0,16000);if(unsafeEvidenceText(text))throw error('private_document_denied');
 return {url:response.url,title:'Public document',text,links:[],classification:'documented',bytes:response.body.length,source:{source_id:'public_document',source_url:response.url,source_sha256:hash(response.body),fetched_at:Date.now()},untrusted:true,authority:false};
}
module.exports={read,pdfText};
