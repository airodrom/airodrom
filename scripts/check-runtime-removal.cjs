'use strict';
const fs=require('node:fs'),path=require('node:path'),{createHash}=require('node:crypto');
const root=path.resolve(__dirname,'..');
const token=/\bp[i]\b|\bP[i]\b|\bP[I]_[A-Z]|P[i]SDK|P[i]Bridge[A-Z]|\bp[i]_[a-z]/;
const forbidden=/earendil-w[o]rks|P[i]Adapter|P[i]RpcSupervisor|_ensureP[i]Runtime|p[i]LaunchArgs|p[i]-adapter|r[p]c-supervisor|worker-sandb[o]x|p[i](?:Owned|Worker|Tasks|Completion|Bridge|Executable)|P[I]_BRIDGE_|P[I]_CODING_AGENT_DIR|BRIDGE_P[I]_OPENAI|\/bin\/p[i](?:['"\s]|$)/;
function scan(base=root){
 const manifest=JSON.parse(fs.readFileSync(path.join(base,'config/legacy-identifiers-v1.json'),'utf8'));
 const allowed=new Map(manifest.lines.map(x=>[x.file+':'+x.sha256,x]));const used=new Map(),errors=[],files=[];
 const walk=dir=>{for(const e of fs.readdirSync(path.join(base,dir),{withFileTypes:true})){const file=path.posix.join(dir,e.name);if(e.isSymbolicLink()){errors.push({file,rule:'symlink'});continue;}if(e.isDirectory())walk(file);else files.push(file);}};
 for(const dir of ['src','scripts','config','public','macos','.github'])walk(dir);
 files.push('package.json','package-lock.json');
 for(const file of files){if(file==='config/legacy-identifiers-v1.json')continue;const s=fs.readFileSync(path.join(base,file),'utf8');for(const [i,line]of s.split('\n').entries()){
  if(forbidden.test(line)){errors.push({file,line:i+1,rule:'removed_runtime_dependency'});continue;}
  if(!token.test(line))continue;const key=file+':'+createHash('sha256').update(line).digest('hex');const entry=allowed.get(key);used.set(key,(used.get(key)||0)+1);
  if(!entry||used.get(key)>entry.count)errors.push({file,line:i+1,rule:'undocumented_legacy_identifier'});
 }}
 for(const file of files.filter(f=>/\.(?:js|cjs|mjs)$/.test(f))){const source=fs.readFileSync(path.join(base,file),'utf8');for(const match of source.matchAll(/require\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g)){const target=path.resolve(base,path.dirname(file),match[1]);if(![target,target+'.js',target+'.cjs',target+'.mjs',target+'.json',path.join(target,'index.js')].some(f=>fs.existsSync(f)))errors.push({file,rule:'unresolved_local_import'});}}
 for(const [key,e]of allowed)if((used.get(key)||0)!==e.count)errors.push({file:e.file,rule:'stale_legacy_allowance'});
 return {files:files.length,legacy_lines:manifest.lines.reduce((n,x)=>n+x.count,0),errors};
}
if(require.main===module){const result=scan();console.log(JSON.stringify(result));if(result.errors.length)process.exitCode=1;}
module.exports={scan};
