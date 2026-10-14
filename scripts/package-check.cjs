'use strict';
const fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..'),allowed=new Set(JSON.parse(fs.readFileSync(path.join(root,'release-files.json'))));
const r=spawnSync('npm',['pack','--dry-run','--json','--ignore-scripts'],{cwd:root,encoding:'utf8',maxBuffer:8*1024*1024});
if(r.status!==0){console.error('Package inspection failed; raw diagnostics withheld');process.exit(1);}
const pack=JSON.parse(r.stdout)[0],files=pack.files.map(f=>f.path),packed=new Set(files);
const forbidden=files.filter(f=>!allowed.has(f)||/^(?:\.runtime|data|work|outputs|node_modules)\/|(?:\.sqlite|\.db|\.log|\.bak|\.patch|\.env)(?:$|\.)|^config\/safe-autonomy-manifest\.json$/.test(f));
for(const f of ['LICENSE','README.md','SECURITY.md','THIRD_PARTY_NOTICES.md','package.json','src/sdk/index.js','scripts/airodrom.cjs','src/bridge-invocation-recovery.js','src/cursor-worker.js','src/os-boot-epoch.js'])if(!files.includes(f))forbidden.push('missing:'+f);
// Durable runtime dependency gate: every relative require() reachable from
// managed-service entrypoints must be present in the npm pack allowlist.
function resolve(from,req){
  if(!req.startsWith('.'))return null;
  const base=path.resolve(path.dirname(from),req);
  for(const c of [base,base+'.js',base+'.cjs',path.join(base,'index.js')])if(fs.existsSync(c)&&fs.statSync(c).isFile())return c;
  return null;
}
const roots=['scripts/local-service.cjs','src/bridge-controller.js','src/control-server.js','src/interactive-cli.js','src/bridge-invocation-recovery.js'].map(f=>path.join(root,f));
const seen=new Set(),missingRequires=[];
function walk(file){
  if(seen.has(file)||!file.startsWith(root+path.sep))return;
  seen.add(file);
  let src;try{src=fs.readFileSync(file,'utf8');}catch{missingRequires.push(path.relative(root,file));return;}
  const re=/require\(\s*['"](\.[^'"]+)['"]\s*\)/g;let m;
  while((m=re.exec(src))){
    const target=resolve(file,m[1]);
    if(!target){missingRequires.push(path.relative(root,file)+' -> '+m[1]);continue;}
    walk(target);
  }
}
for(const entry of roots)walk(entry);
const runtime= [...seen].map(f=>path.relative(root,f)).filter(f=>f.startsWith('src'+path.sep)||f.startsWith('scripts'+path.sep)).map(f=>f.split(path.sep).join('/'));
for(const f of runtime)if(!packed.has(f)&&!forbidden.includes('missing-runtime:'+f))forbidden.push('missing-runtime:'+f);
for(const f of missingRequires)forbidden.push('unresolved-require:'+f);
console.log(JSON.stringify({files:files.length,unpackedSize:pack.unpackedSize,runtimeGraph:runtime.length,forbidden}));if(forbidden.length)process.exitCode=1;
