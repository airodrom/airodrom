'use strict';
const fs=require('node:fs'),path=require('node:path');
function researchProfile(){
 const c=JSON.parse(fs.readFileSync(path.join(__dirname,'../config/research-profile-v1.json'),'utf8'));
 if(c.version!==1||c.project!=='Arecibo'||c.workspace_sibling!=='arecibo-core')throw Error('Unreviewed research baseline profile');
 const workspace=path.resolve(__dirname,'../../',c.workspace_sibling);
 // A missing canonical repository is a configuration blocker, never an excuse
 // to compare against memories or an arbitrary directory from website text.
 return {workspace,maxPages:c.maxPages,maxActions:c.maxActions,timeoutMs:c.timeoutMs};
}
module.exports={researchProfile};
