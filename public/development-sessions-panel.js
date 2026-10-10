'use strict';
// Development Sessions panel. Summary body originated from governed OpenCode Mission
// eea8d18d-f742-49b4-ae0f-1e8e43308638; host independent verification repaired helper
// contracts, inspect field names, and removed HTML injection.
window.AirodromDevelopmentSessions = {
  render(result, ds, ui) {
    const labels = {
      LOCAL_ONLY: 'LOCAL ONLY',
      READY_TO_PUSH: 'READY TO PUSH',
      PR_OPEN: 'PR OPEN',
      READY_TO_MERGE: 'READY TO MERGE',
      MERGED: 'MERGED'
    };
    const nextAction = (state) => ({
      LOCAL_ONLY: 'Continue local work / record focused evidence',
      READY_TO_PUSH: 'Operator push authorization required',
      PR_OPEN: 'Await CI or operator',
      READY_TO_MERGE: 'Operator merge authorization required',
      MERGED: 'Session closed'
    })[state] || 'Review session evidence';
    const shortId = (id) => (id && id.length > 8 ? id.slice(0, 8) : (id || '—'));
    const session = ds.active || (ds.recent && ds.recent[0]) || null;

    result.append(ui.glass(
      'Local-first defaults',
      ds.merge_window_open ? 'Merge window open' : 'Merge window closed',
      'auto push off · auto merge off · hosted CI auto-dispatch off'
    ));
    result.append(ui.node(
      'p',
      'Timezone ' + (ds.merge_window?.timezone || '—') + ' · ' + (ds.merge_window?.local_start || '') + '-' + (ds.merge_window?.local_end || '') + ' · open ' + (ds.open_sessions || 0),
      'muted'
    ));

    const pending = Object.entries(ds.integration_counts || {})
      .filter(([k, n]) => n && ['READY_TO_PUSH', 'READY_TO_MERGE'].includes(k))
      .map(([k, n]) => (labels[k] || k) + ' ' + n);
    result.append(ui.node(
      'p',
      'Daily integration checkpoint requires operator authorization. Pending approvals: ' + (pending.length ? pending.join(' · ') : 'none') + '. CI cost estimate: Unavailable.',
      'muted'
    ));

    const prepare = ui.button('Prepare Daily Integration', async () => {
      try {
        window.__dailyIntegration = await ui.api('/api/assistant/development-sessions/prepare-daily-integration', {
          confirmed: true,
          request_id: crypto.randomUUID()
        });
        ui.setNotice('Daily integration prepared. No push, merge, or hosted CI dispatch.');
      } catch (error) {
        ui.setNotice(error.message || 'Daily integration prepare unavailable');
      }
    });
    prepare.dataset.focusKey = 'prepare-daily-integration';
    result.append(prepare);

    const daily = window.__dailyIntegration;
    if (daily) {
      const card = ui.glass(
        'Daily integration checkpoint',
        daily.push || daily.merge || daily.hosted_ci_dispatched ? 'ERROR' : 'Prepared local-only',
        (daily.session_count || 0) + ' session(s) · push ' + (daily.push ? 'yes' : 'no') + ' · merge ' + (daily.merge ? 'yes' : 'no') + ' · hosted CI ' + (daily.hosted_ci_dispatched ? 'yes' : 'no')
      );
      for (const s of daily.sessions || []) {
        card.append(ui.node(
          'p',
          (labels[s.integration_state] || s.integration_state) + ' · ' + (s.branch || '') + ' · missions ' + (s.related_missions?.length || 0) + ' · commits ' + (s.local_commits?.length || 0) + ' · changed ' + (s.changed_files?.length || 0) + ' · focused evidence ' + (s.focused_test_evidence?.length || 0),
          'muted'
        ));
        if (s.readiness?.blockers?.length) card.append(ui.node('p', 'Blockers: ' + s.readiness.blockers.join(', '), 'muted'));
      }
      result.append(card);
    }

    if (!session) {
      result.append(ui.empty
        ? ui.empty('No Development Sessions. Related Missions share one local session; push/PR waits for the batch checkpoint.')
        : ui.node('p', 'No Development Sessions. Related Missions share one local session; push/PR waits for the batch checkpoint.', 'empty'));
      result.append(ui.node('p', 'Acceptance remains Mission host verification; sessions never grant Acceptance or auto-merge.', 'muted'));
      return true;
    }

    const summary = ui.glass(
      'Active Session Summary',
      labels[session.integration_state] || session.integration_state || 'Unavailable',
      (session.goal || 'Development Session') + ' · ' + shortId(session.id)
    );

    const facts = ui.node('div', null, 'facts');
    const row = (label, value) => {
      const fact = ui.node('div');
      fact.append(ui.node('small', label), ui.node('span', value));
      facts.append(fact);
    };

    row('Active Development Session', shortId(session.id) + ' · ' + (session.state || '—') + ' · ' + (labels[session.integration_state] || session.integration_state || '—'));
    const missionIds = Array.isArray(session.missions) ? session.missions.slice(0, 5).map(shortId) : [];
    row('Associated Missions', String(session.mission_count ?? missionIds.length) + (missionIds.length ? ' · ' + missionIds.join(', ') : ''));
    row('Current worker', session.assigned_worker || '—');
    row('Repository and branch', (session.repository || '—') + ' · ' + (session.branch || '—'));
    summary.append(ui.node('p', 'worktree ' + (session.worktree || '—'), 'muted'));

    const dirty = Array.isArray(session.dirty_files) ? session.dirty_files : [];
    row('Local changes', dirty.length ? dirty.length + ' file(s)' : 'No local changes observed');
    if (dirty.length) summary.append(ui.node('p', dirty.slice(0, 8).join(' · '), 'muted'));

    const passed = session.evidence?.passed ?? 0;
    const failed = session.evidence?.failed ?? 0;
    const latestEvidence = Array.isArray(session.evidence?.items) ? session.evidence.items[0] : null;
    row('Focused verification', passed + ' passed · ' + failed + ' failed' + (latestEvidence ? ' · latest ' + (latestEvidence.kind || 'evidence') : ''));
    if (latestEvidence?.summary) summary.append(ui.node('p', String(latestEvidence.summary).slice(0, 240), 'muted'));

    row(
      'Pending integration checkpoint',
      (labels[session.integration_state] || session.integration_state || '—') + ' · push/merge/hosted CI require operator authorization'
    );

    const commit = Array.isArray(session.local_commits) ? session.local_commits[0] : null;
    let lastActivity = 'Unavailable';
    if (commit) lastActivity = (commit.subject || 'commit') + (commit.sha ? ' · ' + shortId(commit.sha) : '');
    else if (latestEvidence) lastActivity = (latestEvidence.kind || 'evidence') + (latestEvidence.recorded_at ? ' · ' + ui.stamp(latestEvidence.recorded_at) : '');
    row('Last completed activity', lastActivity);

    row('Next permitted action', nextAction(session.integration_state));
    summary.append(facts);
    result.append(summary);

    for (const s of ds.recent || []) {
      const card = ui.glass(
        s.goal || 'Development Session',
        labels[s.integration_state] || s.integration_state || '—',
        (s.assigned_worker || '—') + ' · ' + (s.branch || '—') + ' · focused tests ' + (s.evidence?.passed || 0) + '/' + (s.evidence?.failed || 0)
      );
      card.append(ui.node('p', (s.repository || '') + ' · worktree ' + (s.worktree || '—'), 'muted'));
      card.append(ui.node(
        'p',
        'Related Missions ' + (s.mission_count || 0) + ' · local commits ' + (s.local_commits?.length || 0) + ' · files changed ' + (s.dirty_files?.length || 0) + (s.head_sha ? ' · ' + shortId(s.head_sha) : '') + (s.pr_number ? ' · PR #' + s.pr_number : ' · no PR'),
        'muted'
      ));
      result.append(card);
    }

    result.append(ui.node('p', 'Acceptance remains Mission host verification; sessions never grant Acceptance or auto-merge.', 'muted'));
    result.append(ui.node('p', 'States: LOCAL ONLY · READY TO PUSH · PR OPEN · READY TO MERGE · MERGED.', 'muted'));
    return true;
  }
};
