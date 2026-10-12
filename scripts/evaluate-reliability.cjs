#!/usr/bin/env node
'use strict';
// Explicit one-shot synthetic evaluation. Never imports owner configuration or dispatches live work.
const fs = require('node:fs'), path = require('node:path'), { spawn, execFileSync } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const { AirodromEvaluationEngine } = require('../src/evaluation-engine');
const scenarios = require('../config/reliability-scenarios-v1.json');
function executeScenario(root, s) {
 return new Promise(resolve => {
  const start = performance.now(); let output = '', bytes = 0, stopped = null, killTimer;
  const child = spawn(process.execPath, [path.join(root,'scripts/run.cjs'), '--test', '--test-reporter=tap', '--test-name-pattern='+s.test_name_pattern, path.join(root,s.test_file)], {
   cwd: root, detached: true, stdio: ['ignore','pipe','pipe'],
   env: { PATH: process.env.PATH, HOME: require('node:os').tmpdir(), TMPDIR: require('node:os').tmpdir(), NODE_ENV:'test', LANG:'en_US.UTF-8' }
  });
  const stop = reason => { if(stopped)return; stopped=reason; try{process.kill(-child.pid,'SIGTERM');}catch{} killTimer=setTimeout(()=>{try{process.kill(-child.pid,'SIGKILL');}catch{}},500); };
  const timer = setTimeout(()=>stop('timeout'),s.max_duration_ms);
  const collect = chunk => { bytes+=chunk.length; if(bytes>s.resource_budget.max_output_bytes)stop('output_budget');else output+=chunk.toString(); };
  child.stdout.on('data',collect); child.stderr.on('data',collect);
  child.on('error',()=>{stopped='fixture_unavailable';});
  child.on('close',code=>{
   clearTimeout(timer); if(killTimer)clearTimeout(killTimer);
   const number = key => Number(output.match(new RegExp('^# '+key+' (\\d+)\\s*$','m'))?.[1]||0);
   const tests={pass:number('pass'),fail:number('fail'),skipped:number('skipped'),cancelled:number('cancelled')};
   const observations=[];
   for(const match of output.matchAll(/^# EVAL_OBSERVATION (\{.*\})$/gm)) { try { const x=JSON.parse(match[1]); if(Object.values(x).every(v=>Number.isSafeInteger(v)&&v>=0))observations.push(x); } catch{} }
   resolve({ status:!stopped&&code===0&&tests.pass>0&&!tests.fail&&!tests.cancelled?'passed':'failed',tests,duration_ms:Math.round((performance.now()-start)*100)/100,
    error_class:stopped|| (code!==0?'fixture_failed':!tests.pass?'missing_evidence':null),output_bytes:bytes,observations });
  });
 });
}
async function main() {
 const args=process.argv.slice(2); if(args.some(a=>!a.startsWith('--root=')&&!a.startsWith('--output=')&&a!=='--extended'))throw Error('Use --root=checkout, --output=report.json and optional --extended');
 const root=fs.realpathSync(args.find(a=>a.startsWith('--root='))?.slice(7)||path.resolve(__dirname,'..'));
 const source_sha=execFileSync('/usr/bin/git',['-C',root,'rev-parse','HEAD'],{encoding:'utf8'}).trim();
 const report=await new AirodromEvaluationEngine({scenarios:args.includes('--extended')?[...scenarios,{...scenarios[0],id:'integrated-v1-boundaries',category:'H',objective:'V1 goals, memory metrics, discovery, tracing and injection boundaries',test_file:'tests/autonomous-reliability.test.js',test_name_pattern:'.',verification_criteria:['Independent host boundary assertions'],evidence_class:'DISPOSABLE_FIXTURE'}]:scenarios}).run(s=>executeScenario(root,s),{source_sha,working_tree_dirty:execFileSync('/usr/bin/git',['-C',root,'status','--porcelain'],{encoding:'utf8'}).trim().length>0,scenario_seed:1,model_identity:'none; fixtures only',runtime_version:process.version,policy_version:require(path.join(root,'config/capability-policy-v2.json')).version || 'v2',test_environment:process.platform+'-'+process.arch, evidence_class:'DISPOSABLE_FIXTURE_AND_MOCKED_CONTRACT'});
 const out=args.find(a=>a.startsWith('--output='))?.slice(9);
 if(out)fs.writeFileSync(out,JSON.stringify(report,null,2)+'\n',{mode:0o600});
 console.log(JSON.stringify({provenance:report.provenance,metrics:report.metrics,results:report.results.map(r=>({id:r.id,status:r.status,tests:r.tests,error_class:r.error_class}))},null,2));
 if(report.metrics.failed)process.exitCode=1;
}
if(require.main===module)main().catch(()=>{console.error('Synthetic evaluation failed; no owner data was used.');process.exitCode=1;});
module.exports={executeScenario};
