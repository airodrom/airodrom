'use strict';
// Presentation only. These views never grant authority or qualify a route.
const clean = value => require('node:util').stripVTControlCharacters(String(value ?? 'Unavailable')).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '');
const names = {opencode:'OpenCode',ollama:'Ollama',codex:'Codex / Work',claude_code:'Claude Code',cursor:'Cursor',gmail:'Gmail',whatsapp:'WhatsApp'};
const name = value => names[value] || clean(value).replaceAll('_',' ');
const list = values => values?.length ? values.map(name).join(' · ') : 'None';
const row = (label,value) => `  ${label.padEnd(14)} ${clean(value)}\n`;
function models(catalog,selection='auto') {
 let out='MODELS\n\n';
 for(const m of catalog.models){const selected=selection===m.id||['auto','local'].includes(selection)&&m.available;
  out+=`${m.available?'●':'○'} ${clean(m.name)}${selected?' · CURRENT':''}\n`+row('ID',m.id)+row('Provider',name(m.provider))+row('Worker',list(m.workers)+' '+(m.runtime_version||''))+row('Location',name(m.locality))+row('Status',name(m.qualification)+' · '+(m.available?'Ready':'Unavailable'))+row('Privacy',list(m.data_classes))+row('Tasks',list(m.tasks))+row('Context',m.effective_context_limit??m.context_limit??'Not reported')+row('Cost',m.cost??'Not reported')+'\n';
 }
 return out+`Routing: ${selection==='auto'?'AUTO':'MANUAL · '+clean(selection)}\n/model <qualified-id> · /model local · /model auto\n`;
}
function workers(catalog,selection='auto') {
 let out='WORKERS\n\n';for(const w of catalog.workers)out+=`${w.qualification==='denied'?'×':w.available?'●':'○'} ${name(w.id)} · ${w.available?'READY':w.qualification==='denied'?'DENIED':'NOT QUALIFIED'}\n`+row('Location',name(w.locality))+row('Support',name(w.support))+row('Qualification',name(w.qualification))+row('Capabilities',list(w.capabilities))+'\n';
 return out+`Routing: ${selection==='auto'?'AUTO':'MANUAL · '+name(selection)}\n/worker <qualified-id> · /worker auto\n`;
}
function connectors(data) {
 let out='CONNECTORS\n\n';for(const c of data.items||[])out+=`${name(c.id)} · ${c.state==='ready'?'Ready':c.state==='unavailable'?'Not connected / unavailable':name(c.state)}\n`+row('Protocol',c.protocol)+row('Access',c.read_only?'Read-only':'Not reported')+row('Qualification',c.live_qualified?'Live qualified':'Not live qualified')+row('Setup',c.setup)+row('Actions',c.mutations)+'\n';return out;
}
function memories(data) {
 if(!data.items?.length)return 'No current memories found.\n';
 return 'MEMORY V2 · Current personal references\n\n'+data.items.map(m=>clean(m.content)+'\n'+row('ID',m.memoryId||m.id)+row('Source',m.source||'Current canonical Memory')).join('\n');
}
function sensitive(data) {
 if(data.operator_only&&typeof data.content==='string')return 'SENSITIVE MEMORY · Explicit operator reveal\n'+clean(data.content)+'\n'+row('ID',data.memoryId);
 return 'SENSITIVE MEMORY · Operator-only\n'+(data.items?.length?data.items.map(m=>row('ID',m.memoryId)).join(''):'No sensitive records observed.\n')+clean(data.disclosure||'Explicit reveal by ID. No worker injection.')+'\n'+clean(data.encryption||'Private local storage; no field-level encryption claim.')+'\n';
}
function vault(data) {return 'SECRET VAULT\n'+row('Backend',data.backend)+row('Helper',data.configured?'Configured':'Not configured')+row('Active refs',data.active_refs??'Unavailable')+'Values stay hidden. Workers have no access.\n';}
function receipt(data) {
 if(data.kind==='memory')return memories(data);
 if(data.message)return clean(data.message)+'\n'+(data.choices?.length?data.choices.map(m=>row(m.subject||'Memory ID',m.memoryId)).join(''):'');
 if(data.items)return data.items.length?data.items.map(m=>[m.subject,m.from,m.snippet,m.text,m.content,m.id].filter(v=>typeof v==='string').map(clean).join('\n')).join('\n\n')+'\n':'No matching items.\n';
 if(data.state||data.status)return row('Status',name(data.state||data.status));
 return 'Request handled.\n';
}
function rail(m) {return '────────────────────────────────────────\n'+`${m.model?.id||'Model unavailable'} · ${name(m.model?.locality||'local')} · ${name(m.runtime)}\n`+`Memory: ${m.memory?.selected_count??'Unavailable'} selected · ${m.memory?.delivery||'Unavailable'}\n`+`Response: ${['awaiting_acceptance','completed'].includes(m.state)?'ready':name(m.state)} · Verification: ${name(m.verification?.status)}\nReview: ${m.acceptance?.status==='accept'?'accepted':'/accept'} · Settlement: ${name(m.settlement?.status)}\n`+'────────────────────────────────────────\n';}
const waitingDots=[[1,2,4,64],[8,16,32,128]];
const waitingPalette=[[110,105,220],[80,145,255],[69,200,220],[85,210,175]];
function waitingFrame({elapsed=0,columns=80,mode='none',reduced=false}={}) {
 const seconds=(Math.max(0,elapsed)/1000).toFixed(1)+'s';
 const width=Math.max(0,Math.floor(columns)-1); // Leave the wrap column unused.
 const label='⠿ Thinking', room=width-label.length-seconds.length-4;
 if(room<4)return (width>=seconds.length+2?'⠿ '+seconds:seconds).slice(0,width);
 const length=Math.min(20,room),time=reduced?0:Math.max(0,elapsed)/1000;
 const bar=Array.from({length},(_,i)=>{
  // Rise and fall inside the logo's eight-dot cells, keeping cleanup on one line.
  const pulse=(Math.sin(i*.48-time*4.1)+1)/2,thickness=.55+pulse*.65;
  let mask=0;
  for(let x=0;x<2;x++){
   const center=1.5+1.05*Math.sin((i*2+x)*.36-time*2.8);
   for(let y=0;y<4;y++)if(Math.abs(y-center)<thickness)mask|=waitingDots[x][y];
  }
  const char=String.fromCharCode(0x2800+mask);
  if(mode==='none')return char;
  const hue=(Math.sin(i*.24-time*1.2)+1)/2,position=hue*(waitingPalette.length-1);
  const stop=Math.min(waitingPalette.length-2,Math.floor(position)),mix=position-stop;
  const rgb=waitingPalette[stop].map((v,n)=>Math.round(v+(waitingPalette[stop+1][n]-v)*mix));
  const color=mode==='truecolor'?`38;2;${rgb.join(';')}`:mode==='256'?`38;5;${16+36*Math.round(rgb[0]/51)+6*Math.round(rgb[1]/51)+Math.round(rgb[2]/51)}`:[35,34,36,96][Math.round(hue*3)];
  return `\x1b[${color}m${char}`;
 }).join('')+(mode==='none'?'':'\x1b[0m');
 return `${label}  ${bar}  ${seconds}`;
}
function waiting(output,{env=process.env,signal,now=()=>performance.now(),schedule=setInterval,unschedule=clearInterval}={}) {
 if(!output.isTTY||env.TERM==='dumb'||signal?.aborted)return {stop(){}};
 const started=now(),mode=require('./terminal-brand').colorMode({tty:true,env});
 const reduced=/^(1|true|yes)$/i.test(env.AIRODROM_REDUCED_MOTION||env.REDUCE_MOTION||'');
 let stopped=false,timer;
 const draw=()=>{if(!stopped)output.write('\r'+waitingFrame({elapsed:now()-started,columns:output.columns||80,mode,reduced})+'\x1b[K');};
 const stop=()=>{if(stopped)return;stopped=true;unschedule(timer);signal?.removeEventListener('abort',stop);output.write('\r\x1b[2K');};
 draw();timer=schedule(draw,reduced?1000:80);timer.unref?.();
 signal?.addEventListener('abort',stop,{once:true});
 return {stop};
}
module.exports={clean,name,models,workers,connectors,memories,sensitive,vault,receipt,rail,waitingFrame,waiting};
