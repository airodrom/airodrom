'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { ExpandedAutonomy, MODES, DEFAULT_FLAGS } = require('../src/expanded-autonomy');

function harness(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const events = [];
  const bridge = {
    controlStore: {
      db,
      event: (type, id, detail) => events.push({ type, id, detail })
    },
    missions: {
      riskAcceptance: {
        pref: false,
        setPreference(input) {
          if (input.enabled === true) {
            const ea = bridge.expandedAutonomy.effective('operator');
            if (ea.mode === 'manual' || ea.emergency_stop || ea.flags.manual_acceptance === true) {
              throw Error('Expanded Autonomy MANUAL mode blocks enabling automatic Acceptance preference');
            }
          }
          this.pref = input.enabled === true;
          return { enabled: this.pref };
        }
      }
    },
    globalAutopilot: {
      on: false,
      enabled() { return this.on; },
      stop() { this.on = false; return { enabled: false }; }
    },
    emit() {}
  };
  bridge.expandedAutonomy = new ExpandedAutonomy(bridge);
  return { db, bridge, events, ea: bridge.expandedAutonomy };
}

test('defaults to MANUAL with high-impact domains off', (t) => {
  const {ea} = harness(t);
    const status = ea.status('operator');
    assert.equal(status.mode, 'manual');
    assert.equal(status.defaults_off, true);
    assert.equal(status.flags.manual_acceptance, true);
    assert.equal(status.flags.expanded_autonomy, false);
    assert.equal(status.domains.financial_automation.runnable, false);
    assert.equal(status.domains.production_automation.runnable, false);
    assert.equal(status.scopes.historical_missions, 'never_retroactive');
    assert.ok(MODES.includes('manual'));
    assert.equal(DEFAULT_FLAGS.financial_automation, false);
});

test('ROUTINE AUTO enables standing auto-accept for new work only', (t) => {
  const {ea, bridge} = harness(t);
    const before = Date.now() - 10_000;
    const status = ea.setMode({ mode: 'routine_auto', confirmed: true, request_id: randomUUID() }, 'operator');
    assert.equal(status.mode, 'routine_auto');
    assert.equal(bridge.missions.riskAcceptance.pref, true);
    assert.equal(status.scopes.routine_auto_accept, true);

    const historical = { id: randomUUID(), created_at: before, envelope: {} };
    assert.equal(ea.mayAutoAccept(historical).allow, false);
    assert.equal(ea.mayAutoAccept(historical).reason, 'historical_mission_not_retroactive');

    const fresh = { id: randomUUID(), created_at: Date.now(), envelope: {} };
    assert.equal(ea.mayAutoAccept(fresh).allow, true);

    const explicit = { id: randomUUID(), created_at: before, envelope: { automatic_acceptance: true } };
    assert.equal(ea.mayAutoAccept(explicit).allow, true);
});

test('MANUAL immediately blocks new automated decisions', (t) => {
  const {ea, bridge} = harness(t);
    ea.setMode({ mode: 'routine_auto', confirmed: true, request_id: randomUUID() }, 'operator');
    ea.setMode({ mode: 'manual', confirmed: true, request_id: randomUUID() }, 'operator');
    assert.equal(ea.status('operator').mode, 'manual');
    assert.equal(bridge.missions.riskAcceptance.pref, false);
    assert.equal(ea.mayAutoAccept({ id: randomUUID(), created_at: Date.now(), envelope: {} }).allow, false);
    assert.throws(
      () => bridge.missions.riskAcceptance.setPreference({ enabled: true, confirmed: true }),
      /MANUAL/
    );
});

test('emergency STOP returns to MANUAL, revokes domain policies, and stops Autopilot', (t) => {
  const {ea, bridge} = harness(t);
    ea.setMode({
      mode: 'expanded_auto',
      confirmed: true,
      request_id: randomUUID(),
      flags: { destructive_automation: true }
    }, 'operator');
    bridge.globalAutopilot.on = true;
    ea.enrollPolicy({
      domain: 'destructive_automation',
      confirmed: true,
      request_id: randomUUID(),
      qualified: true,
      policy: {
        allowed_paths: ['/private/tmp/expanded-autonomy-fixture/'],
        deletion_types: ['trash'],
        max_items: 3,
        expires_at: Date.now() + 86_400_000
      }
    }, 'operator');
    assert.equal(ea.listPolicies('destructive_automation').filter(p => p.active).length, 1);

    const stopped = ea.emergencyStop({ confirmed: true, request_id: randomUUID() }, 'operator');
    assert.equal(stopped.mode, 'manual');
    assert.equal(stopped.emergency_stop, true);
    assert.equal(bridge.globalAutopilot.on, false);
    assert.equal(ea.listPolicies('destructive_automation').filter(p => p.active).length, 0);
    assert.equal(ea.authorizeDomain('destructive_automation', {
      path: '/private/tmp/expanded-autonomy-fixture/a.txt',
      deletion_type: 'trash',
      item_count: 1
    }).allow, false);
});

test('credential standing policy binds purpose and never discloses values', (t) => {
  const {ea} = harness(t);
    ea.setMode({
      mode: 'expanded_auto',
      confirmed: true,
      request_id: randomUUID(),
      flags: { credential_automation: true }
    }, 'operator');
    ea.enrollPolicy({
      domain: 'credential_automation',
      confirmed: true,
      request_id: randomUUID(),
      qualified: true,
      policy: {
        credential_ref: 'vault:github-api',
        application: 'github',
        purpose: 'repository_operations',
        operations: ['git_push', 'pr_create'],
        expires_at: Date.now() + 86_400_000
      }
    }, 'operator');

    assert.equal(ea.authorizeDomain('credential_automation', {
      credential_ref: 'vault:github-api',
      application: 'github',
      purpose: 'repository_operations',
      operation: 'git_push'
    }).allow, true);

    assert.equal(ea.authorizeDomain('credential_automation', {
      credential_ref: 'vault:github-api',
      application: 'github',
      purpose: 'repository_operations',
      operation: 'git_push',
      disclose_values: true
    }).allow, false);

    assert.equal(ea.authorizeDomain('credential_automation', {
      credential_ref: 'vault:github-api',
      application: 'github',
      purpose: 'other',
      operation: 'git_push'
    }).allow, false);

    assert.throws(() => ea.enrollPolicy({
      domain: 'credential_automation',
      confirmed: true,
      request_id: randomUUID(),
      qualified: true,
      policy: {
        credential_ref: 'vault:x',
        application: 'x',
        purpose: 'x',
        operations: ['x'],
        disclose_values: true,
        expires_at: Date.now() + 1000
      }
    }, 'operator'), /disclosure/i);
});

test('financial and production stay non-runnable even when enrolled', (t) => {
  const {ea} = harness(t);
    ea.setMode({
      mode: 'expanded_auto',
      confirmed: true,
      request_id: randomUUID(),
      flags: { financial_automation: true, production_automation: true }
    }, 'operator');
    assert.throws(() => ea.enrollPolicy({
      domain: 'financial_automation',
      confirmed: true,
      request_id: randomUUID(),
      qualified: true,
      policy: {
        accounts: ['acct-1'],
        recipients: ['payee-1'],
        per_transaction_limit: 10,
        daily_limit: 20,
        monthly_limit: 50,
        currency: 'USD',
        expires_at: Date.now() + 86_400_000
      }
    }, 'operator'), /independent qualification/i);

    const financial = ea.enrollPolicy({
      domain: 'financial_automation',
      confirmed: true,
      request_id: randomUUID(),
      policy: {
        accounts: ['acct-1'],
        recipients: ['payee-1'],
        per_transaction_limit: 10,
        daily_limit: 20,
        monthly_limit: 50,
        currency: 'USD',
        expires_at: Date.now() + 86_400_000
      }
    }, 'operator');
    assert.equal(financial.qualified, false);
    assert.equal(ea.status('operator').domains.financial_automation.runnable, false);
    assert.equal(ea.authorizeDomain('financial_automation', {}).allow, false);
    assert.match(ea.authorizeDomain('financial_automation', {}).reason, /not_independently_qualified|no_qualified_standing_policy/);
});

test('destructive policy fails closed for safety records and unknown paths', (t) => {
  const {ea} = harness(t);
    ea.setMode({
      mode: 'expanded_auto',
      confirmed: true,
      request_id: randomUUID(),
      flags: { destructive_automation: true }
    }, 'operator');
    assert.throws(() => ea.enrollPolicy({
      domain: 'destructive_automation',
      confirmed: true,
      request_id: randomUUID(),
      qualified: true,
      policy: {
        allowed_paths: ['/tmp/audit/'],
        deletion_types: ['trash'],
        max_items: 1,
        expires_at: Date.now() + 86_400_000
      }
    }, 'operator'), /audit|safety/i);

    ea.enrollPolicy({
      domain: 'destructive_automation',
      confirmed: true,
      request_id: randomUUID(),
      qualified: true,
      policy: {
        allowed_paths: ['/private/tmp/expanded-clean/'],
        deletion_types: ['trash'],
        max_items: 2,
        expires_at: Date.now() + 86_400_000
      }
    }, 'operator');

    assert.equal(ea.authorizeDomain('destructive_automation', {
      path: '/private/tmp/expanded-clean/tmp.txt',
      deletion_type: 'trash',
      item_count: 1
    }).allow, true);
    assert.equal(ea.authorizeDomain('destructive_automation', {
      path: '/etc/passwd',
      deletion_type: 'trash',
      item_count: 1
    }).allow, false);
    assert.equal(ea.authorizeDomain('destructive_automation', {
      path: '/private/tmp/expanded-clean/../expanded-clean/../../etc/passwd',
      deletion_type: 'trash',
      item_count: 1
    }).allow, false);
    assert.equal(ea.authorizeDomain('destructive_automation', {
      path: '/private/tmp/expanded-clean/tmp.txt',
      deletion_type: 'trash'
    }).allow, false);
    assert.equal(ea.authorizeDomain('destructive_automation', {
      path: '/private/tmp/expanded-clean/audit.jsonl',
      deletion_type: 'trash',
      item_count: 1
    }).allow, false);
});

test('broad resource access rejects prefix-sibling collisions', (t) => {
  const { ea } = harness(t);
  ea.setMode({
    mode: 'expanded_auto',
    confirmed: true,
    request_id: randomUUID(),
    flags: { broad_resource_access: true }
  }, 'operator');
  ea.enrollPolicy({
    domain: 'broad_resource_access',
    confirmed: true,
    request_id: randomUUID(),
    qualified: true,
    policy: {
      resources: ['github.com/acme/repo'],
      expires_at: Date.now() + 86_400_000
    }
  }, 'operator');
  assert.equal(ea.authorizeDomain('broad_resource_access', { resource: 'github.com/acme/repo' }).allow, true);
  assert.equal(ea.authorizeDomain('broad_resource_access', { resource: 'github.com/acme/repo/src' }).allow, true);
  assert.equal(ea.authorizeDomain('broad_resource_access', { resource: 'github.com/acme/repo-evil' }).allow, false);
});

test('settings persist across controller reconstruction', (t) => {
  const {bridge} = harness(t);
    bridge.expandedAutonomy.setMode({ mode: 'expanded_auto', confirmed: true, request_id: randomUUID() }, 'operator');
    const again = new ExpandedAutonomy(bridge);
    assert.equal(again.status('operator').mode, 'expanded_auto');
    assert.equal(again.status('operator').configured_mode, 'expanded_auto');
});
