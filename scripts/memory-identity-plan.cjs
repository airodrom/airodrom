'use strict';
// Read-only, counts-only planning. Applying migration remains an explicit host
// maintenance operation against an isolated copy with independent dispositions.
const {DatabaseSync}=require('node:sqlite');
let db;
try {
  const args=process.argv.slice(2);
  if(args.length!==2||args[0]!=='--database'||!args[1])throw Error('plan unavailable');
  db=new DatabaseSync(args[1],{readOnly:true});
  const result=require('../src/memory-identity').qualification(db);
  process.stdout.write(JSON.stringify({version:1,mode:'read_only_plan',...result})+'\n');
  process.exitCode=result.state==='failed'?1:0;
} catch {
  process.stdout.write(JSON.stringify({version:1,mode:'read_only_plan',state:'failed',safe_error_class:'identity_plan_unavailable',authority:false})+'\n');
  process.exitCode=1;
} finally {if(db)db.close();}
