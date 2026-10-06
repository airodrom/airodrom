'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { AutonomyPolicy } = require('./autonomy-policy');

const DEFAULT_POLICY_PATH = path.join(__dirname, '../config/capability-policy-v2.json');
const DECISION_RANK = Object.freeze({ auto_allow: 0, approval_required: 1, deny: 2 });
const NAME = /^[a-z][a-z0-9_]{1,63}$/;

function freezeDeep(value) {
  if (!value || typeof value !== 'object') return value;
  for (const child of Object.values(value)) freezeDeep(child);
  return Object.freeze(value);
}

// Load-time invariants make the matrix structurally safe: every capability has an
// explicit class, decision and scope, and protected classes can never be automatic.
function loadCapabilityPolicy(filePath = DEFAULT_POLICY_PATH) {
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (!raw || typeof raw.policyVersion !== 'string' || !raw.capabilities || !Array.isArray(raw.riskClasses) || !Array.isArray(raw.taskScopes)) throw new Error('Capability policy document is invalid');
  const classes = new Set(raw.riskClasses), scopes = new Set(raw.taskScopes), protectedClasses = new Set(raw.neverAutomaticClasses || []);
  for (const scope of raw.defaultTaskScopes || []) if (!scopes.has(scope)) throw new Error(`Unknown default task scope: ${scope}`);
  for (const [name, entry] of Object.entries(raw.capabilities)) {
    if (!NAME.test(name) || !entry || typeof entry !== 'object') throw new Error(`Capability policy entry is invalid: ${name}`);
    if (!classes.has(entry.riskClass)) throw new Error(`Capability ${name} has no explicit risk class`);
    if (!Object.hasOwn(DECISION_RANK, entry.decision)) throw new Error(`Capability ${name} has no explicit decision`);
    if (!Array.isArray(entry.taskScopes) || !entry.taskScopes.length || entry.taskScopes.some(scope => scope !== '*' && !scopes.has(scope))) throw new Error(`Capability ${name} has invalid task scopes`);
    if (protectedClasses.has(entry.riskClass) && entry.decision === 'auto_allow') throw new Error(`Capability ${name} is ${entry.riskClass} and cannot be automatic`);
    if (entry.alwaysDeny && (!raw.alwaysDeny?.[entry.alwaysDeny] || entry.decision !== 'deny')) throw new Error(`Capability ${name} always-deny mapping is invalid`);
    if (entry.humanGate && !raw.humanGates?.[entry.humanGate]) throw new Error(`Capability ${name} names an unknown human gate`);
  }
  for (const [name, riskClass] of Object.entries(raw.legacyTools || {})) if (!classes.has(riskClass)) throw new Error(`Legacy tool ${name} has no explicit risk class`);
  return freezeDeep({ ...raw, sourcePath: path.resolve(filePath) });
}

function mostRestrictive(current, candidate) {
  if (!candidate) return current;
  if (DECISION_RANK[candidate.decision] > DECISION_RANK[current.decision]) return { ...current, ...candidate };
  return current;
}

class CapabilityPolicy {
  constructor({ filePath = DEFAULT_POLICY_PATH, document = null, autonomyPolicy = null } = {}) {
    this.document = document || loadCapabilityPolicy(filePath);
    this.autonomyPolicy = autonomyPolicy instanceof AutonomyPolicy ? autonomyPolicy : new AutonomyPolicy();
  }

  get policyVersion() { return this.document.policyVersion; }
  get taskScopes() { return [...this.document.taskScopes]; }
  get defaultTaskScopes() { return [...(this.document.defaultTaskScopes || [])]; }
  get bulkRecipientThreshold() { return this.document.bulkRecipientThreshold || 5; }
  entry(name) { return typeof name === 'string' && Object.hasOwn(this.document.capabilities, name) ? this.document.capabilities[name] : null; }
  names() { return Object.keys(this.document.capabilities); }
  legacyRiskClass(toolName) { return this.document.legacyTools?.[toolName] || null; }
  humanGate(gate) { return gate ? { gate, action: this.document.humanGates[gate] } : null; }

  normalizeTaskScopes(value) {
    if (value === undefined || value === null) return this.defaultTaskScopes;
    const list = typeof value === 'string' ? value.split(',').map(item => item.trim()).filter(Boolean) : value;
    if (!Array.isArray(list) || list.length > this.document.taskScopes.length) throw new Error('Invalid capability scopes');
    const known = new Set(this.document.taskScopes);
    for (const scope of list) if (!known.has(scope)) throw new Error(`Unknown capability scope: ${scope}`);
    return [...new Set(list)];
  }

  /**
   * Standing decision for one capability. `dynamic` holds host-derived facts from
   * the adapter's assessment; it may only escalate (never relax) the decision.
   */
  decide(name, { taskScopes = null, dynamic = null, scope = null } = {}) {
    const base = { policy_version: this.policyVersion, base_policy_version: this.document.basePolicyVersion, capability: name, precedence: this.document.precedence.rule };
    const entry = this.entry(name);
    if (!entry) return { ...base, found: false, decision: 'deny', risk_class: 'UNKNOWN', reason: 'Unknown capability; fail closed', automatic: false, active: false, kind: 'capability_unknown' };
    let result = { decision: entry.decision, risk_class: entry.riskClass, reason: entry.reason || entry.decision };
    if (entry.alwaysDeny) result = { decision: 'deny', risk_class: entry.riskClass, reason: this.document.alwaysDeny[entry.alwaysDeny], always_deny: entry.alwaysDeny, kind: 'safety_denial' };
    for (const category of [entry.v1Category, dynamic?.v1Category].filter(Boolean)) {
      const v1 = this.autonomyPolicy.decide(category);
      if (v1.found) result = mostRestrictive(result, { decision: v1.decision, reason: `${v1.policyVersion}:${category}: ${v1.reason}`, v1_category: category });
    }
    if (dynamic?.decision) {
      if (!Object.hasOwn(DECISION_RANK, dynamic.decision)) result = mostRestrictive(result, { decision: 'deny', reason: 'Invalid dynamic assessment; fail closed' });
      else result = mostRestrictive(result, { decision: dynamic.decision, reason: dynamic.reason || result.reason, ...(dynamic.riskClass ? { risk_class: dynamic.riskClass } : {}), ...(dynamic.kind ? { kind: dynamic.kind } : {}) });
    }
    const active = entry.active !== false;
    const granted = Array.isArray(taskScopes) ? entry.taskScopes.includes('*') || entry.taskScopes.some(item => taskScopes.includes(item)) : true;
    const standingDecision = result.decision;
    if (!active && result.decision !== 'deny') result = { ...result, decision: 'deny', kind: 'capability_unavailable', reason: entry.connector ? `Connector ${entry.connector} is not connected; standing decision would be ${standingDecision}` : `No local adapter is active for ${name}; standing decision would be ${standingDecision}` };
    if (!granted && result.decision !== 'deny') result = { ...result, decision: 'deny', kind: 'capability_scope_denied', reason: `Task capability scopes do not include any of: ${entry.taskScopes.join(', ')}` };
    return {
      ...base, found: true, group: entry.group, action: name, scope, task_scopes: entry.taskScopes,
      standing_decision: standingDecision, active, human_gate: this.humanGate(entry.humanGate), ...result,
      automatic: result.decision === 'auto_allow'
    };
  }

  auditMetadata(decision) {
    return {
      policy_version: decision.policy_version, policy_decision: decision.decision, policy_automatic: decision.automatic === true,
      policy_scope: decision.scope || null, policy_action: decision.action || decision.capability || null,
      policy_risk_class: decision.risk_class || null, policy_precedence: decision.precedence || null
    };
  }

  matrix() {
    const rows = {};
    for (const name of this.names()) {
      const decided = this.decide(name);
      rows[name] = { group: decided.group, risk_class: decided.risk_class, standing_decision: decided.standing_decision, effective_decision: decided.decision, active: decided.active, task_scopes: decided.task_scopes, human_gate: decided.human_gate?.gate || null };
    }
    return rows;
  }
}

module.exports = { CapabilityPolicy, loadCapabilityPolicy, mostRestrictive, DECISION_RANK };
