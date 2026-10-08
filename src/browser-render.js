'use strict';
const clean=v=>require('./interactive-cli').terminalText(String(v));
function render(row){
 if(row.modes)return 'AIRODROM · BROWSER ACCESS\n'+row.modes.map(m=>m.id+'. '+m.label+(m.available?(m.qualification?' · checks on open':''):' · unavailable')+'\n   '+m.reason).join('\n')+'\nSearch: unqualified · PDF reader: unqualified\n';
 if(row.sessions)return row.sessions.length?row.sessions.map(render).join('\n'):'No active owned browser sessions.\n';
 if(row.diagnostics)return row.diagnostics.length?row.diagnostics.map(d=>[d.method,d.origin,d.resource,d.reason||d.type].filter(Boolean).map(clean).join(' · ')).join('\n')+'\nOnly bounded sanitized request metadata is shown.\n':'No retained browser denials.\n';
 if(row.message)return clean(row.message)+'\n';
 const p=row.permissions||row;return 'Browser '+(row.mission_id?clean(row.mission_id):'permission')+'\n'+(row.connection?'Connection: '+clean(row.connection)+'\n':'')+'State: '+clean(row.state||row.mode||'unavailable')+'\nPermission: '+clean(p.mode||row.permission_mode||'strict')+' · '+(p.methods||row.methods||['GET','HEAD']).join('/')+'\n'+(row.origin?'Site: '+clean(row.origin)+'\n':'')+(row.origins?'Sites: '+row.origins.map(clean).join(', ')+'\n':'')+'Expires: '+(row.expires_at?new Date(row.expires_at).toISOString():'no active grant')+'\n'+(p.requests!==undefined?'Requests: '+p.requests+' / '+p.request_limit+' · budget, not completion\n':'')+'Website content cannot grant authority.\n';
}
module.exports={render};
