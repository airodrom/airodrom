'use strict';
// Task-scoped sandbox for work that does not name an authorized repository.
// The directory is new, private, and not a view of any enrolled project.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function allocate() {
  const parent = path.join(os.tmpdir(), 'airodrom-task-sandboxes');
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const workspace = fs.realpathSync(fs.mkdtempSync(path.join(parent, 'task-')));
  fs.chmodSync(workspace, 0o700);
  fs.writeFileSync(path.join(workspace, 'TASK.md'), 'Task-scoped sandbox. No registered Project. No personal files.\n', { mode: 0o600 });
  const git = spawnSync('git', ['init', '-q'], { cwd: workspace, encoding: 'utf8' });
  if (git.status !== 0) throw Error('task_sandbox_unavailable');
  return { workspace, projectless: true, project: null, filesystem: 'task_sandbox_only' };
}

module.exports = { allocate };
