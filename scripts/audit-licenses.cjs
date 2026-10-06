'use strict';
const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..'),lock=JSON.parse(fs.readFileSync(path.join(root,'package-lock.json'))),allowed=new Set(['MIT','Apache-2.0','BSD-3-Clause','BSD-2-Clause','ISC','0BSD','Python-2.0']);
const rows=Object.entries(lock.packages).filter(([n])=>n).map(([n,p])=>({name:n.slice('node_modules/'.length),version:p.version,license:p.license,optional:p.optional===true,installScript:p.hasInstallScript===true,integrity:!!p.integrity}));
const blocked=rows.filter(p=>!allowed.has(p.license)||!p.integrity||p.installScript);
console.log(JSON.stringify({lockedPackages:rows.length,licenses:[...new Set(rows.map(p=>p.license))].sort(),installScripts:rows.filter(p=>p.installScript).length,blocked}));if(blocked.length)process.exitCode=1;
