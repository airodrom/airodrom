'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../public/control-hub.js'),'utf8');
function disclosureFactory(state){
  const begin=source.indexOf('function persistentMissionPanel(');
  const end=source.indexOf('\n function missionDetail(m){',begin);
  assert.ok(begin>=0&&end>begin,'persistent disclosure helper is present');
  const code=source.slice(begin,end).trim();
  const node=(tag,label)=>({
    tag,label,dataset:{},open:false,isConnected:true,children:[],handlers:new Map(),
    append(...parts){this.children.push(...parts);},
    addEventListener(name,fn){this.handlers.set(name,fn);}
  });
  return new Function('node','openMissionPanels','return ('+code+');')(node,state);
}
function toggle(el,open){el.open=open;el.handlers.get('toggle')();}
test('execution stages remain expanded across rebuilt Mission views',()=>{
  const state=new Map(),panel=disclosureFactory(state);
  const first=panel('mission-1','stages','Execution stages',{});
  assert.equal(first.open,false);
  toggle(first,true);
  for(let i=0;i<12;i++)assert.equal(panel('mission-1','stages','Execution stages',{}).open,true);
  const second=panel('mission-1','technical','Technical diagnostics',{});
  assert.equal(second.open,false);
  toggle(second,true);
  assert.equal(panel('mission-1','technical','Technical diagnostics',{}).open,true);
  assert.equal(panel('mission-2','stages','Execution stages',{}).open,false);
});
test('detached asynchronous toggle cannot accidentally collapse a live disclosure',()=>{
  const state=new Map(),panel=disclosureFactory(state);
  const first=panel('mission-1','stages','Execution stages',{});
  toggle(first,true);
  first.isConnected=false;
  toggle(first,false);
  assert.equal(panel('mission-1','stages','Execution stages',{}).open,true);
});
test('live logs expose recorded observations, not invented worker stdout',()=>{
  assert.match(source,/View Live Logs/);
  assert.match(source,/missionDetailTab==='Live Logs'/);
  assert.match(source,/timestamped Airodrom host observations, not a raw worker terminal/);
  assert.match(source,/No actively executing worker confirmed for this Mission/);
  assert.match(source,/dataset\.focusKey='live-log-search'/);
  assert.match(source,/dataset\.focusKey='live-log-category'/);
});
test('Live Activity surfaces uncertain Run ownership for review',()=>{
  assert.match(source,/Ownership unverified — review required/);
  assert.match(source,/Unverified ownership/);
  assert.match(source,/Unknown ownership/);
  assert.match(source,/run_ownership/);
  assert.match(source,/unverified_runs/);
  assert.match(source,/unknown_ownership_runs/);
});
