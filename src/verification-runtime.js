'use strict';
// Operator-owned exact executable pins for registered verification tasks only.
const fs=require('node:fs'),path=require('node:path'),{createHash}=require('node:crypto');
const CONFIG=path.resolve(__dirname,'../config/verification-runtime-v1.json');
function digest(file){const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{const h=createHash('sha256'),b=Buffer.alloc(65536);let n;while((n=fs.readSync(fd,b,0,b.length,null)))h.update(b.subarray(0,n));return h.digest('hex');}finally{fs.closeSync(fd);}}
function dependencies(repo,label,{file=CONFIG}={}){
 if(!fs.existsSync(file))return{execDependencies:[],env:{}};
 const s=fs.lstatSync(file);if(!s.isFile()||s.isSymbolicLink()||s.size>16000)throw Error('Unsafe verifier runtime policy');
 const c=JSON.parse(fs.readFileSync(file,'utf8'));if(c.version!==1||!Array.isArray(c.tasks)||c.tasks.length>40)throw Error('Invalid verifier runtime policy');
 const entry=c.tasks.find(t=>t.repo===fs.realpathSync(repo)&&t.labels.includes(label));if(!entry)return{execDependencies:[],env:{}};
 if(entry.kind!=='esbuild'||entry.labels.length>8||!path.isAbsolute(entry.executable)||!entry.executable.startsWith(path.resolve(__dirname,'../.runtime/verifier-dependencies')+path.sep)||!/^[a-f0-9]{64}$/.test(entry.sha256))throw Error('Invalid verifier executable pin');
 const pin=entry.executable,st=fs.lstatSync(pin);if(!st.isFile()||st.isSymbolicLink()||st.mode&0o222||st.size>32*1024*1024||fs.realpathSync(pin)!==pin||digest(pin)!==entry.sha256)throw Error('Verifier executable pin mismatch');
 return{execDependencies:[{path:pin,sha256:entry.sha256}],env:{ESBUILD_BINARY_PATH:pin}};
}
module.exports={dependencies,digest};
