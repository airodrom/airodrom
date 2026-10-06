'use strict';
// Narrow, provider-bound reference resolver; no enumeration, environment fallback,
// storage writes, credential discovery or worker-facing API.
class ProviderSecrets {
  #read; #references;
  constructor({references={},read=null}={}) {this.#references={...references};this.#read=read;}
  configured(id) {const ref=this.#references[id];return typeof ref==='string'&&/^[a-zA-Z0-9_.:/-]{1,200}$/.test(ref)&&require('../secret-observation').redactText(ref)===ref&&typeof this.#read==='function';}
  forProvider(id) {
    return Object.freeze({available:()=>this.configured(id),resolve:async()=>{
      if(!this.configured(id))throw Object.assign(Error('Provider authentication required'),{code:'auth_required'});
      try {const value=await this.#read({providerId:id,reference:this.#references[id]});if(typeof value!=='string'||!value||value.length>4096||/[\r\n]/.test(value))throw Error();return value;}
      catch {throw Object.assign(Error('Provider credential unavailable'),{code:'credential_unavailable'});}
    }});
  }
}
module.exports={ProviderSecrets};
