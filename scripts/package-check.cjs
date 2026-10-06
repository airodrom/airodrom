'use strict';
const fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..'),allowed=new Set(JSON.parse(fs.readFileSync(path.join(root,'release-files.json'))));
const r=spawnSync('npm',['pack','--dry-run','--json','--ignore-scripts'],{cwd:root,encoding:'utf8',maxBuffer:8*1024*1024});
if(r.status!==0){console.error('Package inspection failed; raw diagnostics withheld');process.exit(1);}
const pack=JSON.parse(r.stdout)[0],files=pack.files.map(f=>f.path);
const forbidden=files.filter(f=>!allowed.has(f)||/^(?:\.runtime|data|work|outputs|node_modules)\/|(?:\.sqlite|\.db|\.log|\.bak|\.patch|\.env)(?:$|\.)|^config\/safe-autonomy-manifest\.json$/.test(f));
for(const f of ['LICENSE','README.md','SECURITY.md','THIRD_PARTY_NOTICES.md','package.json','src/sdk/index.js','scripts/airodrom.cjs'])if(!files.includes(f))forbidden.push('missing:'+f);
console.log(JSON.stringify({files:files.length,unpackedSize:pack.unpackedSize,forbidden}));if(forbidden.length)process.exitCode=1;
