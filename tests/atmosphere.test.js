'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
test('weather presets persist, stop when hidden or reduced motion, and restart with one loop',()=>{
 const events={},queries={},frames=new Map(),stored=new Map();let seq=0,draws=0;
 const ctx=new Proxy({createLinearGradient:()=>({addColorStop(){}}),createRadialGradient:()=>({addColorStop(){}}),clearRect(){draws++;}},{get:(o,k)=>o[k]||(()=>{})});
 const canvas={getContext:()=>ctx,hidden:false,style:{}},buttons=['auto','rain','sunrise','sunset','off'].map(mode=>({dataset:{weather:mode},setAttribute(k,v){this[k]=v;},addEventListener(k,fn){this[k]=fn;}}));
 const document={hidden:false,getElementById:id=>id==='atmosphere'?canvas:{querySelectorAll:()=>buttons,querySelector:()=>null},addEventListener:(k,fn)=>events[k]=fn};
 vm.runInNewContext(fs.readFileSync(require.resolve('../public/atmosphere.js'),'utf8'),{document,performance:{now:()=>1000},window:{innerWidth:375,innerHeight:812,devicePixelRatio:3,addEventListener:(k,fn)=>events[k]=fn},matchMedia:q=>queries[q] ||= {matches:false,addEventListener(k,fn){this.change=fn;}},localStorage:{getItem:k=>stored.get(k),setItem:(k,v)=>stored.set(k,v)},innerWidth:375,innerHeight:812,devicePixelRatio:3,requestAnimationFrame:fn=>{frames.set(++seq,fn);return seq;},cancelAnimationFrame:id=>frames.delete(id),addEventListener:(k,fn)=>events[k]=fn});
 assert.equal(frames.size,1);const [firstId,firstFrame]=frames.entries().next().value;frames.delete(firstId);firstFrame(30000);assert.equal(frames.size,1);assert.equal(canvas.width,375);buttons[2].click();assert.equal(buttons[2]['aria-pressed'],'true');assert.equal(stored.get('airodrom.atmosphere.v1'),'sunrise');assert.equal(frames.size,1);
 document.hidden=true;events.visibilitychange();assert.equal(frames.size,0);document.hidden=false;events.visibilitychange();assert.equal(frames.size,1);
 const reduced=queries['(prefers-reduced-motion: reduce)'];reduced.matches=true;reduced.change();assert.equal(frames.size,0);const before=draws;buttons[3].click();assert.ok(draws>before);assert.equal(frames.size,0);
 reduced.matches=false;reduced.change();assert.equal(frames.size,1);buttons[4].click();assert.equal(frames.size,0);assert.equal(canvas.hidden,true);buttons[0].click();assert.equal(frames.size,1);events.pagehide();assert.equal(frames.size,0);
});
test('existing dashboard route carries the exact scene source without requiring a new endpoint',()=>{
 const hub=fs.readFileSync(require.resolve('../public/control-hub.js'),'utf8'),source=fs.readFileSync(require.resolve('../public/atmosphere.js'),'utf8');
 assert.ok(hub.includes('// BEGIN generated atmosphere compatibility bundle; source: public/atmosphere.js\n'+source));assert.equal(hub.split('// BEGIN generated atmosphere compatibility bundle').length,2);
 assert.doesNotMatch(fs.readFileSync(require.resolve('../public/control-hub.html'),'utf8'),/src="\/atmosphere.js"/);
});
test('control-hub HTML keeps premium mount fingerprint to prevent silent UI replacement',()=>{
 const html=fs.readFileSync(require.resolve('../public/control-hub.html'),'utf8');
 const css=fs.readFileSync(require.resolve('../public/control-hub.css'),'utf8');
 const js=fs.readFileSync(require.resolve('../public/control-hub.js'),'utf8');
 assert.match(html,/id="atmosphere"/);
 assert.match(html,/id="weather-switcher"/);
 assert.match(html,/id="theme"/);
 assert.match(html,/AIRODROM/);
 assert.match(html,/CONTROL CENTER/);
 assert.match(html,/aria-label="Weather atmosphere"/);
 assert.match(html,/data-weather="auto"/);
 assert.match(html,/data-weather="rain"/);
 assert.match(html,/data-weather="sunrise"/);
 assert.match(html,/data-weather="sunset"/);
 assert.match(html,/data-weather="off"/);
 assert.ok(html.length>=4500,'control-hub.html regresses toward stripped mount surface');
 assert.match(css,/#weather-switcher|#atmosphere/);
 assert.match(js,/LIVE MISSION OBSERVATORY/);
 assert.match(js,/BEGIN generated atmosphere compatibility bundle/);
});
