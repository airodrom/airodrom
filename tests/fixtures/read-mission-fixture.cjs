'use strict';
// Scheduler, dependency and admission tests use authorized read-only host work.
// Implementation and correction are exercised through cursor-autonomy-fixture.
const fs=require('node:fs'),path=require('node:path'),{execFileSync}=require('node:child_process');
const {fixture:base}=require('./mission-fixture.cjs');
const {manifest}=require('./opencode-fixture.cjs');
async function fixture(t,options={}){
 const f=await base(t,options);
 for(const file of ['second.txt','third.txt'])fs.writeFileSync(path.join(f.repo,file),'alpha\n');
 fs.writeFileSync(path.join(f.repo,'tests/fixture.test.cjs'),"const assert=require('node:assert/strict');assert.equal(require('node:fs').readFileSync('fixture.txt','utf8'),'alpha\\n');\n");
 execFileSync('/usr/bin/git',['-C',f.repo,'add','.'],{stdio:'pipe'});
 execFileSync('/usr/bin/git',['-C',f.repo,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','-c','core.hooksPath=/dev/null','-c','commit.gpgSign=false','commit','-qm','Read-only scheduler fixture'],{stdio:'pipe'});
 return f;
}
function createReadMission(f,extra={}){
 const files=extra.allowed_files||['fixture.txt'],mf=manifest(f.repo);mf.mission.scope.include=files;
 return f.create({task_type:'local_files',preferred_agent:'host',manifest:mf,allowed_files:files,
  criteria:files.map((file,i)=>({id:i?'expected_file_'+i:'expected_file',type:'exact_file',path:file,content:'alpha\n'})),
  dispatch_policy:{privacy:'local_only',providers:['local'],billing_classes:['local'],task_category:'deterministic_files',native_actions:files.map(path=>({name:'file_read',path}))},...extra});
}
module.exports={fixture,createReadMission};
