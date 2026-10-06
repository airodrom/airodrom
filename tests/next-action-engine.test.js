'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { NextActionEngine, route } = require('../src/next-action-engine');

function projects(rows) {
  return { listProjects: () => rows.map(row => row.project), summary: projectId => rows.find(row => row.project.projectId === projectId).summary };
}
function row({ projectId, priority, nextAction = null, mission = null, blockers = [], preferredAgents = [] }) {
  return { project: { projectId, name: projectId, status: 'active', priority, nextAction, preferredAgents }, summary: { blockers, missions: mission ? [mission] : [] } };
}

test('Next Action Engine ranks unblocked durable mission work and routes without dispatching', () => {
  const engine = new NextActionEngine({ projects: projects([
    row({ projectId: 'low', priority: 10, mission: { missionId: 'low-mission', goalId: 'low-goal', status: 'active', nextAction: 'Inspect local repository state.', preferredAgents: ['host'] } }),
    row({ projectId: 'high', priority: 90, mission: { missionId: 'high-mission', goalId: 'high-goal', status: 'planned', nextAction: 'Implement the SQLite migration.', preferredAgents: ['cursor', 'host'] } })
  ]) });
  const choice = engine.choose();
  assert.equal(choice.state, 'suggested'); assert.equal(choice.projectId, 'high'); assert.equal(choice.route, 'cursor'); assert.equal(choice.execution, 'not_dispatched'); assert.equal(choice.requiresOperatorReview, true);
});

test('Next Action Engine leaves blocked work alone and returns waiting without inventing work', () => {
  const engine = new NextActionEngine({ projects: projects([
    row({ projectId: 'blocked', priority: 100, mission: { missionId: 'blocked-mission', goalId: 'goal', status: 'active', nextAction: 'Deploy the service.', preferredAgents: ['host'] }, blockers: [{ ownerType: 'mission', ownerId: 'blocked-mission' }] }),
    row({ projectId: 'empty', priority: 20 })
  ]) });
  assert.deepEqual(engine.choose(), { state: 'waiting', reason: 'No unblocked project action is ready.' });
  assert.equal(route('Research competitors.', []), 'research');
});
