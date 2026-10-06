'use strict';
const {transaction}=require('./control-transaction');
function migrateMissionSchema(db) {
  const version=db.prepare('SELECT version FROM control_plane_meta').get()?.version;
  if(version===2||version===3)return;if(version!==1)throw Error('Unsupported control plane schema version');
  transaction(db,()=>{
    db.exec(`
      CREATE TABLE cp_mission_tasks(task_id TEXT PRIMARY KEY,mission_id TEXT NOT NULL,ordinal INTEGER NOT NULL,context_pack_id TEXT,dispatch_id TEXT,created_at INTEGER NOT NULL);
      CREATE INDEX cp_mission_tasks_mission ON cp_mission_tasks(mission_id,ordinal);
      CREATE TABLE cp_dispatches(id TEXT PRIMARY KEY,mission_id TEXT NOT NULL,task_id TEXT NOT NULL,state TEXT NOT NULL,decision_id TEXT UNIQUE,route TEXT,run_id TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
      CREATE TABLE cp_run_results(run_id TEXT PRIMARY KEY,mission_id TEXT NOT NULL,normalized TEXT NOT NULL,processed_at INTEGER NOT NULL);
      CREATE TABLE cp_gateway_cursors(name TEXT PRIMARY KEY,sequence INTEGER NOT NULL);
      ALTER TABLE cp_runs ADD COLUMN provider_id TEXT;
      ALTER TABLE cp_runs ADD COLUMN last_heartbeat_at INTEGER;
      UPDATE control_plane_meta SET version=2;
    `);
    if(Object.values(db.prepare('PRAGMA integrity_check').get())[0]!=='ok')throw Error('Mission migration integrity check failed');
  });
}
module.exports={migrateMissionSchema};
