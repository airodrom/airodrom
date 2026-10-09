'use strict';
// Keep weather available through the static route supported by older backends.
const fs=require('node:fs'),path=require('node:path'),root=path.resolve(__dirname,'..');
const file=path.join(root,'public/control-hub.js'),marker='// BEGIN generated atmosphere compatibility bundle; source: public/atmosphere.js';
const hub=fs.readFileSync(file,'utf8').split(marker)[0].trimEnd();
fs.writeFileSync(file,hub+'\n\n'+marker+'\n'+fs.readFileSync(path.join(root,'public/atmosphere.js'),'utf8')+'\n// END generated atmosphere compatibility bundle\n');
