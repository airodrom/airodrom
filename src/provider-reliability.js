'use strict';
const STATES = new Set(['available','unavailable','auth_required','quota_limited','degraded','circuit_open','unknown']);
function normalizeError(error) {
  const status = Number(error?.status);
  let error_class = 'unknown_error', state = 'unknown', retryable = false;
  if ([401,403].includes(status)) { error_class='auth_required';state='auth_required'; }
  else if ([402,429].includes(status)) {error_class='quota_limited';state='quota_limited';}
  else if ([400,404,422].includes(status)) {error_class='invalid_request';state='degraded';}
  else if (status>=500 && status<=599 || ['network_error','timeout'].includes(error?.code)) {error_class='temporary_failure';state='unavailable';retryable=true;}
  else if (['credential_unavailable','auth_required','runtime_unavailable','invalid_request','invalid_response','policy_reject','cancelled','unknown_side_effects'].includes(error?.code)) {
    error_class=error.code;state=['auth_required','credential_unavailable'].includes(error.code)?'auth_required':error.code==='runtime_unavailable'?'unavailable':'degraded';
  }
  // No raw error message, response body, URL, headers or stack cross this boundary.
  return {error_class,state,retryable,execution_authority:false};
}
class ProviderReliability {
  constructor({db=null,now=Date.now,threshold=2,cooldownMs=30000,maxRetries=1}={}) {
    this.db=db;this.now=now;this.threshold=threshold;this.cooldownMs=cooldownMs;this.maxRetries=Math.min(1,Math.max(0,maxRetries));this.records=new Map();this.probes=new Set();
    db?.exec(`CREATE TABLE IF NOT EXISTS cp_provider_circuits(provider_model TEXT PRIMARY KEY,record TEXT NOT NULL);`);
  }
  get(key) { const r=this.db?.prepare('SELECT record FROM cp_provider_circuits WHERE provider_model=?').get(key);return r?JSON.parse(r.record):this.records.get(key)||{circuit:'CLOSED',failures:0,state:'unknown',last_error_class:null,last_success_at:null,retry_at:0}; }
  save(key,r) {this.records.set(key,r);this.db?.prepare('INSERT INTO cp_provider_circuits VALUES(?,?) ON CONFLICT(provider_model) DO UPDATE SET record=excluded.record').run(key,JSON.stringify(r));return r;}
  view(key) {const r=this.get(key);return {...r,circuit:r.circuit==='OPEN'&&r.retry_at<=this.now()?'HALF_OPEN':r.circuit};}
  enter(key) {const claim=()=>{const r=this.view(key);if(r.circuit==='OPEN'||r.probe_active||this.probes.has(key)||['auth_required','quota_limited'].includes(r.state)&&r.retry_at>this.now())return false;if(r.circuit==='HALF_OPEN'){this.probes.add(key);this.save(key,{...r,probe_active:true});}return true;};return this.db?require('./control-transaction').transaction(this.db,claim):claim();}
  success(key) {this.probes.delete(key);return this.save(key,{circuit:'CLOSED',failures:0,state:'available',last_error_class:null,last_success_at:this.now(),retry_at:0});}
  failure(key,e) {this.probes.delete(key);const old=this.get(key),failures=old.failures+1;return this.save(key,{...old,probe_active:false,failures,state:e.state,last_error_class:e.error_class,circuit:e.state==='quota_limited'||e.retryable&&(failures>=this.threshold||['OPEN','HALF_OPEN'].includes(old.circuit))?'OPEN':old.circuit,retry_at:this.now()+this.cooldownMs});}
  reset(key){this.probes.delete(key);return this.save(key,{circuit:'CLOSED',failures:0,state:'unknown',last_error_class:null,last_success_at:null,retry_at:0});}
}
module.exports={normalizeError,ProviderReliability,STATES};
