'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{EventEmitter}=require('node:events');
const {SecretVault}=require('../src/secret-vault'),intent=require('../src/private-vault-intent'),{guide}=require('../src/natural-private-vault');
class Terminal extends EventEmitter {
 constructor(steps=[]){super();this.isTTY=true;this.isRaw=false;this.steps=steps;}
 setRawMode(value){this.isRaw=value;}pause(){}resume(){const step=this.steps.shift();if(step!==undefined)queueMicrotask(()=>typeof step==='function'?step(this):this.emit('data',Buffer.from(step)));}
}
const output=()=>{let text='';return {isTTY:true,write:value=>{text+=value;},text:()=>text};};
function fixture(t){
 const home=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'airo-named-')));fs.chmodSync(home,0o700);t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
 const values=new Map(),revoked=new Set(),calls=[];
 const port=(op,id,value)=>{calls.push({op,id});if(op==='revoke'){revoked.add(id);return '';}if(op==='delete'){values.delete(id);return '';}if(revoked.has(id))throw Error('revoked');if(op==='put'){values.set(id,value);return '';}if(op==='read')return values.get(id);};
 return {home,values,calls,port,vault:new SecretVault(home,port)};
}
test('natural identifier ingress has no value in default routing or credential fallthrough',()=>{
 for(const text of ["Hi Airo, let's save my mailbox number 818.",'Hi Airo, let’s save my mailbox number 818.','Hello Airodrom, please let us save my mailbox number 818.','Hi Airo, save my mailbox number 818','hi airo please save secret of my mailbox number - 818']){
  assert.equal(intent.parse(text,{capture:true}).value,'818');assert.equal(intent.parse(text).classification,'private_identifier');assert.doesNotMatch(JSON.stringify(intent.parse(text)),/818/);
 }
 assert.equal(intent.parse('Save my mailbox number 818\nThanks').action,'clarify');assert.equal(intent.parse('My mailbox number is 818\nExplain that').action,'clarify');
 assert.equal(intent.parse("What's my mailbox number?").action,'reveal');
 for(const text of ["Hi Airo, let's save my password 818.","Hi Airo, let's save my mailbox number PIN 818.",'Hi Airo, let’s save my mailbox number sk-proj-syntheticcanary.','save my mailbox number password is synthetic-credential','save my password 818','save my PIN 818','save my mailbox number sk-proj-syntheticcanary']){
  assert.equal(intent.parse(text),null);assert.equal(require('../src/assistant-intent').parse(text).kind,'secret');
 }
 for(const text of ["Hi Airo, let's not save my mailbox number 818.","Hi Airo, let's save my mailbox number 818 and locker number 999.","Hi Airo, let's save my mailbox number 818. Then send it.","Hi Airo, let's save my mailbox number 818.\nYes"]){
  assert.equal(intent.parse(text).action,'clarify');assert.doesNotMatch(JSON.stringify(intent.parse(text)),/818|999/);
 }
 assert.equal(intent.parse('Save my mailbox number').action,'save');assert.equal(intent.parse('Save my mailbox number').value_present,false);assert.equal(intent.parse('Hi'),null);
});
test('confirmed named save and restart lookup disclose only in operator reveal output',async t=>{
 const f=fixture(t),out=output();
 const saved=await guide({message:"Hi Airo, let's save my mailbox number 818.",input:new Terminal(['yes\r']),output:out,vault:f.vault});assert.equal(saved.state,'saved');
 const metadata=fs.readFileSync(path.join(f.home,'vault-dispositions.json'),'utf8');assert.doesNotMatch(metadata+JSON.stringify(saved),/"818"/);assert.equal(f.values.get(saved.reference),'818');assert.match(out.text(),/Value: 818/);
 const restarted=new SecretVault(f.home,f.port),reveal=output();const receipt=await guide({message:"What's my mailbox number?",input:new Terminal(['yes\r']),output:reveal,vault:restarted});
 assert.equal(receipt.state,'revealed');assert.match(reveal.text(),/mailbox number is 818/);assert.doesNotMatch(JSON.stringify(receipt),/818/);assert.deepEqual(f.calls.map(c=>c.op),['put','read']);
});
test('confirmation refusal and non-operator streams cannot save or reveal',async t=>{
 const f=fixture(t),out=output();assert.equal((await guide({message:'Save my mailbox number 818',input:new Terminal(['no\r']),output:out,vault:f.vault})).state,'cancelled');assert.equal(f.calls.length,0);
 for(const answer of ['no\r','\r','\x03'])assert.equal((await guide({message:"Hi Airo, let's save my mailbox number 818.",input:new Terminal([answer]),output:out,vault:f.vault})).state,'cancelled');
 assert.equal(f.calls.length,0);assert.equal(f.vault.search('Mailbox number').length,0);
 const saved=f.vault.put('818','operator',{kind:'private_identifier',name:'Mailbox number'});f.calls.length=0;
 assert.throws(()=>f.vault.revealPrivate(saved.reference,{confirmed:false}));
 assert.equal((await guide({message:"What's my mailbox number?",input:new Terminal(['no\r']),output:out,vault:f.vault})).state,'cancelled');assert.equal(f.calls.length,0);
 const stream=new Terminal();stream.isTTY=false;await assert.rejects(guide({message:"What's my mailbox number?",input:stream,output:out,vault:f.vault}));
 const competing=new Terminal();competing.on('data',()=>{});await assert.rejects(guide({message:"What's my mailbox number?",input:competing,output:out,vault:f.vault}));assert.doesNotMatch(out.text().slice(out.text().lastIndexOf('Reveal Mailbox')), /818/);
});
test('labels collide case-insensitively and rename cannot repurpose credentials',async t=>{
 const f=fixture(t),a=f.vault.put('818','operator',{kind:'private_identifier',name:'Mailbox number'});assert.throws(()=>f.vault.put('999','operator',{kind:'private_identifier',name:'mailbox NUMBER'}),/label/);
 const collision=await guide({message:"Hi Airo, let's save my mailbox number 999.",input:new Terminal(['yes\r']),output:output(),vault:f.vault});assert.equal(collision.state,'collision');assert.equal(f.values.get(a.reference),'818');
 f.vault.rename(a.reference,'Locker number');assert.equal(f.vault.search('mailbox').length,0);assert.equal(f.vault.search('locker')[0].reference,a.reference);
 const credential=f.vault.put('synthetic-credential','operator',{kind:'password'});f.vault.rename(credential.reference,'Mailbox password');assert.throws(()=>f.vault.revealPrivate(credential.reference,{confirmed:true}),/identifier/);
 const out=output();assert.equal((await guide({message:'/secret reveal Mailbox password',input:new Terminal(['yes\r']),output:out,vault:f.vault})).state,'denied');assert.doesNotMatch(out.text(),/synthetic-credential/);
 assert.throws(()=>f.vault.rename(a.reference,'Mailbox password'),/label/);assert.throws(()=>f.vault.rename(a.reference,'Mailbox 818'));
});
test('search ambiguity asks one selection and removal requires confirmation',async t=>{
 const f=fixture(t);f.vault.put('818','operator',{kind:'private_identifier',name:'Mailbox east'});f.vault.put('999','operator',{kind:'private_identifier',name:'Mailbox west'});
 const out=output(),receipt=await guide({message:'/secret reveal mailbox',input:new Terminal(['2\r','yes\r']),output:out,vault:f.vault});assert.equal(receipt.state,'revealed');assert.match(out.text(),/mailbox west is 999/);
 assert.equal((await guide({message:'/secret remove Mailbox east',input:new Terminal(['no\r']),output:output(),vault:f.vault})).state,'cancelled');assert.equal(f.vault.search('east').length,1);
 assert.equal((await guide({message:'/secret remove Mailbox east',input:new Terminal(['yes\r']),output:output(),vault:f.vault})).state,'removed');assert.equal(f.vault.search('east').length,0);
});
test('purpose binding, tombstones and current source prevent name or value resurrection',t=>{
 const f=fixture(t),a=f.vault.put('818','operator',{kind:'private_identifier',name:'Mailbox number'}),gmail=f.vault.put('synthetic-oauth','gmail');assert.throws(()=>f.vault.resolve(a.reference,'gmail'));assert.throws(()=>f.vault.revealPrivate(gmail.reference,{confirmed:true}));assert.equal(f.vault.search('').length,1);
 const copy=path.join(f.home,'copy');fs.mkdirSync(copy,{mode:0o700});fs.copyFileSync(path.join(f.home,'vault-dispositions.json'),path.join(copy,'vault-dispositions.json'));fs.chmodSync(path.join(copy,'vault-dispositions.json'),0o600);
 const restored=new SecretVault(copy,f.port,{restoreFromBackup:true,erasureSourceVault:f.vault});f.vault.rename(a.reference,'Locker number');assert.equal(restored.search('mailbox').length,0);assert.equal(restored.search('locker').length,1);
 f.vault.forget(a.reference);assert.equal(restored.search('').length,0);assert.throws(()=>restored.revealPrivate(a.reference,{confirmed:true}));assert.throws(()=>f.vault.resolve(a.reference,'operator'));const dispositions=JSON.parse(fs.readFileSync(path.join(f.home,'vault-dispositions.json'),'utf8'));for(const metadata of Object.values(dispositions.refs))assert.deepEqual(Object.keys(metadata).sort(),['purpose','state']);assert.doesNotMatch(JSON.stringify(dispositions),/Mailbox|Locker|"818"/);
});
test('host failures cannot leak diagnostics through private guide',async t=>{
 const f=fixture(t),vault=new SecretVault(f.home,()=>{throw Error('synthetic-private-diagnostic-canary');}),out=output();assert.equal((await guide({message:'Save my mailbox number 818',input:new Terminal(['yes\r']),output:out,vault})).state,'unavailable');assert.doesNotMatch(out.text(),/canary/);
});

test('a selection renamed or revoked while confirmation is open cannot be revealed or mutated',async t=>{
 for(const action of ['reveal','remove','rename']){
  const f=fixture(t),saved=f.vault.put('818','operator',{kind:'private_identifier',name:'Mailbox number'}),out=output();f.calls.length=0;
  const input=new Terminal([stream=>{f.vault.rename(saved.reference,'Locker number');stream.emit('data',Buffer.from('yes\r'));}]);
  const receipt=await guide({message:'/secret '+action+' Mailbox number'+(action==='rename'?' to Parking space number':''),input,output:out,vault:f.vault});
  assert.equal(receipt.state,'unavailable');assert.deepEqual(f.calls,[]);assert.doesNotMatch(out.text(),/818/);assert.match(out.text(),/changed.*\/secret list/);assert.equal(f.vault.search('Locker number').length,1);
 }
 const f=fixture(t),saved=f.vault.put('818','operator',{kind:'private_identifier',name:'Mailbox number'}),out=output();
 const input=new Terminal([stream=>{f.vault.forget(saved.reference);f.calls.length=0;stream.emit('data',Buffer.from('yes\r'));}]);
 assert.equal((await guide({message:"What's my mailbox number?",input,output:out,vault:f.vault})).state,'unavailable');assert.deepEqual(f.calls,[]);assert.doesNotMatch(out.text(),/818/);
});
test('rename collisions and empty Vault show a useful next step without writes or reads',async t=>{
 const f=fixture(t),empty=output();assert.equal((await guide({message:'/secret list',input:new Terminal(),output:empty,vault:f.vault})).state,'listed');assert.match(empty.text(),/empty.*\/vault/);
 f.vault.put('818','operator',{kind:'private_identifier',name:'Mailbox number'});f.vault.put('999','operator',{kind:'private_identifier',name:'Locker number'});f.calls.length=0;
 const out=output();assert.equal((await guide({message:'/secret rename Mailbox number to Locker number',input:new Terminal(),output:out,vault:f.vault})).state,'collision');assert.match(out.text(),/both entries are unchanged/);assert.deepEqual(f.calls,[]);
});

test('valueless identifier request captures privately, previews only digits and cancels before storage',async t=>{
 const f=fixture(t),out=output();assert.equal((await guide({message:'Save my mailbox number',input:new Terminal(['818\r','yes\r']),output:out,vault:f.vault})).state,'saved');assert.match(out.text(),/Value: 818/);assert.equal(f.vault.search('mailbox')[0].kind,'private_identifier');
 f.vault.forget(f.vault.search('mailbox')[0].reference);f.calls.length=0;
 for(const answers of [['\r'],['\x03'],['synthetic-private-canary\r'],['818\r','no\r']]){
  const display=output(),receipt=await guide({message:'Save my mailbox number',input:new Terminal(answers),output:display,vault:f.vault});assert.ok(['cancelled','invalid'].includes(receipt.state));assert.deepEqual(f.calls,[]);assert.doesNotMatch(display.text(),/synthetic-private-canary/);
 }
});
