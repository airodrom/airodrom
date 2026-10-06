'use strict';
const {validateJson}=require('./authority-hash');
// JSON.parse validates grammar; this bounded token walk additionally rejects
// duplicate object members, including differently escaped spellings of a key.
function parseAuthorityJSON(text) {
  const value=JSON.parse(text);validateJson(value);
  const tokens=text.match(/"(?:[^"\\]|\\.)*"|[{}\[\],:]|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/g)||[];
  let i=0;
  function visit(){
    const token=tokens[i++];
    if(token==='{'){
      const keys=new Set();if(tokens[i]==='}'){i++;return;}
      do{const key=JSON.parse(tokens[i++]);if(keys.has(key))throw new Error('Duplicate JSON member');keys.add(key);i++;visit();}while(tokens[i++]===',');
    }else if(token==='['){if(tokens[i]===']'){i++;return;}do{visit();}while(tokens[i++]===',');}
  }
  visit();return value;
}
module.exports={parseAuthorityJSON};
