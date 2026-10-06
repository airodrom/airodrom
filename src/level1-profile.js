'use strict';

const path = require('node:path');
const config = require('../config/safe-autonomy-level1.json');

const LEVEL1_PROFILE_ID = config.id;
const WORKSPACE = path.resolve(__dirname, '..', config.workspaceRelative);
const MISSION_OBJECTIVE = config.missionObjective;
const ACCEPTANCE_CRITERIA = Object.freeze([...config.acceptanceCriteria]);
const ALL_READ_PATHS = Object.freeze([...config.taskA.readPaths, ...config.taskBCandidates.flatMap(candidate => candidate.readPaths)].sort());
const ALLOWED_READ_PATHS = new Set([
  ...config.taskA.readPaths,
  ...config.taskBCandidates.flatMap(candidate => candidate.readPaths)
]);
const CANDIDATES = new Map(config.taskBCandidates.map(candidate => [candidate.taskId, Object.freeze({ ...candidate })]));

function assertReadOnlyMission(mission) {
  if (!mission || mission.capabilityProfile !== LEVEL1_PROFILE_ID || mission.level !== 1) return false;
  if (mission.networkPolicy?.egress !== 'local-only' || mission.networkPolicy?.webFetch !== false) return false;
  if (!Array.isArray(mission.readOnlyPaths) || mission.readOnlyPaths.length !== 1) return false;
  const phase = mission.level1Phase;
  const expected = phase === 'task_a' ? config.taskA.readPaths : phase === 'task_b' ? CANDIDATES.get(mission.selectedTaskBId)?.readPaths : null;
  if (!expected || expected.length !== 1 || mission.readOnlyPaths[0] !== expected[0] || mission.readOnlyPaths.some(readPath => !ALLOWED_READ_PATHS.has(readPath))) return false;
  return true;
}

function taskDefinition(phase, taskBId = null) {
  if (phase === 'task_a') {
    return Object.freeze({
      taskId: config.taskA.id,
      objective: config.taskA.objective,
      readOnlyPaths: [...config.taskA.readPaths]
    });
  }
  if (phase === 'task_b') {
    const candidate = CANDIDATES.get(taskBId);
    if (!candidate) throw new Error('Task B must be selected from the Level 1 candidate allowlist after Task A');
    return Object.freeze({
      taskId: candidate.taskId,
      objective: candidate.objective,
      readOnlyPaths: [...candidate.readPaths],
      route: candidate.route,
      expectedProof: candidate.expectedProof
    });
  }
  throw new Error('Unknown Level 1 task phase');
}

function selectExpectedTaskB(taskAResult) {
  if (typeof taskAResult !== 'string' || Buffer.byteLength(taskAResult) > 2048 || /[^\x00-\x7f]/.test(taskAResult)) throw new Error('Task A result is outside the Level 1 fixture format');
  const normalized = taskAResult.endsWith('\n') ? taskAResult.slice(0, -1) : taskAResult;
  const fields = normalized.split('\n');
  if (fields.length !== 2 || fields[0] !== fields[0].trim() || fields[1] !== fields[1].trim()) throw new Error('Task A result must contain exactly one route and proof ID');
  const route = /^route=([a-z]+)$/.exec(fields[0])?.[1];
  const proofId = /^proof_id=([A-Z0-9-]+)$/.exec(fields[1])?.[1];
  const candidate = config.taskBCandidates.find(item => item.route === route && item.expectedProof === proofId);
  if (!candidate) throw new Error('Task A result did not match one authorized route/proof pair');
  return candidate.taskId;
}

function isExpectedTaskBResult(taskBId, taskBResult) {
  const candidate = CANDIDATES.get(taskBId);
  if (!candidate || typeof taskBResult !== 'string' || Buffer.byteLength(taskBResult) > 2048 || /[^\x00-\x7f]/.test(taskBResult)) return false;
  const normalized = taskBResult.endsWith('\n') ? taskBResult.slice(0, -1) : taskBResult;
  return normalized === `proof=${candidate.expectedProof}\nstatus=valid`;
}

function createMissionFields(phase, taskBId = null) {
  const definition = taskDefinition(phase, taskBId);
  return {
    level: 1,
    capabilityProfile: LEVEL1_PROFILE_ID,
    level1Phase: phase,
    selectedTaskBId: phase === 'task_b' ? taskBId : null,
    readOnlyPaths: definition.readOnlyPaths,
    scope: { workspace: WORKSPACE, readOnlyPaths: [...ALL_READ_PATHS] },
    networkPolicy: { egress: 'local-only', webFetch: false },
    requireGrant: true,
    budget: { maxRuntimeMs: config.grant.maxRuntimeMs, maxActions: config.grant.maxActions, maxRetries: 0, maxSpendMicros: 0 },
    used: { runtimeMs: 0, actions: 0, retries: 0 }
  };
}

module.exports = {
  config, LEVEL1_PROFILE_ID, WORKSPACE, MISSION_OBJECTIVE, ACCEPTANCE_CRITERIA, ALL_READ_PATHS, ALLOWED_READ_PATHS, CANDIDATES,
  assertReadOnlyMission, taskDefinition, selectExpectedTaskB, isExpectedTaskBResult, createMissionFields
};
