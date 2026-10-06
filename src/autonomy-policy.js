'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_POLICY_PATH = path.join(__dirname, '../config/trusted-routine-actions-v1.json');
const DECISIONS = new Set(['auto_allow', 'approval_required', 'deny']);

function freezeDeep(value) {
  if (!value || typeof value !== 'object') return value;
  for (const child of Object.values(value)) freezeDeep(child);
  return Object.freeze(value);
}

function loadAutonomyPolicy(filePath = DEFAULT_POLICY_PATH) {
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (!raw || typeof raw !== 'object' || typeof raw.policyVersion !== 'string' || !raw.capabilities || typeof raw.capabilities !== 'object') {
    throw new Error('Autonomy policy document is invalid');
  }
  for (const [name, entry] of Object.entries(raw.capabilities)) {
    if (!entry || typeof entry !== 'object' || !DECISIONS.has(entry.decision)) {
      throw new Error(`Autonomy policy entry is invalid: ${name}`);
    }
  }
  return freezeDeep({
    policyVersion: raw.policyVersion,
    description: raw.description || '',
    precedence: raw.precedence || { rule: 'final_clause_overrides' },
    capabilities: raw.capabilities,
    sourcePath: path.resolve(filePath)
  });
}

class AutonomyPolicy {
  constructor({ filePath = DEFAULT_POLICY_PATH, document = null } = {}) {
    this.document = document || loadAutonomyPolicy(filePath);
  }

  get policyVersion() {
    return this.document.policyVersion;
  }

  get precedenceRule() {
    return this.document.precedence?.rule || 'final_clause_overrides';
  }

  entry(capability) {
    if (typeof capability !== 'string' || !capability) return null;
    return this.document.capabilities[capability] || null;
  }

  /**
   * Resolve a standing policy decision for a capability/action.
   * Unknown live broker tools remain fail-closed (caller decides default).
   * Inactive connector categories return active:false and must not execute.
   */
  decide(capability, { action = null, scope = null } = {}) {
    const entry = this.entry(capability);
    if (!entry) {
      return {
        found: false,
        decision: 'deny',
        reason: 'Unknown capability under autonomy policy; fail closed',
        policyVersion: this.policyVersion,
        automatic: false,
        active: false,
        capability,
        action: action || null,
        scope: scope || null,
        riskClass: 'unknown',
        precedenceRule: this.precedenceRule
      };
    }
    const active = entry.active !== false;
    return {
      found: true,
      decision: entry.decision,
      reason: entry.reason || entry.decision,
      policyVersion: this.policyVersion,
      automatic: entry.decision === 'auto_allow' && active,
      active,
      capability,
      action: action || entry.action || null,
      scope: scope || entry.scope || null,
      riskClass: entry.riskClass || null,
      precedenceRule: this.precedenceRule
    };
  }

  /**
   * Final-clause proof helpers used by tests and audits.
   * These names are policy-level categories, not necessarily live broker tools.
   */
  protectedOverrides() {
    const names = [
      'pr_merge', 'production_deploy', 'destructive_operation',
      'system_software_install', 'system_software_uninstall', 'sudo',
      'credential_mutation', 'financial_transaction', 'messaging_bulk_broadcast',
      'delete_unique_work', 'destructive_git_unique', 'destructive_disk',
      'git_push_protected'
    ];
    return Object.fromEntries(names.map(name => [name, this.decide(name)]));
  }

  auditMetadata(decision) {
    return {
      policy_version: decision.policyVersion,
      policy_decision: decision.decision,
      policy_automatic: decision.automatic === true,
      policy_scope: decision.scope || null,
      policy_action: decision.action || null,
      policy_risk_class: decision.riskClass || null,
      policy_precedence: decision.precedenceRule || null
    };
  }
}

module.exports = {
  AutonomyPolicy,
  loadAutonomyPolicy,
  DEFAULT_POLICY_PATH,
  DECISIONS
};
