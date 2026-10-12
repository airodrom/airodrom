'use strict';
// Test-only host fixture: one controlled verification failure in a disposable workspace.
// Marker lives under gitignored `.airodrom/` so consume/apply cannot pollute repository_v2.
// Applied receipts are stored under ~/.airodrom/self-repair-markers/ (outside the workspace).
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');

const MARKER = '.airodrom/controlled-verify-fail-once.json';

function receiptDir() {
  return path.join(os.homedir(), '.airodrom', 'self-repair-markers');
}

function receiptPath(workspace) {
  const key = createHash('sha256').update(String(workspace)).digest('hex').slice(0, 32);
  return path.join(receiptDir(), key + '.applied.json');
}

function readMarker(workspace) {
  if (typeof workspace !== 'string' || !path.isAbsolute(workspace)) return null;
  const markerPath = path.join(workspace, MARKER);
  if (!fs.existsSync(markerPath)) return null;
  let marker;
  try { marker = JSON.parse(fs.readFileSync(markerPath, 'utf8')); } catch { return null; }
  if (!marker || marker.version !== 1 || marker.mode !== 'exact_file_once') return null;
  if (marker.file !== 'fixture.txt') return null;
  if (marker.wrong_content !== 'gamma\n' || marker.expected_content !== 'beta\n') return null;
  if (marker.authority !== false) return null;
  return { marker, markerPath };
}

function applyControlledFailure(mission) {
  if (!mission?.envelope || mission.envelope.repair_of) return { applied: false, reason: 'not_original_mission' };
  if (mission.envelope.kind === 'conversation' || mission.envelope.kind === 'browser_research') {
    return { applied: false, reason: 'unsupported_kind' };
  }
  const found = readMarker(mission.envelope.workspace);
  if (!found) return { applied: false, reason: 'no_marker' };
  const { marker, markerPath } = found;
  const allowed = mission.envelope.allowed_files || [];
  if (!allowed.includes(marker.file)) return { applied: false, reason: 'file_outside_scope' };
  const target = path.join(mission.envelope.workspace, marker.file);
  const realWorkspace = fs.realpathSync(mission.envelope.workspace);
  const realTarget = fs.realpathSync(path.dirname(target));
  if (realTarget !== realWorkspace && !realTarget.startsWith(realWorkspace + path.sep)) {
    return { applied: false, reason: 'path_escape' };
  }
  // Persist applied receipt outside the disposable workspace so git verification stays clean.
  fs.mkdirSync(receiptDir(), { recursive: true, mode: 0o700 });
  const record = {
    ...marker,
    applied_at: Date.now(),
    mission_id: mission.id,
    workspace: realWorkspace,
    authority: false,
  };
  const applied = receiptPath(realWorkspace);
  fs.writeFileSync(applied, JSON.stringify(record, null, 2) + '\n', { mode: 0o600 });
  fs.unlinkSync(markerPath);
  fs.writeFileSync(target, marker.wrong_content, { mode: 0o600 });
  return { applied: true, file: marker.file, wrong_content: marker.wrong_content, receipt: applied };
}

function markerPresent(workspace) {
  return !!readMarker(workspace);
}

function appliedReceipt(workspace) {
  try {
    const p = receiptPath(fs.realpathSync(workspace));
    return fs.existsSync(p) ? p : null;
  } catch { return null; }
}

module.exports = { applyControlledFailure, markerPresent, appliedReceipt, MARKER, receiptPath };
