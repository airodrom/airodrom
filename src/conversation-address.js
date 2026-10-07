'use strict';
// Names are ordinary canonical Memory, never a second profile or authority source.
function name(value){
 if(typeof value!=='string'||/[\r\n\0]/.test(value))return null;
 const result=value.trim();
 if(!/^[\p{L}][\p{L} .'-]{0,59}$/u.test(result)||require('./assistant-intent').secret(result)||require('./assistant-intent').sensitive(result))return null;
 return result;
}
function contentName(content){
 if(typeof content!=='string')return null;
 const match=/^(?:my name is|i am called)\s+(.+?)\.?$/i.exec(content);
 return match?name(match[1]):null;
}
function saved(items){
 const rows=(items||[]).filter(row=>row.subject==='name'&&row.sensitivity==='normal'&&row.authority!==true&&row.status==='active'&&contentName(row.content));
 return rows.length===1?rows[0]:null;
}
function answer(value,{bare=false}={}){
 if(typeof value!=='string'||/[\r\n\0]/.test(value)||require('./assistant-intent').secret(value))return null;
 const match=/^(?:\/name|call me|my name is|(?:remember(?: that)?|\/remember) my name is)\s+(.+?)\.?$/i.exec(value);
 if(match)return name(match[1]);
 // A single name can answer the opening question; ordinary greetings stay chat.
 if(bare&&/^[\p{L}][\p{L}'-]{0,59}$/u.test(value)&&!/^(?:hi|hey|hello|yes|no|skip|thanks|help)$/i.test(value))return name(value);
 return null;
}
module.exports={name,contentName,saved,answer};
