'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const SafetyPolicy = require('../src/safety-policy');
const { SafeDiagnostics, classify } = require('../src/safe-diagnostics');
const MemoryStore = require('../src/memory-store');
const { pressure } = require('../src/mission-checkpoint');
function fixture(t) {
  const root = fs.mkdtempSync('/private/tmp/bootstrap-'); t.after(() => fs.rmSync(root, {recursive:true,force:true}));
  const workspace = path.join(root,'repo'); fs.mkdirSync(workspace);
  const policy = new SafetyPolicy(); const task = policy.registerTask({id:'a',sessionId:'s',workspace});
  return {root,workspace,policy,task,reader:new SafeDiagnostics(policy)};
}
test('safe diagnostics auto-allow and filtered reads exclude metadata, secrets and symlinks', async t => {
  const {workspace,policy,task,reader} = fixture(t);
  fs.mkdirSync(path.join(workspace,'.git')); fs.writeFileSync(path.join(workspace,'.env'),'SECRET_SENTINEL');
  fs.writeFileSync(path.join(workspace,'safe.txt'),'visible\nline two');
  fs.symlinkSync('/etc/passwd',path.join(workspace,'escape'));
  for (const command of ['pwd','ls -la','cat safe.txt','head safe.txt','tail safe.txt','rg visible .','find .','git status --short','git diff','git log --oneline','ps -axo pid,ppid,stat,comm']) {
    const verdict=policy.check('a',{toolName:'bash',input:{command}}); assert.equal(verdict.allow,true,command); assert.equal(verdict.approvalId,undefined);
  }
  for (const command of ['ls -la','rg SECRET_SENTINEL .','find .']) {
    const output=await reader.execute(task,command); assert(!output.includes('SECRET_SENTINEL')); assert(!output.includes('.env')); assert(!output.includes('.git')); assert(!output.includes('escape'));
  }
  for (const command of ['cat .env','cat escape','cat /etc/passwd']) assert.equal(policy.check('a',{toolName:'bash',input:{command}}).allow,false);
});
test('destructive, GCP, shell expansion and external-execution commands never auto-allow',t=>{
  const {policy}=fixture(t);
  for(const command of ['rm -rf .','git reset --hard','git clean -fd','git push --force','gcloud run deploy app','gcloud projects delete project','gcloud compute instances list','gsutil rm gs://bucket/a','terraform apply','curl https://example.com','git -c alias.x=!sh x','git diff --ext-diff','git log --format=%B','ls; touch bad','ls $(touch bad)','cat safe*','env','ps aux','launchctl kickstart service']) {
    assert.equal(classify(command),null,command);
    assert.equal(policy.check('a',{toolName:'bash',input:{command}}).allow,false,command);
  }
});
test('Git diagnostic disables external diff and refuses secret diffs',async t=>{
  const {workspace,task,reader}=fixture(t);
  const git=(...args)=>execFileSync('/usr/bin/git',args,{cwd:workspace,stdio:'pipe'});
  git('init'); git('config','user.name','Test');git('config','user.email','test@example.invalid');
  fs.writeFileSync(path.join(workspace,'a.txt'),'first'); git('add','a.txt'); git('commit','-m','Initial fixture');
  git('config','diff.external','touch SHOULD_NOT_EXIST');
  fs.writeFileSync(path.join(workspace,'a.txt'),'second');
  assert.match(await reader.execute(task,'git diff'),/second/); assert(!fs.existsSync(path.join(workspace,'SHOULD_NOT_EXIST')));
  fs.writeFileSync(path.join(workspace,'.env'),'PRIVATE');git('add','.env');
  await assert.rejects(reader.execute(task,'git diff --cached'),/Protected/);
});
const checkpoint = { objective:'Bootstrap',verifiedFacts:[{fact:'Test passed',evidence:'test receipt 1'}],hypotheses:['Unverified hypothesis'],decisions:['Use SQLite'],completedGates:['unit tests'],failedApproaches:['V1 shell gating'],gitReferences:['a6fadec main clean'],nextStep:'Run original-chat MCP acceptance' };
test('checkpoint persists with evidence, task isolation, and model claims cannot certify gates',t=>{
  const {root}=fixture(t),file=path.join(root,'memory.sqlite'); let store=new MemoryStore(file);
  const saved=store.saveCheckpoint('a',checkpoint,{sessionId:'s'});store.close();store=new MemoryStore(file);t.after(()=>store.close());
  assert.equal(store.latestCheckpoint('a').id,saved.id);assert.equal(store.latestCheckpoint('b'),null);
  assert.deepEqual(JSON.parse(store.latestCheckpoint('a').content),checkpoint);
  assert.throws(()=>store.saveCheckpoint('a',checkpoint,{sessionId:'s',model:true}),/cannot certify/);
  assert.throws(()=>store.saveCheckpoint('a',{...checkpoint,verifiedFacts:[{fact:'unsupported'}]},{sessionId:'s'}),/evidence/);
  assert.deepEqual(pressure({tokens:650,contextWindow:1000}),{percent:65,warning:true,continuation:false});
  assert.equal(pressure({tokens:750,contextWindow:1000}).continuation,true);assert.equal(pressure({tokens:null,contextWindow:1000}),null);
});

test('Git diagnostics cannot discover parent repositories or follow redirected metadata',async t=>{
  const {workspace,root,task,reader}=fixture(t);
  execFileSync('/usr/bin/git',['init'],{cwd:root,stdio:'ignore'});
  await assert.rejects(reader.execute(task,'git log --oneline'));
  fs.symlinkSync(path.join(root,'.git'),path.join(workspace,'.git'));
  await assert.rejects(reader.execute(task,'git status'),/workspace-owned/);
});
