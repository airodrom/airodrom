'use strict';
// Deterministic source archive: explicit allowlist, normalized metadata, no private state.
const fs=require('node:fs'),path=require('node:path'),zlib=require('node:zlib'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'..'),list=JSON.parse(fs.readFileSync(path.join(root,'release-files.json'))).sort();
function octal(n,size){return n.toString(8).padStart(size-1,'0')+'\0';}
const blocks=[];
for(const name of list){if(path.isAbsolute(name)||name.split('/').includes('..'))throw Error('Unsafe archive path');const file=path.join(root,name),st=fs.lstatSync(file);if(!st.isFile()||st.isSymbolicLink())throw Error('Unsafe archive input');const data=fs.readFileSync(file),h=Buffer.alloc(512);let short=name,prefix='';if(Buffer.byteLength(name)>100){const i=name.lastIndexOf('/');prefix=name.slice(0,i);short=name.slice(i+1);}if(Buffer.byteLength(short)>100||Buffer.byteLength(prefix)>155)throw Error('Archive path too long');h.write(short,0,100);h.write(octal(st.mode&0o111?0o755:0o644,8),100,8);h.write(octal(0,8),108,8);h.write(octal(0,8),116,8);h.write(octal(data.length,12),124,12);h.write(octal(0,12),136,12);h.fill(32,148,156);h.write('0',156);h.write('ustar\0',257,6);h.write('00',263,2);h.write(prefix,345,155);const checksum=h.reduce((a,b)=>a+b,0);h.write(checksum.toString(8).padStart(6,'0')+'\0 ',148,8);blocks.push(h,data,Buffer.alloc((512-data.length%512)%512));}
blocks.push(Buffer.alloc(1024));const archive=zlib.gzipSync(Buffer.concat(blocks),{level:9,mtime:0});
const out=process.argv[2];if(!out)throw Error('An output path outside the release surface is required');fs.writeFileSync(out,archive);console.log(JSON.stringify({files:list.length,bytes:archive.length,sha256:crypto.createHash('sha256').update(archive).digest('hex')}));
