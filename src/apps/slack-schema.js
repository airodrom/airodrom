'use strict';
const {transaction}=require('../control-transaction');
function migrateSlackSchema(db){const version=db.prepare('SELECT version FROM control_plane_meta').get().version;if(version===3)return;if(version!==2)throw Error('Unsupported Slack schema');transaction(db,()=>{db.exec(`CREATE TABLE cp_slack_config(id INTEGER PRIMARY KEY CHECK(id=1),config TEXT NOT NULL,updated_at INTEGER NOT NULL); CREATE TABLE cp_slack_pending_events(id TEXT PRIMARY KEY,mission_id TEXT NOT NULL,type TEXT NOT NULL,metadata TEXT NOT NULL,created_at INTEGER NOT NULL); UPDATE control_plane_meta SET version=3;`);if(Object.values(db.prepare('PRAGMA integrity_check').get())[0]!=='ok')throw Error('Slack migration integrity failure');});}
module.exports={migrateSlackSchema};
