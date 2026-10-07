'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {PassThrough}=require('node:stream');
const local=require('../src/local-bootstrap'),vaultModule=require('../src/secret-vault'),{interactive}=require('../src/interactive-cli');
const EXACT="Hi Airo, let's save my mailbox number 818.";
function fixture(t,{credentialRefusal=false}={}){
 const home=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'airo-inline-test-')));
 fs.chmodSync(home,0o700);t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
 const values=new Map(),calls=[],serviceCalls=[];
 const port=(op,id,value)=>{calls.push({op,id});if(op==='put')values.set(id,value);else if(op==='read')return values.get(id);};
 const CanonicalVault=vaultModule.SecretVault;
 t.mock.method(vaultModule,'SecretVault',function(directory){return new CanonicalVault(directory,port);});
 t.mock.method(local,'start',async()=>({default_runtime:'opencode'}));
 t.mock.method(local,'request',async(...args)=>{
  serviceCalls.push(args);
  if(args[1]==='/api/assistant/private-memory'&&args[2]?.action==='lookup')return {items:[]};
  if(credentialRefusal){
   if(args[1]==='/api/assistant/conversation/session')return {conversation_id:require('node:crypto').randomUUID()};
   assert.equal(args[1],'/api/assistant/input');
   return require('../src/assistant-service').submit({conversationEngine:{start(){throw Error('Credential must not reach model');}}},args[2]);
  }
  throw Error('Private input must not dispatch to service or model');
 });
 const reopen=()=>new CanonicalVault(path.join(home,'data'),port);
 const terminal=()=>{
  const input=new PassThrough(),output=new PassThrough();let text='';
  input.isTTY=true;input.isRaw=false;input.setRawMode=value=>{input.isRaw=value;};output.isTTY=true;
  output.on('data',chunk=>text+=chunk);
  const until=(expected,offset=0)=>new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>{output.off('data',check);reject(Error('Terminal did not reach expected prompt'));},2000);
   const check=()=>{if(text.slice(offset).includes(expected)){clearTimeout(timer);output.off('data',check);resolve();}};
   output.on('data',check);check();
  });
  const send=(value,expected)=>{const ready=until(expected,text.length);input.write(value);return ready;};
  const running=interactive(home,{input,output,env:{NO_COLOR:'1',TERM:'dumb'}});
  t.after(()=>input.end());
  return {input,output,until,send,running,text:()=>text};
 };
 return {home,values,calls,serviceCalls,reopen,terminal};
}
test('exact installed interaction reaches pending confirmation, canonical save and fresh restart reveal',async t=>{
 const f=fixture(t),first=f.terminal();await first.until('You › ');
 await first.send(EXACT+'\r','Choose 1–3 (hidden): ');
 await first.send('2\r','Type yes to confirm (hidden): ');
 assert.match(first.text(),/Save mailbox number in Vault\?/);
 assert.equal(f.reopen().search('mailbox number').length,0);assert.equal(f.calls.length,0);
 assert.equal(first.input.listenerCount('data'),1);assert.equal(first.input.listenerCount('readable'),0);
 const pendingOutput=first.text().length;
 await first.send('Yes\r','You › ');
 assert.match(first.text(),/Mailbox number saved in Vault/);
 assert.doesNotMatch(first.text().slice(pendingOutput),/\b818\b/);
 const rows=f.reopen().search('Mailbox number');assert.equal(rows.length,1);assert.equal(rows[0].kind,'private_identifier');assert.equal(f.values.get(rows[0].reference),'818');
 assert.throws(()=>f.reopen().resolve(rows[0].reference,'gmail'));assert.throws(()=>f.reopen().revealPrivate(rows[0].reference,{confirmed:false}));
 assert.doesNotMatch(fs.readFileSync(path.join(f.home,'data/vault-dispositions.json'),'utf8'),/\b818\b/);
 await first.send('/quit\r','Local service remains available');await first.running;
 assert.equal(first.input.isRaw,false);assert.equal(first.input.listenerCount('data'),0);
 const restarted=f.terminal();await restarted.until('You › ');
 await restarted.send("What's my mailbox number?\r",'Type yes to reveal (hidden): ');
 assert.match(restarted.text(),/Reveal mailbox number from Vault in this terminal\?/);
 assert.doesNotMatch(restarted.text(),/\b818\b/);assert.deepEqual(f.calls.map(c=>c.op),['put']);
 await restarted.send('yes\r','You › ');assert.match(restarted.text(),/Your mailbox number is 818/);
 await restarted.send('/quit\r','Local service remains available');await restarted.running;
 assert.deepEqual(f.calls.map(c=>c.op),['put','read']);assert.ok(f.serviceCalls.every(call=>call[1]==='/api/assistant/private-memory'&&call[2]?.action==='lookup'&&!('value' in call[2])));
 assert.equal(restarted.input.isRaw,false);assert.equal(restarted.input.listenerCount('data'),0);
});
test('exact terminal save rejects no, dismissal and pasted confirmation without model dispatch',async t=>{
 const f=fixture(t),cli=f.terminal();await cli.until('You › ');
 for(const answer of ['no\r','\r','\x03']){
  await cli.send(EXACT+'\rYes\rpasted-private-canary\r','Choose 1–3 (hidden): ');
  await cli.send('2\r','Type yes to confirm (hidden): ');
  assert.equal(f.calls.length,0);assert.equal(f.reopen().search('mailbox number').length,0);
  await cli.send(answer,'You › ');
 }
 assert.equal(f.calls.length,0);assert.doesNotMatch(cli.text(),/pasted-private-canary/);assert.ok(f.serviceCalls.every(call=>call[1]==='/api/assistant/private-memory'&&call[2]?.action==='lookup'&&!('value' in call[2])));
 await cli.send('/quit\r','Local service remains available');await cli.running;
 assert.equal(cli.input.isRaw,false);assert.equal(cli.input.listenerCount('data'),0);
});
test('terminal duplicate save cannot overwrite and ambiguous natural lookup needs selection then confirmation',async t=>{
 const f=fixture(t);local.privateDirectory(path.join(f.home,'data'),true);
 const vault=f.reopen(),saved=vault.put('999','operator',{kind:'private_identifier',name:'Mailbox number'}),cli=f.terminal();await cli.until('You › ');
 await cli.send(EXACT+'\r','Choose 1–3 (hidden): ');await cli.send('2\r','You › ');assert.match(cli.text(),/That label already exists/);assert.equal(f.values.get(saved.reference),'999');
 vault.rename(saved.reference,'Mailbox number east');vault.put('818','operator',{kind:'private_identifier',name:'Mailbox number west'});f.calls.length=0;
 await cli.send("What's my mailbox number?\r",'Choose an entry number, or 0 to cancel (hidden): ');
 assert.equal(f.calls.length,0);await cli.send('0\r','You › ');assert.equal(f.calls.length,0);
 await cli.send("What's my mailbox number?\r",'Choose an entry number, or 0 to cancel (hidden): ');
 await cli.send('2\r','Type yes to reveal (hidden): ');assert.equal(f.calls.length,0);
 await cli.send('yes\r','You › ');assert.match(cli.text(),/Your mailbox number west is 818/);assert.deepEqual(f.calls.map(c=>c.op),['read']);
 await cli.send('/quit\r','Local service remains available');await cli.running;assert.ok(f.serviceCalls.every(call=>call[1]==='/api/assistant/private-memory'&&call[2]?.action==='lookup'&&!('value' in call[2])));
});
test('greeted let us credential input stays refused by real host router without model or Vault calls',async t=>{
 const f=fixture(t,{credentialRefusal:true}),cli=f.terminal();await cli.until('You › ');
 for(const text of ["Hi Airo, let's save my password synthetic-credential.",'Hi Airo, let’s save my mailbox number PIN 818.','Hello Airodrom, let us save my mailbox number sk-proj-syntheticcanary.']){
  const offset=cli.text().length;await cli.send(text+'\r','You › ');
  assert.match(cli.text().slice(offset),/not secure input/);assert.doesNotMatch(cli.text().slice(offset),/Yes or no \(hidden/);
 }
 assert.equal(f.calls.length,0);assert.equal(f.values.size,0);
 await cli.send('/quit\r','Local service remains available');await cli.running;
 assert.equal(f.serviceCalls.length,0);
});
