'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
try {
  const file = path.join(process.env.PI_BRIDGE_DATA_DIR || path.join(__dirname, '../.runtime'), 'ui.json');
  const { url, pid } = JSON.parse(fs.readFileSync(file, 'utf8'));
  process.kill(pid, 0);
  if (!/^http:\/\/127\.0\.0\.1:\d+\/#token=[a-f0-9]{64}$/.test(url)) throw new Error('Invalid local UI address');
  const child = spawn('open', [url], { stdio: 'ignore' });
  child.on('error', e => { console.error(e.message); process.exitCode = 1; });
} catch { console.error('Start the bridge with npm start first.'); process.exitCode = 1; }
