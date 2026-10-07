'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough, Readable } = require('node:stream');
const local = require('../src/local-bootstrap');
const { interactive, waitConversation, help } = require('../src/interactive-cli');

function fixture(t, request, {nickname}={}) {
  const calls = [], output = new PassThrough();
  let text = ''; output.on('data', chunk => text += chunk);
  t.mock.method(local, 'start', async () => ({ default_runtime: 'opencode', nickname }));
  t.mock.method(local, 'request', async (home, route, body) => { if(route==='/api/interactive/memory?query=name')return {items:[]};calls.push({ route, body }); return request(route, body); });
  return { calls, output, text: () => text };
}
test('ordinary typing echoes before Enter, edits the submitted line and does not duplicate it', async t => {
 const previousTerm=process.env.TERM;process.env.TERM='xterm';t.after(()=>{if(previousTerm===undefined)delete process.env.TERM;else process.env.TERM=previousTerm;});
 const f=fixture(t,(route,body)=>{
  if(route==='/api/assistant/conversation/session')return {conversation_id:'session'};
  if(route==='/api/assistant/input'){assert.equal(body.message,'Explain stars');return {kind:'chat',conversation_id:'session',turn_id:'turn'};}
  return {state:'completed',summary:'Synthetic answer.'};
 });
 const input=new PassThrough();input.isTTY=true;input.isRaw=false;input.setRawMode=v=>input.isRaw=v;f.output.isTTY=true;f.output.columns=32;
 t.after(()=>input.end());
 const wait=needle=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>{f.output.off('data',check);reject(Error('Expected synthetic output unavailable'));},2000);const check=()=>{if(f.text().includes(needle)){clearTimeout(timer);f.output.off('data',check);resolve();}};f.output.on('data',check);check();});
 const running=interactive('synthetic',{input,output:f.output,env:{NO_COLOR:'1',TERM:'dumb'}});
 await wait('You › ');input.write('\r');await new Promise(resolve=>setImmediate(resolve));input.write('Explain starx');
 assert.match(f.text(),/Explain starx/);assert.deepEqual(f.calls,[]);
 input.write('\x7fs');assert.deepEqual(f.calls,[]);input.write('\r');
 await wait('Synthetic answer.');await new Promise(resolve=>setImmediate(resolve));input.write('/quit\r');await running;
 assert.equal(f.calls.filter(c=>c.route==='/api/assistant/input').length,1);
 assert.doesNotMatch(f.text(),/Input appears after Enter|\u001b\[(?:3\d|9\d)m/);
 assert.equal(input.isRaw,false);assert.equal(input.listenerCount('data'),0);
});
test('natural Vault lists and malformed identifiers remain entirely in local operator ingress', async t => {
 const f=fixture(t,()=>{throw Error('Vault text must not leave ingress');}),input=new PassThrough();input.isTTY=true;input.isRaw=false;input.setRawMode=v=>input.isRaw=v;f.output.isTTY=true;
 let observed=false;t.mock.method(require('../src/natural-private-vault'),'guide',async options=>{assert.equal(options.message,'Show my saved secrets.');assert.equal(input.listenerCount('data'),0);observed=true;setImmediate(()=>input.write('Airo, save my mailbox number 818.sdfasfdassdafsdf\r'));return {state:'listed'};});
 f.output.on('data',chunk=>{if(String(chunk).includes('Quoted, negated or ambiguous'))setImmediate(()=>input.write('/quit\r'));});
 const running=interactive('synthetic',{input,output:f.output,env:{NO_COLOR:'1',TERM:'dumb'}});setImmediate(()=>input.write('Show my saved secrets.\r'));await running;
 assert.equal(observed,true);assert.deepEqual(f.calls,[]);assert.equal(input.isRaw,false);
});
test('natural private identifier stays in detached operator ingress with zero service calls',async t=>{
 const f=fixture(t,()=>{throw Error('Private data must not reach service');}),input=new PassThrough();input.isTTY=true;input.isRaw=false;input.setRawMode=v=>{input.isRaw=v;};f.output.isTTY=true;
 let seen=false;t.mock.method(require('../src/personal-storage-guide'),'guide',async options=>{assert.equal(options.message,'Hi Airo, save my mailbox number 818');assert.equal(input.listenerCount('data'),0);assert.equal(input.listenerCount('readable'),0);seen=true;options.output.write('Saved as Mailbox number.\n');setImmediate(()=>input.write('/quit\n'));return {state:'saved'};});
 const running=interactive('synthetic',{input,output:f.output,env:{NO_COLOR:'1',TERM:'dumb'}});setImmediate(()=>input.write('Hi Airo, save my mailbox number 818\npasted-private-canary\n'));await running;
 assert.equal(seen,true);assert.equal(f.calls.length,0);assert.doesNotMatch(f.text(),/pasted-private-canary/);assert.equal(input.isRaw,false);assert.equal(input.listenerCount('data'),0);
});
test('noninteractive private input is refused without value echo or service forwarding',async t=>{
 const f=fixture(t,()=>{throw Error('Private data must not reach service');});await interactive('synthetic',{input:Readable.from(['Save my mailbox number 818\n/quit\n']),output:f.output,env:{NO_COLOR:'1',TERM:'dumb'}});assert.equal(f.calls.length,0);assert.doesNotMatch(f.text(),/818/);assert.match(f.text(),/interactive operator terminal/);
});
test('persisted assistant nickname addresses enter detached save and reveal without forwarding private text',async t=>{
 for(const message of ["Nova, let's save my mailbox number 818.","Nova, what's my mailbox number?"]){
  const f=fixture(t,()=>{throw Error('Private text must stay local');},{nickname:'Nova'}),input=new PassThrough();input.isTTY=true;input.isRaw=false;input.setRawMode=value=>{input.isRaw=value;};f.output.isTTY=true;
  let seen=false;t.mock.method(require('../src/personal-storage-guide'),'guide',async options=>{assert.equal(options.message,message);assert.equal(options.plan.kind,'private_storage');assert.equal(options.plan.action,message.includes('save')?'save':'reveal');assert.doesNotMatch(JSON.stringify(options.plan),/\b818\b/);assert.equal(input.listenerCount('data'),0);seen=true;setImmediate(()=>input.write('/quit\n'));return {state:'cancelled'};});
  const running=interactive('synthetic',{input,output:f.output,env:{NO_COLOR:'1',TERM:'dumb'}});setImmediate(()=>input.write(message+'\n'));await running;assert.equal(seen,true);assert.equal(f.calls.length,0);assert.doesNotMatch(JSON.stringify(f.calls),/\b818\b/);
 }
});

test('direct terminal conversation reuses host session and prints prose without Mission UI', async t => {
  let turn = 0;
  const f = fixture(t, (route, body) => {
    if (route === '/api/assistant/conversation/session') return { conversation_id: 'host-session' };
    if (route === '/api/assistant/input') {
      assert.equal(body.conversation_id, 'host-session');
      assert.equal(body.workspace, require('node:fs').realpathSync(process.cwd()));
      return { kind: 'chat', conversation_id: 'host-session', turn_id: 'turn-' + ++turn, state: 'running' };
    }
    assert.match(route, /^\/api\/assistant\/conversation\?conversation_id=host-session&turn_id=turn-/);
    return { state: 'completed', summary: 'Hi! How can I help?\u001b]52;c;ZGF0YQ==\u0007' };
  });
  await interactive('synthetic', { input: Readable.from(['Hi\nHow are you?\n/quit\n']), output: f.output, env: { NO_COLOR: '1', TERM: 'dumb' } });
  assert.equal(f.calls.filter(c => c.route === '/api/assistant/conversation/session').length, 1);
  assert.equal(f.calls.filter(c => c.route === '/api/assistant/input').length, 2);
  assert.doesNotMatch(JSON.stringify(f.calls), /interactive\/task|interactive\/cancel|control-v2/);
  assert.match(f.text(), /Airo\nHi! How can I help\?/);
  assert.doesNotMatch(f.text(), /Acceptance|Verification|Settlement|Mission|ZGF0YQ==|\u001b/);
});

test('cancelled direct turn uses Conversation Engine cancellation and never Mission cancellation', async t => {
  const controller = new AbortController(); controller.abort();
  const f = fixture(t, route => { assert.equal(route, '/api/assistant/conversation/cancel'); return { state: 'cancelled' }; });
  await assert.rejects(waitConversation('synthetic', { conversation_id: 'host-session', turn_id: 'turn' }, { signal: controller.signal }), /Conversation cancelled/);
  assert.deepEqual(f.calls, [{ route: '/api/assistant/conversation/cancel', body: { conversation_id: 'host-session', turn_id: 'turn' } }]);
});

test('conversation polling failure requests cancellation to clean up inference', async t => {
  const f = fixture(t, route => {
    if (route.includes('?')) throw Error('Local response unavailable');
    assert.equal(route, '/api/assistant/conversation/cancel'); return { state: 'cancelled' };
  });
  await assert.rejects(waitConversation('synthetic', { conversation_id: 'host-session', turn_id: 'turn' }), /Local response unavailable/);
  assert.equal(f.calls.at(-1).route, '/api/assistant/conversation/cancel');
});

test('manual Mission controls use host routing and preserve the selected Mission', async t => {
  const f = fixture(t, (route, body) => {
    assert.equal(route, '/api/assistant/mission');
    if (body.action === 'new') return { kind: 'mission', mission_id: 'work-id', state: 'draft', message: 'Choose declared files and verification before dispatch.' };
    if (body.action === 'list') return { kind: 'missions', items: [{ id: 'work-id', objective: 'Fix this repository', state: 'draft' }] };
    assert.equal(body.mission_id, 'work-id');
    if (body.action === 'status') return { kind: 'mission_status', mission: { id: 'work-id', objective: 'Fix this repository', state: 'draft' } };
    return { kind: 'mission', mission_id: 'work-id', state: 'cancelled', message: 'Mission cancelled.' };
  });
  await interactive('synthetic', { input: Readable.from(['/mission new Fix this repository\n/mission list\n/mission status\n/mission cancel\n/quit\n']), output: f.output, env: { NO_COLOR: '1', TERM: 'dumb' } });
  assert.deepEqual(f.calls.map(c => c.body.action), ['new', 'list', 'status', 'cancel']);
  assert.match(f.text(), /Mission work-id · draft/);
  assert.match(f.text(), /Mission cancelled/);
  for (const verb of ['new', 'list', 'status', 'cancel']) assert.ok(help().includes('/mission ' + verb));
});

test('disconnected Gmail offers explicit authorization without opening OAuth', async t => {
  const f = fixture(t, route => {
    if (route === '/api/assistant/conversation/session') return { conversation_id: 'host-session' };
    assert.equal(route, '/api/assistant/input');
    return { kind: 'connect_required', connector: 'gmail', can_start_oauth: true, message: 'Gmail is not connected.' };
  });
  await interactive('synthetic', { input: Readable.from(['Check my Gmail.\n/quit\n']), output: f.output, env: { NO_COLOR: '1', TERM: 'dumb' } });
  assert.match(f.text(), /Type \/connect gmail to authorize access in your browser/);
  assert.doesNotMatch(JSON.stringify(f.calls), /assistant\/connect"/);
});

test('non-TTY Vault requests fail closed before accepting secrets', async t => {
  const f = fixture(t, route => {
    if (route === '/api/assistant/conversation/session') return { conversation_id: 'host-session' };
    return { kind: 'vault', action: 'menu' };
  });
  await interactive('synthetic', { input: Readable.from(['Save a password\n/quit\n']), output: f.output, env: { NO_COLOR: '1', TERM: 'dumb' } });
  assert.match(f.text(), /Secure Vault requires an interactive operator terminal/);
  assert.doesNotMatch(JSON.stringify(f.calls), /Secret \(hidden/);
});

test('terminal secure boundary drops pasted follow-up text and detaches ordinary readline', async t => {
  const f = fixture(t, route => route === '/api/assistant/conversation/session' ? { conversation_id: 'host-session' } : { kind: 'vault', action: 'menu' });
  const input = new PassThrough(); input.isTTY = true; input.isRaw = false;
  input.setRawMode = enabled => { input.isRaw = enabled; };
  f.output.isTTY = true;
  let observed = null;
  t.mock.method(require('../src/secure-vault-guide'), 'guide', async options => {
    observed = { input: options.input === input, data: input.listenerCount('data'), readable: input.listenerCount('readable'), raw: input.isRaw };
    options.output.write('SECRET VAULT\n');
    input.write('split-queued-private-canary\n');
    setImmediate(() => input.write('/quit\n'));
    return { state: 'cancelled' };
  });
  const running = interactive('synthetic', { input, output: f.output, env: { NO_COLOR: '1', TERM: 'dumb' } });
  setImmediate(() => input.write('Save a password\npasted-private-value\n'));
  await running;
  assert.deepEqual(observed, { input: true, data: 0, readable: 0, raw: false });
  assert.doesNotMatch(f.text(), /pasted-private-value|split-queued-private-canary/);
  assert.doesNotMatch(JSON.stringify(f.calls), /pasted-private-value|split-queued-private-canary/);
  assert.equal(input.isRaw, false);
  assert.equal(input.listenerCount('data'), 0);
});

test('live terminal Control-C cancels direct inference and cleans the existing fish wave', async t => {
  const input = new PassThrough(); input.isTTY = true; input.isRaw = false;
  input.setRawMode = enabled => { input.isRaw = enabled; };
  const f = fixture(t, route => {
    if (route === '/api/assistant/conversation/session') return { conversation_id: 'host-session' };
    if (route === '/api/assistant/input') return { kind: 'chat', conversation_id: 'host-session', turn_id: 'turn', state: 'running' };
    if (route.includes('?')) { setImmediate(() => input.write('\u0003')); return { state: 'running' }; }
    assert.equal(route, '/api/assistant/conversation/cancel');
    setImmediate(() => input.write('/quit\n')); return { state: 'cancelled' };
  });
  f.output.isTTY = true; f.output.columns = 80; f.output.rows = 40;
  const running = interactive('synthetic', { input, output: f.output, env: { NO_COLOR: '1', TERM: 'xterm' } });
  setImmediate(() => input.write('Hi\n'));
  await running;
  assert.match(f.text(), /Thinking.*><o>/);
  assert.match(f.text(), /\r\u001b\[2K/);
  assert.match(f.text(), /Conversation cancelled/);
  assert.equal(f.calls.filter(c => c.route === '/api/assistant/conversation/cancel').length, 1);
  assert.doesNotMatch(JSON.stringify(f.calls), /interactive\/cancel/);
  assert.equal(input.isRaw, false);
});

test('private save detaches ordinary input, discards pasted text and forwards only host plan to native guide', async t => {
 const phrase="Hi Airo, let's save my mailbox number 818.";
 const f=fixture(t,route=>route==='/api/assistant/conversation/session'?{conversation_id:'host-session'}:{kind:'private_storage',action:'save',label:'Mailbox number',value_present:true});
 const input=new PassThrough();input.isTTY=true;input.isRaw=false;input.setRawMode=value=>{input.isRaw=value;};f.output.isTTY=true;
 let observed;
 t.mock.method(require('../src/personal-storage-guide'),'guide',async options=>{
  observed={data:input.listenerCount('data'),readable:input.listenerCount('readable'),message:options.message,plan:options.plan};
  setImmediate(()=>input.write('/quit\n'));return {state:'cancelled'};
 });
 const running=interactive('synthetic',{input,output:f.output,env:{NO_COLOR:'1',TERM:'dumb'}});
 setImmediate(()=>input.write(phrase+'\npasted-private-canary\n'));await running;
 assert.equal(observed.data,0);assert.equal(observed.readable,0);assert.equal(observed.message,phrase);assert.doesNotMatch(JSON.stringify(observed.plan),/818/);
 assert.deepEqual(f.calls,[]);assert.doesNotMatch(f.text()+JSON.stringify(f.calls),/pasted-private-canary/);assert.equal(input.listenerCount('data'),0);assert.equal(input.isRaw,false);
});

test('non-interactive credentials are redacted and refused locally before any backend request', async t => {
 const f=fixture(t,()=>{throw Error('Credential must never leave the terminal');});
 await interactive('synthetic',{input:Readable.from(['Hi Airo, save my password synthetic-private-canary\n/quit\n']),output:f.output,env:{NO_COLOR:'1',TERM:'dumb'}});
 assert.deepEqual(f.calls,[]);assert.doesNotMatch(f.text(),/synthetic-private-canary/);assert.match(f.text(),/not secure input/);
});
