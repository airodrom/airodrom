'use strict';

function safeActionText(value) { return typeof value === 'string' && value.trim() ? value.trim().slice(0, 1_000) : null; }
function route(action, preferred = []) {
  const lower = action.toLocaleLowerCase('en-US');
  if (/\b(test|inspect|local|repository|git|shell)\b/.test(lower)) return 'pi';
  if (/\b(code|implement|refactor|migration|schema)\b/.test(lower)) return preferred.includes('cursor') ? 'cursor' : 'pi';
  if (/\b(research|market|compare|investigate)\b/.test(lower)) return 'research';
  if (/\b(architecture|decision|design|plan)\b/.test(lower)) return 'chatgpt';
  return preferred[0] || 'chatgpt';
}

class NextActionEngine {
  constructor({ projects } = {}) {
    if (!projects || typeof projects.listProjects !== 'function' || typeof projects.summary !== 'function') throw new Error('Next Action Engine requires project state');
    this.projects = projects;
  }
  observe() {
    const candidates = [];
    for (const project of this.projects.listProjects({ status: 'active', limit: 200 })) {
      const summary = this.projects.summary(project.projectId); const blockers = summary.blockers;
      for (const mission of summary.missions) {
        if (!['planned', 'active'].includes(mission.status)) continue;
        const action = safeActionText(mission.nextAction || project.nextAction);
        if (!action) continue;
        const blocked = blockers.some(blocker => blocker.ownerType === 'mission' && blocker.ownerId === mission.missionId);
        candidates.push({ projectId: project.projectId, projectName: project.name, missionId: mission.missionId, goalId: mission.goalId,
          action, blocked, priority: project.priority, autonomyLevel: project.autonomyLevel, preferredAgents: mission.preferredAgents.length ? mission.preferredAgents : project.preferredAgents });
      }
      if (!summary.missions.length && safeActionText(project.nextAction)) candidates.push({ projectId: project.projectId, projectName: project.name, missionId: null, goalId: null, action: project.nextAction, blocked: blockers.length > 0, priority: project.priority, autonomyLevel: project.autonomyLevel, preferredAgents: project.preferredAgents });
    }
    return candidates;
  }
  choose({ projectId = null } = {}) {
    const candidates = this.observe().filter(candidate => !candidate.blocked && (projectId === null || candidate.projectId === projectId)).sort((a, b) => b.priority - a.priority || a.projectId.localeCompare(b.projectId) || String(a.missionId).localeCompare(String(b.missionId)));
    if (!candidates.length) return { state: 'waiting', reason: 'No unblocked project action is ready.' };
    const candidate = candidates[0]; const chosen = { state: 'suggested', ...candidate, route: route(candidate.action, candidate.preferredAgents), execution: 'not_dispatched', requiresOperatorReview: true };
    return chosen;
  }
}

module.exports = { NextActionEngine, route };
