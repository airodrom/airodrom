'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomBytes } = require('node:crypto');

const ACTIVE_CHAT_PROFILE_ID = 'active-chat-local-ollama-smoke-v1';
const ACTIVE_CHAT_MODE = 'active_chat_local_smoke';
const LOCAL_OLLAMA = Object.freeze({ provider: 'ollama', model: 'qwen3-coder:30b', baseUrl: 'http://127.0.0.1:11434/v1' });
const READ_ONLY_PATHS = Object.freeze(['evidence/task-a.txt', 'evidence/task-b.txt']);
const TASK_A_REQUEST = `Use only the read tool to read ${READ_ONLY_PATHS[0]}. Return its complete single line exactly, with no added text. Do not use another tool or take another action.`;
const TASK_B_REQUEST = `Use only the read tool to read ${READ_ONLY_PATHS[1]}. Return its complete single line exactly, with no added text. Do not use another tool or take another action.`;
const MCP_CONTINUATION = 'ACTIVE_CHAT_CONTINUE_TASK_B';
const DESCRIPTION = 'Active Chat local Qwen two-turn smoke';
const OBJECTIVE = 'Complete the bounded two-turn Active Chat smoke using brokered local Qwen and two host-verified fixture reads.';
const ACCEPTANCE_CRITERIA = Object.freeze([
  'Task A returns only the selected evidence after a host-recorded broker read of its assigned fixture.',
  'Task B is dispatched only after the authenticated MCP controller receives the settled Task A evidence.',
  'Task B returns only the selected evidence after a host-recorded broker read of its assigned fixture.'
]);
// Each turn uses one inference request to select the sole read and a second
// request to emit the final evidence. The fixed smoke therefore permits four
// inference requests and two reads. No retry or additional tool action fits.
const BUDGET = Object.freeze({ maxRuntimeMs: 240_000, maxActions: 6, maxRetries: 0, maxSpendMicros: 0, maxPromptTurns: 2 });
const CAPABILITIES = Object.freeze(['inference', 'read']);

const sha256 = value => createHash('sha256').update(value).digest('hex');
const sameArray = (left, right) => Array.isArray(left) && left.length === right.length && left.every((value, index) => value === right[index]);

function canonicalWorkspace(workspace) {
  if (typeof workspace !== 'string' || !path.isAbsolute(workspace)) throw new Error('Active Chat workspace must be absolute');
  const real = fs.realpathSync(workspace);
  if (!fs.statSync(real).isDirectory()) throw new Error('Active Chat workspace must be a directory');
  return real;
}
function fixtureDescriptor(relativePath, content) {
  return Object.freeze({ path: relativePath, sha256: sha256(content), normalizedSha256: sha256(content.replace(/\n$/, '')), bytes: Buffer.byteLength(content) });
}
function validFixtureDescriptor(value, expectedPath) {
  return Boolean(value) && value.path === expectedPath && /^[a-f0-9]{64}$/.test(value.sha256) && /^[a-f0-9]{64}$/.test(value.normalizedSha256) && Number.isSafeInteger(value.bytes) && value.bytes > 0 && value.bytes <= 1024;
}
function fixtureScope(fixtures) {
  if (!fixtures || !validFixtureDescriptor(fixtures.taskA, READ_ONLY_PATHS[0]) || !validFixtureDescriptor(fixtures.taskB, READ_ONLY_PATHS[1])) throw new Error('Active Chat fixture descriptors are required');
  return { taskA: { ...fixtures.taskA }, taskB: { ...fixtures.taskB } };
}
function scope(workspace, fixtures) {
  const canonical = canonicalWorkspace(workspace);
  return {
    workspace: canonical,
    readOnlyPaths: [...READ_ONLY_PATHS],
    fixtureEvidence: fixtureScope(fixtures),
    localInference: { provider: LOCAL_OLLAMA.provider, model: LOCAL_OLLAMA.model, baseUrl: LOCAL_OLLAMA.baseUrl, transport: 'brokered-unix-socket' },
    networkPolicy: { egress: 'local-only' }
  };
}
function missionFields({ id, workspace, fixtures }) {
  const canonical = canonicalWorkspace(workspace);
  return {
    id,
    objective: OBJECTIVE,
    objectiveSet: true,
    request: TASK_A_REQUEST,
    retryInstructions: null,
    criteria: [...ACCEPTANCE_CRITERIA],
    workspace: canonical,
    scope: scope(canonical, fixtures),
    networkPolicy: { egress: 'local-only' },
    capabilityProfile: ACTIVE_CHAT_PROFILE_ID,
    budget: { ...BUDGET },
    used: { runtimeMs: 0, actions: 0, retries: 0, reads: 0, inferenceRequests: 0, promptTurns: 0 },
    requireGrant: true,
    status: 'awaiting_operator_grant',
    attempts: 0,
    started: false
  };
}
function assertActiveChatMission(mission) {
  if (!mission || typeof mission !== 'object' || mission.capabilityProfile !== ACTIVE_CHAT_PROFILE_ID || mission.requireGrant !== true) throw new Error('Active Chat mission profile is required');
  const workspace = canonicalWorkspace(mission.workspace);
  if (mission.objective !== OBJECTIVE || !sameArray(mission.criteria, ACCEPTANCE_CRITERIA) || !mission.scope || mission.scope.workspace !== workspace || !sameArray(mission.scope.readOnlyPaths, READ_ONLY_PATHS)) throw new Error('Active Chat mission identity changed');
  fixtureScope(mission.scope.fixtureEvidence);
  const local = mission.scope.localInference;
  if (!local || local.provider !== LOCAL_OLLAMA.provider || local.model !== LOCAL_OLLAMA.model || local.baseUrl !== LOCAL_OLLAMA.baseUrl || local.transport !== 'brokered-unix-socket') throw new Error('Active Chat local inference scope changed');
  if (mission.networkPolicy?.egress !== 'local-only' || mission.scope.networkPolicy?.egress !== 'local-only') throw new Error('Active Chat egress scope changed');
  const budget = mission.budget || {};
  for (const [key, value] of Object.entries(BUDGET)) if (budget[key] !== value) throw new Error(`Active Chat budget changed: ${key}`);
  return workspace;
}
function prepareFixtures(workspace, { entropy = randomBytes } = {}) {
  const root = canonicalWorkspace(workspace);
  const directory = path.join(root, 'evidence');
  if (fs.existsSync(directory)) throw new Error('Active Chat fixture directory already exists');
  const token = () => entropy(24).toString('base64url');
  const contents = [
    [READ_ONLY_PATHS[0], `ACTIVE_CHAT_TASK_A=${token()}\n`],
    [READ_ONLY_PATHS[1], `ACTIVE_CHAT_TASK_B=${token()}\n`]
  ];
  fs.mkdirSync(directory, { mode: 0o700 });
  const fixtures = {};
  try {
    for (const [relative, content] of contents) {
      const file = path.join(root, relative);
      const fd = fs.openSync(file, 'wx', 0o600);
      try { fs.writeFileSync(fd, content, 'utf8'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || fs.realpathSync(file) !== file || fs.readFileSync(file, 'utf8') !== content) throw new Error('Active Chat fixture is not a verified canonical regular file');
      fs.chmodSync(file, 0o400);
      fixtures[relative === READ_ONLY_PATHS[0] ? 'taskA' : 'taskB'] = fixtureDescriptor(relative, content);
    }
    fs.chmodSync(directory, 0o500);
    const sealed = fs.lstatSync(directory);
    if (!sealed.isDirectory() || sealed.isSymbolicLink() || (sealed.mode & 0o222)) throw new Error('Active Chat fixture directory did not seal read-only');
    return fixtureScope(fixtures);
  } catch (error) {
    // This directory was created by this call; never change any pre-existing path.
    try { fs.chmodSync(directory, 0o700); } catch { /* Preserve the original failure. */ }
    throw error;
  }
}
function fixtureForPhase(mission, phase) {
  assertActiveChatMission(mission);
  if (phase === 'task_a') return mission.scope.fixtureEvidence.taskA;
  if (phase === 'task_b') return mission.scope.fixtureEvidence.taskB;
  throw new Error('Unknown Active Chat phase');
}
function normalizeResult(value) {
  if (typeof value !== 'string' || !value || value.includes('\r')) return null;
  return value.endsWith('\n') ? value.slice(0, -1) : value;
}
function verifyReadEvidence({ mission, activeChat, taskId, sessionId, phase, result }) {
  const fixture = fixtureForPhase(mission, phase);
  const record = activeChat?.readEvidence?.[phase];
  const normalized = normalizeResult(result);
  if (!record || !normalized) return null;
  if (record.missionId !== mission.id || record.taskId !== taskId || record.sessionId !== sessionId || record.phase !== phase || record.path !== fixture.path || record.contentSha256 !== fixture.sha256 || record.outputSha256 !== fixture.sha256) return null;
  if (sha256(normalized) !== fixture.normalizedSha256) return null;
  return { value: normalized, sha256: fixture.normalizedSha256, readAt: record.at };
}

module.exports = {
  ACTIVE_CHAT_PROFILE_ID, ACTIVE_CHAT_MODE, LOCAL_OLLAMA, READ_ONLY_PATHS,
  TASK_A_REQUEST, TASK_B_REQUEST, MCP_CONTINUATION, DESCRIPTION, OBJECTIVE,
  ACCEPTANCE_CRITERIA, BUDGET, CAPABILITIES, sha256, canonicalWorkspace, scope,
  missionFields, assertActiveChatMission, prepareFixtures, fixtureForPhase,
  verifyReadEvidence, normalizeResult
};
