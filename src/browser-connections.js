'use strict';
// A connection's availability is a host qualification, never a site assertion.
const fs=require('node:fs');
const {spawnSync}=require('node:child_process');
const CHROME='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
function availability(){
 const chrome=process.platform==='darwin'&&fs.existsSync(CHROME);
 return {version:2,modes:[
  {id:1,mode:'existing_chrome',label:'Use my existing Chrome session',available:false,reason:'Chrome 144+ has an explicit browser permission flow, but Airodrom has no qualified scoped adapter for it. Ordinary Chrome is never silently attached.'},
  {id:2,mode:'dedicated_cdp',label:'Connect using loopback CDP',available:chrome,qualification:'checked_on_open',reason:chrome?'Opt in to a separately owned Airodrom debugging profile. Only the freshly launched, verified loopback endpoint can be attached; arbitrary external endpoints are unavailable.':'Qualified macOS Chrome is unavailable.'},
  {id:3,mode:'dedicated_manual',label:'Use a dedicated persistent Airodrom browser',available:chrome,qualification:'checked_on_open',reason:chrome?'Isolated profile for this site, reusable only with owner consent.':'Qualified macOS Chrome is unavailable.'},
  {id:4,mode:'human_guided',label:'Open regular Chrome for human-guided inspection',available:chrome,qualification:'checked_on_open',reason:'You control regular Chrome. Airodrom has no automation access or evidence from it.'},
  {id:5,mode:'authentication',label:'Human-controlled login, MFA or passkey takeover',available:chrome,qualification:'checked_on_open',reason:'Dedicated browser, exact same-site login endpoints. External Google/Microsoft/Apple OAuth, identity popups and dedicated passkeys are unqualified or disabled; use regular Chrome for these human login flows.'},
  {id:6,mode:'extended',label:'Temporary Extended public browsing',available:chrome,qualification:'checked_on_open',reason:'Public sources only, explicit scope and expiry, maximum 15 minutes; no authenticated discovery.'},
  {id:7,mode:'cancel',label:'Cancel',available:true,reason:'No connection or grant.'}
 ],search_available:false,pdf_available:false,authority:false};
}
function humanURL(value){
 const u=new URL(value);require('./research-network').safeOrigin(u.origin);
 require('./research-session').allowedURL(value,{origin:u.origin,phase:'login',navigation:true});return u.href;
}
function openHuman(value){
 const url=humanURL(value);if(!availability().modes.find(m=>m.mode==='human_guided').available)throw Error('Regular Chrome is unavailable.');
 const result=spawnSync('/usr/bin/open',['-a','Google Chrome',url],{stdio:'ignore',timeout:5000});
 if(result.status!==0)throw Error('Chrome could not open.');return {kind:'clarify',mode:'human_guided',message:'Regular Chrome opened for your inspection. Airodrom has no automation access and collected no findings.',authority:false};
}
module.exports={availability,humanURL,openHuman,CHROME};
