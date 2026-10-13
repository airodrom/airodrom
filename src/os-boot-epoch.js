'use strict';
// Durable OS boot identity for termination recovery. A changed boot epoch after
// an owner-authorized cold reboot is evidence that prior-boot processes are gone.
// Process listings and missing PIDs are never boot evidence.
const {execFileSync}=require('node:child_process');
const error=code=>{const e=Error('OS boot epoch unavailable: '+code);e.code=code;return e;};

function readBootEpoch({platform=process.platform,execFileSync:exec=execFileSync,testing}={}){
  if(testing&&process.env.NODE_ENV!=='test')throw error('test_boot_epoch_denied');
  if(testing?.epoch)return Object.freeze({...testing.epoch,source:testing.epoch.source||'fixture'});
  if(platform==='darwin'){
    const out=String(exec('sysctl',['kern.boottime'],{encoding:'utf8',timeout:2000,maxBuffer:4096}));
    const match=/sec\s*=\s*(\d+)\s*,\s*usec\s*=\s*(\d+)/.exec(out);if(!match)throw error('kern_boottime_unparsed');
    const sec=Number(match[1]),usec=Number(match[2]);
    if(!Number.isSafeInteger(sec)||sec<=0||!Number.isSafeInteger(usec)||usec<0||usec>999999)throw error('kern_boottime_invalid');
    return Object.freeze({sec,usec,source:'kern.boottime'});
  }
  if(platform==='linux'){
    const text=require('node:fs').readFileSync('/proc/stat','utf8');
    const match=/^btime\s+(\d+)$/m.exec(text);if(!match)throw error('proc_btime_unavailable');
    const sec=Number(match[1]);if(!Number.isSafeInteger(sec)||sec<=0)throw error('proc_btime_invalid');
    return Object.freeze({sec,usec:0,source:'proc_btime'});
  }
  throw error('platform_boot_epoch_unsupported');
}

function bootEpochMs(epoch){
  if(!epoch||!Number.isSafeInteger(epoch.sec)||epoch.sec<=0||!Number.isSafeInteger(epoch.usec)||epoch.usec<0||epoch.usec>999999)throw error('boot_epoch_invalid');
  return epoch.sec*1000+Math.floor(epoch.usec/1000);
}

function sameBootEpoch(a,b){return !!a&&!!b&&a.sec===b.sec&&a.usec===b.usec&&a.source===b.source;}

function fingerprint(epoch){
  return `${epoch.source}:${epoch.sec}.${String(epoch.usec).padStart(6,'0')}`;
}

module.exports={readBootEpoch,bootEpochMs,sameBootEpoch,fingerprint,error};
