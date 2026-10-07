'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const {ResearchCredentials}=require('../src/research-credentials');
test('credential resolution requires current purpose, exact consumed approval and one-use reference; revocation wins',()=>{
 const username=randomUUID(),password=randomUUID(),form=randomUUID(),id=randomUUID(),mission=randomUUID(),task=randomUUID();let reads=0,active=true;
 const a={id,origin:'https://competitor.example',login_url:'https://competitor.example/login',username_reference:username,password_reference:password,purpose:'competitor_product_research',confirmed:true};
 const m={id:mission,task_id:task,owner:'operator',state:'running',envelope:{kind:'browser_research',manifest:{account_authorization:a,expires_at:Date.now()+100000},authority:{permissions:{secrets:['use']}}}};
 const action={type:'authenticate',form_id:form,username_reference:username,password_reference:password,approval_id:id};
 const approval={id:randomUUID(),taskId:task,toolName:'capability',status:'pending',input:{name:'browser_research',input:{mission_id:mission,action}}};
 const bridge={dataDir:'.',controlStore:{requireMission:()=>m},policy:{approvals:new Map([[approval.id,approval]])},missions:{research:{assertContract:()=>{if(!active)throw Error('revoked');}}}};
 const vault={search:()=>active?[{reference:username,kind:'credential'},{reference:password,kind:'password'}]:[],resolve:()=>{reads++;return Buffer.from('isolated synthetic value');}};
 const c=new ResearchCredentials(bridge,{vault,synthetic:true}),grant={...a,mission_id:mission,purpose:'account_login',form_id:form,approval_id:id,submission_url:a.origin+'/session'};
 assert.throws(()=>c.resolve(password,grant));assert.equal(reads,0);
 approval.status='consumed';assert.throws(()=>c.resolve(password,{...grant,submission_url:'https://other.example/session'}));assert.equal(reads,0);
 assert.ok(Buffer.isBuffer(c.resolve(password,grant)));assert.equal(reads,1);assert.throws(()=>c.resolve(password,grant));assert.equal(reads,1);
 active=false;assert.throws(()=>c.resolve(username,grant));assert.equal(reads,1);
 assert.doesNotMatch(JSON.stringify({a,approval}),/isolated synthetic value/);
});
test('account guide refuses non-TTY or competing input before private reference selection',async()=>{
 const {PassThrough}=require('node:stream'),input=new PassThrough(),output=new PassThrough();input.isTTY=true;output.isTTY=true;input.setRawMode=()=>{};input.on('data',()=>{});let called=false;
 await assert.rejects(require('../src/research-account-guide').guide({entry_url:'https://competitor.example/login',input,output,home:'.',vault:{search:()=>{called=true;return [];}}}),/detached secure/);assert.equal(called,false);
});
