'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..');
const expected=JSON.parse(fs.readFileSync(path.join(root,'release-files.json'),'utf8'));
const excluded=new Set(['node_modules','.git','.runtime','data','work','outputs']);
const files=[];const errors=[];
function visit(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){const file=path.join(dir,e.name),rel=path.relative(root,file).split(path.sep).join('/');if(e.isSymbolicLink()){errors.push({file:rel,rule:'symlink'});continue;}if(e.isDirectory()){if(!excluded.has(e.name)&&!e.name.startsWith('.tmp'))visit(file);}else if(e.isFile()&&!rel.endsWith('.log')&&rel!=='config/safe-autonomy-manifest.json')files.push(rel);}}
visit(root);
for(const f of files)if(!expected.includes(f))errors.push({file:f,rule:'not_allowlisted'});
for(const f of expected)if(!files.includes(f))errors.push({file:f,rule:'missing'});
let syntax=0,links=0,json=0;
for(const name of files){const file=path.join(root,name),text=fs.readFileSync(file,'utf8');if(/\.(?:js|cjs|mjs)$/.test(name)){const r=spawnSync(process.execPath,['--check',file],{stdio:'ignore'});syntax++;if(r.status!==0)errors.push({file:name,rule:'syntax'});}if(name.endsWith('.json')){try{JSON.parse(text);json++;}catch{errors.push({file:name,rule:'json'});}}
 // Synthetic personal paths and .invalid contacts exist only in adversarial tests.
 if(!name.startsWith('tests/')&&(/\/Users\/[^\s'"/]+/.test(text)||/chatgpt\.com\/c\/|chatgpt-conversation:\/\//.test(text)))errors.push({file:name,rule:'private_reference'});
 for(const m of text.matchAll(/\/Users\/([^/\s'"]+)/g))if(!name.startsWith('tests/')||!['fixture','operator','owner','example','someone','private'].includes(m[1]))errors.push({file:name,rule:'operator_identity'});
 if(name.endsWith('.md'))for(const match of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)){let target=match[1];if(/^(?:https?:|mailto:|#)/.test(target))continue;target=target.split('#')[0];links++;if(!fs.existsSync(path.resolve(path.dirname(file),target)))errors.push({file:name,rule:'broken_local_link'});}
}
const pkg=JSON.parse(fs.readFileSync(path.join(root,'package.json'))),lock=JSON.parse(fs.readFileSync(path.join(root,'package-lock.json')));
if(pkg.private!==true||pkg.license!=='MIT'||pkg.version!==lock.version||pkg.version!==lock.packages[''].version)errors.push({rule:'package_policy'});
for(const group of ['dependencies','devDependencies'])for(const [name,v] of Object.entries(pkg[group]||{}))if(!/^\d+\.\d+\.\d+(?:-[\w.]+)?$/.test(v)||lock.packages[''][group]?.[name]!==v)errors.push({rule:'unpinned_dependency',package:name});
for(const [name,v] of Object.entries(lock.packages))if(name&&(!v.integrity||!/^https:\/\/registry\.npmjs\.org\//.test(v.resolved||'')))errors.push({rule:'lock_integrity',package:name});
const m=JSON.parse(fs.readFileSync(path.join(root,'config/architecture-memory-sources-v1.json')));
for(const s of m.sources){const data=fs.readFileSync(path.join(root,s.path));if(crypto.createHash('sha256').update(data).digest('hex')!==s.source_hash)errors.push({file:s.path,rule:'canonical_hash'});const t=data.toString();for(const f of m.facts.filter(f=>f.source_ref===s.path))if(!t.includes(f.content))errors.push({file:s.path,rule:'canonical_excerpt'});}
console.log(JSON.stringify({files:files.length,syntax,json,links,errors}));if(errors.length)process.exitCode=1;
