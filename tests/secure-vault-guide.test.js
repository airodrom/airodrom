'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {EventEmitter}=require('node:events'),{randomUUID}=require('node:crypto');
const {hidden,run}=require('../src/vault-cli'),{guide,MENU}=require('../src/secure-vault-guide'),{SecretVault}=require('../src/secret-vault');
const CANARY='synthetic-secure-value-never-exported';
class Terminal extends EventEmitter{
 constructor(steps=[]){super();this.isTTY=true;this.isRaw=false;this.steps=steps;this.raw=[];this.paused=true;}
 setRawMode(value){this.isRaw=value;this.raw.push(value);return this;}
 pause(){this.paused=true;return this;}
 resume(){this.paused=false;const next=this.steps.shift();if(next!==undefined)queueMicrotask(()=>{if(typeof next==='function')next(this);else this.emit('data',Buffer.from(next));});return this;}
}
function output(){let text='';return {isTTY:true,write:value=>{text+=String(value);},text:()=>text};}
function fixture(t,port=null){
 const home=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'airo-vault-guide-')));fs.chmodSync(home,0o700);t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
 const data=path.join(home,'data');fs.mkdirSync(data,{mode:0o700});const values=new Map(),calls=[];
 const host=port||((op,id,value)=>{calls.push({op,id});if(op==='put')values.set(id,value);if(op==='read')return values.get(id);if(op==='delete')values.delete(id);return '';});
 return {home,data,values,calls,vault:new SecretVault(data,host)};
}
function clean(input){assert.equal(input.listenerCount('data'),0);assert.equal(input.listenerCount('readable'),0);assert.equal(input.listenerCount('end'),0);assert.equal(input.listenerCount('close'),0);assert.equal(input.listenerCount('error'),0);assert.equal(input.isRaw,false);assert.equal(input.paused,true);}

test('secure Vault guide stores only through the canonical host port; input and receipts never echo values',async t=>{
 const f=fixture(t),input=new Terminal(['1\r','2\r','2\r',CANARY+'\r/chat '+CANARY,'yes\r']),out=output();
 const receipt=await guide({input,output:out,home:f.home,vault:f.vault});assert.equal(receipt.state,'saved');assert.equal(f.values.get(receipt.reference),CANARY);
 assert.ok(out.text().startsWith(MENU));assert.match(out.text(),/Secret saved as Work API key/);assert.doesNotMatch(out.text()+JSON.stringify(receipt)+fs.readFileSync(path.join(f.data,'vault-dispositions.json'),'utf8'),new RegExp(CANARY));
 assert.deepEqual(f.calls.map(c=>c.op),['put']);assert.deepEqual(input.raw,[true,false,true,false,true,false,true,false,true,false]);clean(input);
});
test('secure Vault guide fails closed with an ordinary or competing input reader, including paused readers',async t=>{
 const f=fixture(t);
 for(const kind of ['data','readable']){const input=new Terminal(),out=output(),listener=()=>{};input.on(kind,listener);input.pause();await assert.rejects(guide({input,output:out,home:f.home,vault:f.vault}),/Close ordinary/);assert.equal(out.text(),'');assert.equal(input.raw.length,0);assert.deepEqual(f.calls,[]);input.removeListener(kind,listener);}
 const input=new Terminal();input.isTTY=false;await assert.rejects(guide({input,output:output(),home:f.home,vault:f.vault}),/interactive/);assert.deepEqual(f.calls,[]);
});
test('secure Vault capture cancels, bounds and sanitizes failures while restoring raw mode and listeners',async()=>{
 for(const step of ['\x03',CANARY+'\0','x'.repeat(8193),stream=>stream.emit('end'),stream=>stream.emit('close'),stream=>stream.emit('error',Error(CANARY))]){
  const input=new Terminal([step]),out=output();await assert.rejects(hidden(input,out));assert.doesNotMatch(out.text(),new RegExp(CANARY));clean(input);
 }
 const controller=new AbortController(),input=new Terminal([()=>controller.abort()]),out=output();await assert.rejects(hidden(input,out,{signal:controller.signal}),/cancelled/);clean(input);
});
test('secure Vault capture discards pasted trailing lines and preserves split Unicode without echo',async()=>{
 const bytes=Buffer.from('pêche🐟'),input=new Terminal([stream=>{stream.emit('data',bytes.subarray(0,2));stream.emit('data',bytes.subarray(2,8));stream.emit('data',Buffer.concat([bytes.subarray(8),Buffer.from('\r/chat '+CANARY+'\r')]));}]),out=output();
 assert.equal(await hidden(input,out),'pêche🐟');assert.doesNotMatch(out.text(),/pêche|🐟|synthetic/);clean(input);
});
test('secure Vault capture preserves a previously raw terminal and refuses secret command arguments before capture',async t=>{
 const input=new Terminal(['safe\r']),out=output();input.isRaw=true;assert.equal(await hidden(input,out),'safe');assert.equal(input.isRaw,true);assert.equal(input.paused,true);
 const f=fixture(t),bad=new Terminal();await assert.rejects(run(f.home,['put','operator',CANARY],bad,out),/never command arguments/);assert.deepEqual(bad.raw,[]);assert.doesNotMatch(out.text(),new RegExp(CANARY));
});
test('secure Vault list exposes only generated operator names, never connector references or Keychain reads',async t=>{
 const f=fixture(t),operator=f.vault.put(CANARY,'operator',{kind:'password'}),gmail=f.vault.put('synthetic-gmail-value','gmail'),whatsapp=f.vault.put('synthetic-whatsapp-value','whatsapp');f.calls.length=0;
 const out=output(),input=new Terminal(['2\r']);assert.equal((await guide({input,output:out,home:f.home,vault:f.vault})).state,'listed');
 assert.match(out.text(),new RegExp('Password '+operator.reference.slice(0,8)));assert.doesNotMatch(out.text(),new RegExp(CANARY+'|'+gmail.reference+'|'+whatsapp.reference));assert.deepEqual(f.calls,[]);clean(input);
});
test('secure Vault removal revokes canonical references and removes name metadata before failed host cleanup',async t=>{
 const f=fixture(t),ref=f.vault.put(CANARY,'operator',{kind:'password'}),old=f.vault.names()[0].name,out=output(),input=new Terminal(['3\r','1\r','yes\r']);
 assert.equal((await guide({input,output:out,home:f.home,vault:f.vault})).state,'removed');assert.deepEqual(f.vault.names(),[]);assert.throws(()=>f.vault.resolve(ref.reference,'operator'),/revoked/);const state=fs.readFileSync(path.join(f.data,'vault-dispositions.json'),'utf8');assert.doesNotMatch(state,new RegExp(CANARY+'|'+old));clean(input);
 const failure=fixture(t,(op)=>{if(op==='delete')throw Error(CANARY);return '';});const secret=failure.vault.put(CANARY,'operator',{kind:'api_key'});assert.throws(()=>failure.vault.forget(secret.reference));assert.deepEqual(failure.vault.names(),[]);assert.equal(JSON.parse(fs.readFileSync(path.join(failure.data,'vault-dispositions.json'),'utf8')).refs[secret.reference].name,undefined);
});
test('secure Vault cancels or blocks unavailable input without retaining credential-bearing host diagnostics',async t=>{
 const f=fixture(t,()=>{throw Error(CANARY);}),out=output(),input=new Terminal(['1\r','1\r','2\r',CANARY+'\r','yes\r']);assert.equal((await guide({input,output:out,home:f.home,vault:f.vault})).state,'unavailable');assert.doesNotMatch(out.text(),new RegExp(CANARY));assert.deepEqual(f.vault.names(),[]);clean(input);
 const next=fixture(t),cancelInput=new Terminal(['1\r','1\r','2\r',CANARY+'\x03']),cancelOut=output();assert.equal((await guide({input:cancelInput,output:cancelOut,home:next.home,vault:next.vault})).state,'cancelled');assert.deepEqual(next.calls,[]);clean(cancelInput);
 const unconfigured=new SecretVault(next.data),notReady=new Terminal(['1\r']),notReadyOut=output();assert.equal((await guide({input:notReady,output:notReadyOut,home:next.home,vault:unconfigured})).state,'unavailable');assert.match(notReadyOut.text(),/secret prepare/);clean(notReady);
});
test('secure Vault names are compatible with legacy references and reject arbitrary display metadata',t=>{
 const f=fixture(t),id=randomUUID();fs.writeFileSync(path.join(f.data,'vault-dispositions.json'),JSON.stringify({version:1,refs:{[id]:{state:'active',purpose:'operator'}}}),{mode:0o600});assert.deepEqual(f.vault.names(),[{reference:id,name:'Saved secret '+id.slice(0,8)}]);
 for(const name of [CANARY,'Password '+CANARY,'person@example.com','Password \x1b[31m']){fs.writeFileSync(path.join(f.data,'vault-dispositions.json'),JSON.stringify({version:1,refs:{[id]:{state:'active',purpose:'operator',name}}}),{mode:0o600});assert.throws(()=>f.vault.names(),/Invalid vault dispositions/);}
});
test('secure Vault restored names recheck independent current dispositions and cannot resurrect erased names',t=>{
 const f=fixture(t),saved=f.vault.put(CANARY,'operator',{kind:'password'}),copy=path.join(f.home,'copy');fs.mkdirSync(copy,{mode:0o700});fs.copyFileSync(path.join(f.data,'vault-dispositions.json'),path.join(copy,'vault-dispositions.json'));fs.chmodSync(path.join(copy,'vault-dispositions.json'),0o600);
 const restored=new SecretVault(copy,()=>'',{restoreFromBackup:true,erasureSourceVault:f.vault});assert.equal(restored.names().length,1);f.vault.forget(saved.reference);assert.deepEqual(restored.names(),[]);new SecretVault(copy,()=>'',{restoreFromBackup:true,erasureSourceVault:f.vault});assert.equal(JSON.parse(fs.readFileSync(path.join(copy,'vault-dispositions.json'),'utf8')).refs[saved.reference].name,undefined);
});

test('visible choices echo only permitted answers and restore terminal ownership',async()=>{
 const {visible,confirm}=require('../src/vault-cli');
 const input=new Terminal([stream=>{stream.emit('data',Buffer.from('y'));stream.emit('data',Buffer.from('e'));stream.emit('data',Buffer.from('s\r'));}]),out=output();
 assert.equal(await confirm(input,out),true); // The receipt never includes the answer text.
 assert.match(out.text(),/\[y\/N\].*yes/);clean(input);
 for(const answer of [CANARY+'\r',CANARY+'\x7f'.repeat(CANARY.length)+'yes\r','yes\r'+CANARY+'\r','\x1b[200~yes\x1b[201~\r','\x03','\x04']){
  const terminal=new Terminal([answer]),display=output();await assert.rejects(visible(terminal,display));assert.doesNotMatch(display.text(),new RegExp(CANARY));clean(terminal);
 }
 const terminal=new Terminal(['2\b1\r']),display=output();assert.equal(await visible(terminal,display,{choices:['1','2']}),'1');assert.ok(display.text().includes('2\b \b1'));clean(terminal);
});
test('credential save requires a fresh visible Yes after hidden capture and never echoes value',async t=>{
 for(const decision of ['no\r','\r','\x03','yes\r'+CANARY+'\r']){
  const f=fixture(t),input=new Terminal(['1\r','1\r','2\r',CANARY+'\r',decision]),out=output();
  assert.equal((await guide({input,output:out,vault:f.vault})).state,'cancelled');
  assert.deepEqual(f.calls,[]);assert.deepEqual(f.vault.names(),[]);assert.doesNotMatch(out.text(),new RegExp(CANARY));assert.match(out.text(),/Save Work login securely/);clean(input);
 }
});
test('preset labels reject credential paste and duplicates before credential entry without echo',async t=>{
 const f=fixture(t);f.vault.put(CANARY,'operator',{kind:'password',name:'Work login'});f.calls.length=0;
 for(const [label,state]of [['2','collision'],['sk-proj-'+CANARY,'cancelled'],['amber forest river','cancelled']]){
  const input=new Terminal(['1\r','1\r',label+'\r']),out=output();assert.equal((await guide({input,output:out,vault:f.vault})).state,state);assert.deepEqual(f.calls,[]);assert.doesNotMatch(out.text(),new RegExp(CANARY));clean(input);
 }
});
test('non-TTY output denies every capture and both guides before any Vault write',async t=>{
 const f=fixture(t),input=new Terminal(),out=output();out.isTTY=false;
 await assert.rejects(hidden(input,out),/interactive/);
 await assert.rejects(require('../src/vault-cli').visible(input,out),/interactive/);
 await assert.rejects(guide({input,output:out,vault:f.vault}),/interactive/);
 await assert.rejects(require('../src/natural-private-vault').guide({message:'Save my mailbox number 818',input,output:out,vault:f.vault}),/interactive/);
 assert.equal(out.text(),'');assert.deepEqual(f.calls,[]);clean(input);
});

test('account capability authorization uses visible named choices and fresh confirmation without credential reads',async t=>{
 const f=fixture(t);f.vault.put('synthetic-user-canary','operator',{kind:'password',name:'Personal login'});f.vault.put(CANARY,'operator',{kind:'password',name:'Work login'});f.calls.length=0;
 const guideAccount=require('../src/research-account-guide').guide;
 for(const decision of ['no\r','\r','\x03','yes\r'+CANARY+'\r']){
  const out=output(),input=new Terminal(['1\r','2\r',decision]);let sent=0;
  const promise=guideAccount({entry_url:'https://account.example.invalid/login',input,output:out,vault:f.vault,request:async()=>{sent++;}});
  if(decision==='\x03'||decision.startsWith('yes'))await assert.rejects(promise,/cancelled/);else assert.equal((await promise).kind,'clarify');
  assert.equal(sent,0);assert.deepEqual(f.calls,[]);assert.doesNotMatch(out.text(),new RegExp(CANARY+'|synthetic-user-canary'));assert.match(out.text(),/Username: Personal login\nPassword: Work login/);clean(input);
 }
 const out=output(),input=new Terminal(['1\r','2\r','yes\r']);let payload;
 await guideAccount({entry_url:'https://account.example.invalid/login',input,output:out,vault:f.vault,request:async(_home,_route,body)=>{payload=body;return {kind:'mission'};}});
 assert.equal(payload.confirmed,true);assert.doesNotMatch(JSON.stringify(payload),new RegExp(CANARY+'|synthetic-user-canary'));assert.deepEqual(f.calls,[]);clean(input);
 const stale=new Terminal(['1\r','2\r',stream=>{f.vault.rename(f.vault.search('Work login')[0].reference,'Service login');stream.emit('data',Buffer.from('yes\r'));}]);
 await assert.rejects(guideAccount({entry_url:'https://account.example.invalid/login',input:stale,output:output(),vault:f.vault,request:async()=>{throw Error('Stale choice must not dispatch');}}),/selection changed/);assert.deepEqual(f.calls,[]);clean(stale);
});
