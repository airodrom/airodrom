"use strict";
const fs=require('node:fs'),path=require('node:path');
function canonical(target){let current=path.resolve(target),suffix=[];while(!fs.existsSync(current)){const parent=path.dirname(current);if(parent===current)throw Error('Invalid manifest path');suffix.unshift(path.basename(current));current=parent;}return path.join(fs.realpathSync(current),...suffix);}
function inside(root,target){const relative=path.relative(root,target);return relative===''||(!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative));}
module.exports={canonical,inside};
