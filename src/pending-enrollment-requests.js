'use strict';
// Surface prepared Developer Autonomy enrollment requests in Control Center.
// Never sets confirmed:true. Owner must enroll via authenticated Control Center action.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

function enrollmentDir(home = process.env.AIRODROM_HOME || path.join(os.homedir(), '.airodrom')) {
  return path.join(home, 'activation', 'development-target-enrollment');
}

/**
 * Load pending (confirmed !== true) enrollment request JSONs.
 * Returns redacted presentation payloads suitable for Control Center.
 */
function listPending(home) {
  const dir = enrollmentDir(home);
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith('.json') && !n.startsWith('.'));
  } catch {
    return [];
  }

  const out = [];
  for (const name of names.sort().reverse()) {
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
    } catch {
      continue;
    }
    if (raw?.confirmed === true) continue;
    const req = raw.request || raw;
    if (!req || typeof req !== 'object') continue;
    if (typeof req.alias !== 'string' && typeof raw.title !== 'string') continue;

    out.push({
      file: name,
      title: raw.title || `Pending enrollment: ${req.alias || 'unnamed'}`,
      prepared_at: raw.prepared_at || null,
      confirmed: false,
      blocker: raw.blocker || 'owner_confirmation_required',
      note: raw.note || 'Owner must confirm via Control Center Developer Autonomy enroll with confirmed:true. This file never self-approves.',
      alias: req.alias || null,
      repository: req.repository || null,
      project_id: req.project_id || null,
      goal_id: req.goal_id || null,
      workers: Array.isArray(req.workers) ? req.workers : [],
      workflows: Array.isArray(req.workflows) ? req.workflows : [],
      duration_days: req.duration_days || 30,
      diff_check: req.diff_check || 'diff-check',
      default_tests: Array.isArray(req.default_tests) ? req.default_tests : [],
      cognitive_files: Array.isArray(req.cognitive?.files) ? req.cognitive.files
        : (Array.isArray(req.cognitive_files) ? req.cognitive_files : []),
      cognitive_callers: Array.isArray(req.cognitive?.delegated_callers) ? req.cognitive.delegated_callers : [],
      cognitive_repairs: Number.isInteger(req.cognitive?.repair_attempts) ? req.cognitive.repair_attempts : 0,
      google_workspace_qualification: raw.google_workspace_qualification || null,
      authority: false,
    });
  }
  return out;
}

module.exports = { listPending, enrollmentDir };
