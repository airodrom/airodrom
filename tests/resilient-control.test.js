'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const { isExpectedBridgeCommand, parseStatus } = require('../scripts/macos/resilient-control.cjs');

const root = path.resolve(__dirname, '..');

test('resilient restart process guard accepts only this bridge entrypoint', () => {
  assert.equal(isExpectedBridgeCommand(`/opt/homebrew/bin/node --experimental-sqlite ${root}/src/index.js`), true);
  assert.equal(isExpectedBridgeCommand(`/opt/homebrew/bin/node ${root}/src/mcp.js`), false);
  assert.equal(isExpectedBridgeCommand('/opt/homebrew/bin/node /tmp/other/src/index.js'), false);
  assert.equal(isExpectedBridgeCommand(''), false);
});

test('status parser returns final JSON status line', () => {
  assert.deepEqual(parseStatus('noise\n{"state":"Connected","mcp":{"ready":true}}\n'), {
    state: 'Connected',
    mcp: { ready: true }
  });
  assert.equal(parseStatus('no json'), null);
});

const { readiness, waitReadiness } = require('../scripts/macos/resilient-control.cjs');
test('readiness requires managed identity, Connected, MCP and sane database', () => {
  const good={state:'Connected',managed:true,pid:200,mcp:{ready:true}};
  const deps={command:()=>`/opt/homebrew/bin/node ${root}/src/index.js`,database:()=>true};
  assert.equal(readiness(good,deps),true);
  for(const bad of [{...good,managed:false},{...good,state:'Starting'},{...good,mcp:{ready:false}},{...good,pid:null}]) assert.equal(readiness(bad,deps),false);
  assert.equal(readiness(good,{...deps,command:()=>'/bin/node /tmp/other.js'}),false);
  assert.equal(readiness(good,{...deps,database:()=>false}),false);
});
test('bounded polling handles delayed MCP, timeout, stale PID and PID reuse', () => {
  for(const scenario of ['delayed','timeout','old-pid','beyond-bound']) {
    let time=0,calls=0;
    const result=waitReadiness({now:()=>time,sleepImpl:ms=>{time+=ms},timeoutMs:1000,oldPid:100,
      probe:()=>{calls++;if(scenario==='beyond-bound')time+=1100;return {ready:scenario!=='timeout'&&calls>=3,status:{pid:scenario==='old-pid'?100:200}}}});
    assert.equal(result.ready,scenario==='delayed');
    assert.ok(calls<=5);
  }
});
test('normal, transient-helper success, bounded recovery and terminal failure do not duplicate recovery', () => {
  const {resilientRestart}=require('../scripts/macos/resilient-control.cjs');
  for(const kind of ['normal','transient','recovery','terminal']) {
    let recoveries=0,waits=0;const actions=[];
    const deps={pidImpl:()=>100,controlImpl:action=>{actions.push(action);return {status:kind==='transient'?1:0}},
      recoverImpl:()=>{recoveries++;return {pid:100}},waitImpl:()=>{waits++;return {ready:kind==='normal'||kind==='transient'||(kind==='recovery'&&waits===2),status:{pid:200,state:'Connected',managed:true,mcp:{ready:true}}}}};
    if(kind==='terminal')assert.throws(()=>resilientRestart(deps),e=>e.result.failure_class==='readiness_timeout');
    else assert.equal(resilientRestart(deps).recovered,kind!=='normal');
    assert.equal(recoveries,kind==='recovery'||kind==='terminal'?1:0);
    assert.deepEqual(actions,recoveries?['restart','start']:['restart']);
  }
});
