'use strict';
// Observed without credentials on 2026-10-07. This catalog grants nothing.
const {error}=require('./research-network');
const MONARCH='monarch-public-login-v1';
const ASSETS=/^\/static\/(?:js|css|media)\/[A-Za-z0-9_.\/-]+\.(?:js|css|png|jpe?g|svg|gif|woff2?|ttf)$/;
const FILES=new Set(['/favicon.ico','/logo512.png','/loading-screen.css','/osano.css','/react-toggle.css','/monarch-loading-indicator.gif']);
function profile(name,origin){if(name===undefined)return null;if(name!==MONARCH||origin!=='https://app.monarch.com')throw error('unverified_login_network_profile');return {name:MONARCH,origins:['https://app.monarch.com','https://static.monarch.com','https://monarch.com','https://www.monarch.com']};}
function allowed(value,{authorization,phase,method,kind,navigation},primary){
 const u=new URL(value),p=profile(authorization.network_profile,authorization.origin);
 if(u.origin===authorization.origin)return primary(value,{origin:authorization.origin,phase,method,kind,navigation});
 if(!p||u.username||u.password||u.search||u.hash||/%|[\x00-\x20\x7f\\]/.test(value)||!['GET','HEAD'].includes(method))throw error('session_origin_or_query_denied');
 if(u.origin==='https://static.monarch.com'&&!navigation&&(ASSETS.test(u.pathname)||FILES.has(u.pathname))&&['script','stylesheet','image','font'].includes(kind))return u.href;
 if(phase==='login'&&['https://monarch.com','https://www.monarch.com'].includes(u.origin)&&u.pathname==='/'&&navigation)return u.href;
 throw error('session_verified_endpoint_denied');
}
module.exports={profile,allowed,MONARCH};
