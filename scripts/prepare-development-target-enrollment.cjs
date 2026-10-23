#!/usr/bin/env node
'use strict';
/**
 * Prepare (do not execute) Developer Autonomy enrollment payloads for
 * authoritative development targets. Never self-approves confirmed=true.
 *
 * Usage:
 *   node --experimental-sqlite scripts/prepare-development-target-enrollment.cjs
 *
 * Writes durable proposal JSON under ~/.airodrom/activation/development-target-enrollment/
 * and prints a redacted summary. Owner must confirm each enroll via
 * Control Center → Developer Autonomy (or POST .../enroll with confirmed:true).
 */
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const local = require(path.join(ROOT, 'src/local-bootstrap'));
const pr = require(path.join(ROOT, 'src/project-resolution'));

function redacted(payload) {
  return {
    alias: payload.alias,
    repository: payload.repository,
    project_id: payload.project_id,
    goal_id: payload.goal_id,
    workers: payload.workers,
    workflows: payload.workflows,
    duration_days: payload.duration_days,
    cognitive_files: payload.cognitive?.files || [],
    confirmed: payload.confirmed,
    note: 'Owner must set confirmed:true locally; this proposal keeps confirmed:false.',
  };
}

async function main() {
  const home = local.localHome();
  const outDir = path.join(home, 'activation', 'development-target-enrollment');
  fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });

  const catalog = pr.loadDevelopmentTargets();
  const da = await local.request(home, '/api/assistant/developer-autonomy');
  const active = (da.policies || []).filter(p => p.state === 'active');

  // Discover projects via control plane SQLite through assistant endpoints when possible.
  // Fallback: prepare path-only proposals keyed by catalog.
  const proposals = [];

  for (const target of catalog) {
    const matchingPolicies = active.filter(p => pr.pathMatchesTarget(p.repository, target));
    const cursorReady = matchingPolicies.some(p => (p.workers || []).includes('cursor'));
    const cognitiveReady = matchingPolicies.some(p => {
      // list endpoint may omit cognitive; inspect when needed
      return true;
    });

    let detail = null;
    if (matchingPolicies[0]?.policy_id) {
      try {
        detail = await local.request(home, '/api/assistant/developer-autonomy/policy?policy_id='
          + encodeURIComponent(matchingPolicies[0].policy_id));
      } catch { /* prepare without detail */ }
    }

    if (target.id === 'arecibo' && matchingPolicies.length && detail) {
      const needsCursor = !(detail.workers || []).includes('cursor');
      if (needsCursor) {
        const payload = {
          alias: 'arecibo-core-cursor-dev',
          repository: detail.repository,
          project_id: detail.project_id,
          goal_id: detail.goal_id,
          workflows: detail.workflows || ['routine_edit', 'repair', 'feature_branch', 'draft_pr', 'test'],
          budgets: {
            ...(detail.budgets || {}),
            max_files: Math.min(12, detail.budgets?.max_files || 12),
            max_disk_mb: Math.min(4096, detail.budgets?.max_disk_mb || 4096),
          },
          workers: ['opencode', 'cursor'],
          duration_days: 30,
          confirmed: false,
          diff_check: detail.verification_defaults?.diff_check || 'diff-check',
          default_tests: detail.verification_defaults?.tests || ['arecibo-typecheck'],
          cognitive: detail.cognitive ? {
            version: detail.cognitive.version || 3,
            files: detail.cognitive.files,
            delegated_callers: detail.cognitive.delegated_callers || [],
            planning_attempts: detail.cognitive.planning_attempts || 2,
            planning_ms: detail.cognitive.planning_ms || 60000,
            execution_ms: detail.cognitive.execution_ms || 60000,
            repair_attempts: detail.cognitive.repair_attempts ?? 1,
            max_assignments: detail.cognitive.max_assignments || 2,
            acceptance: detail.cognitive.acceptance || 'automatic',
          } : undefined,
          prerequisite: {
            action: 'revoke_or_supersede_opencode_only_policy',
            existing_policy_id: detail.policy_id,
            existing_alias: detail.alias,
            reason: 'Active Arecibo policy lacks Cursor on the worker allowlist',
          },
          never_auto_reminder: [
            'production_deploy', 'credentials_secrets', 'plaid_live',
            'financial_data_disclosure', 'privileged_infrastructure',
          ],
          authority: false,
        };
        proposals.push({ target_id: target.id, repository_id: target.repository_id, kind: 're_enroll_with_cursor', payload });
      } else {
        proposals.push({
          target_id: target.id,
          repository_id: target.repository_id,
          kind: 'already_cursor_ready',
          payload: { repository: detail.repository, policy_id: detail.policy_id, workers: detail.workers, authority: false },
        });
      }
      continue;
    }

    if (target.id === 'airodrom') {
      const repoCandidates = [
        '/Users/andrew/code/airodrom-da-main',
        '/Users/andrew/code/airodrom-source-main',
        '/Users/andrew/code/airodrom',
      ];
      const repository = repoCandidates.find(p => {
        try {
          return fs.existsSync(p) && fs.existsSync(path.join(p, '.git'))
            && fs.existsSync(path.join(p, '.vscode', 'tasks.json'));
        } catch { return false; }
      }) || null;

      proposals.push({
        target_id: target.id,
        repository_id: target.repository_id,
        kind: repository ? 'enroll_new' : 'missing_repository_root',
        payload: repository ? {
          alias: 'airodrom-source-cursor-dev',
          repository,
          project_id: null,
          goal_id: null,
          workflows: ['routine_edit', 'repair', 'feature_branch', 'draft_pr', 'test'],
          budgets: {
            max_repairs: 2,
            max_concurrent_missions: 1,
            grant_ttl_minutes: 240,
            max_files: 12,
            max_worktrees: 4,
            max_runtime_hours: 4,
            max_disk_mb: 4096,
          },
          workers: ['opencode', 'cursor'],
          duration_days: 30,
          confirmed: false,
          diff_check: 'diff-check',
          default_tests: ['development-session-summary-v1'],
          cognitive: {
            version: 3,
            files: ['README.md', 'CHANGELOG.md', 'docs/ARCHITECTURE.md', 'docs/CURRENT-STATE.md', 'AGENTS.md']
              .filter(f => fs.existsSync(path.join(repository, f))),
            delegated_callers: [],
            planning_attempts: 2,
            planning_ms: 60000,
            execution_ms: 60000,
            repair_attempts: 1,
            max_assignments: 2,
            acceptance: 'automatic',
          },
          setup_steps: [
            'Create clean worktree at /Users/andrew/code/airodrom-da-main from origin/main if missing',
            'Register Control Center project "Airodrom Source" with that repository',
            'Create goal "Bounded source development"',
            'Set project_id and goal_id on this payload',
            'Owner confirms enroll with confirmed:true (never from ChatGPT text)',
          ],
          authority: false,
        } : {
          required_root: '/Users/andrew/code/airodrom-da-main',
          message: 'Create an isolated clean worktree of airodrom/airodrom with .vscode/tasks.json before enrollment.',
          authority: false,
        },
      });
    }
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(outDir, `proposals-${stamp}.json`);
  const doc = {
    version: 1,
    prepared_at: Date.now(),
    request_id: randomUUID(),
    note: 'Proposals only. confirmed remains false. Owner authorization required.',
    proposals,
    authority: false,
  };
  fs.writeFileSync(file, JSON.stringify(doc, null, 2), { mode: 0o600 });

  console.log(JSON.stringify({
    written: file.replace(process.env.HOME, '~'),
    summary: proposals.map(p => ({
      target_id: p.target_id,
      repository_id: p.repository_id,
      kind: p.kind,
      preview: p.payload?.repository ? redacted({
        ...p.payload,
        project_id: p.payload.project_id || 'PENDING',
        goal_id: p.payload.goal_id || 'PENDING',
      }) : p.payload,
    })),
    authority: false,
  }, null, 2));
}

main().catch(error => {
  console.error(String(error && error.message || error).slice(0, 400));
  process.exitCode = 1;
});
