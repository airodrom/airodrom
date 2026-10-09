'use strict';
// ADR 0032 DeepSeek reserve: deterministic clocks, in-memory SQLite and fake HTTP only.
// No network, Keychain or live provider is touched.
const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const pricing = require('../src/deepseek-pricing');
const { DeepSeekReserve } = require('../src/deepseek-reserve');
const { ProviderGateway } = require('../src/provider-gateway');
const BASE = require('../config/deepseek-reserve-v1.json');

const KEY = 'sk-test-' + 'x'.repeat(32);
const at = iso => Date.parse(iso);
const OFF_PEAK = at('2026-10-09T15:40:00Z'), PEAK = at('2026-10-12T02:00:00Z');
const ok = (usage = { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150, prompt_cache_hit_tokens: 60, prompt_cache_miss_tokens: 40 }) =>
  new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'reserve answer' }, finish_reason: 'stop' }], usage }), { status: 200 });

function setup({ now = OFF_PEAK, fetch = async () => ok(), config = BASE, keyPresent = () => true, enabled = true } = {}) {
  const clock = { t: now }, calls = [];
  const request = async (url, options) => { calls.push({ url, body: options.body }); return fetch(url, options); };
  const reserve = new DeepSeekReserve({ db: new DatabaseSync(':memory:'), config, secretReader: () => KEY, keyPresent, request, now: () => clock.t });
  if (enabled) reserve.setEnabled(true);
  return { reserve, clock, calls };
}
const ask = (over = {}) => ({ task_id: 'task-a', model: 'deepseek-flash', reason: 'Second opinion on a public summary', data_class: 'public', scope: 'One public paragraph', messages: [{ role: 'user', content: 'Summarize: the sky is blue.' }], max_output: 512, ...over });
const approved = (reserve, over) => { const p = reserve.propose(ask(over)); reserve.approve(p.approval_id); return p; };
const code = c => e => e.code === c;
// Waits until aborted; holds the event loop because AbortSignal.timeout timers are unref'd.
const hang = (_, o) => new Promise((_, reject) => { const hold = setInterval(() => {}, 5); o.signal.addEventListener('abort', () => { clearInterval(hold); reject(o.signal.reason); }); });

test('1 off by default; 2 routing never selects DeepSeek, even enabled, keyed and healthy', () => {
  const { reserve } = setup({ enabled: false });
  assert.equal(reserve.view().status, 'OFF');
  assert.throws(() => reserve.propose(ask()), code('reserve_disabled'));
  const gateway = new ProviderGateway({ config: { deepseek: { enabled: true, secret_reference: 'keychain:airodrom.deepseek/api-key' } }, secretReader: () => KEY });
  gateway.registry.observe('deepseek', 'available');
  const plan = gateway.plan({ request_id: 'r1', run_id: 'run1', messages: [{ role: 'user', content: 'hi' }], data_class: 'public', privacy: 'project_policy', project_policy: { approved_external: { public: ['deepseek'] } }, failed_providers: ['ollama'] });
  assert.notEqual(plan.selected_provider, 'deepseek');
  assert.ok(plan.rejected.filter(r => r.provider === 'deepseek').every(r => r.reason === 'reserve_explicit_approval_only'));
});

test('3 single use; 28 one attempt, no retry, restart holds unknown usage', async () => {
  const { reserve, calls } = setup({ fetch: async () => new Response('', { status: 503 }) });
  const p = approved(reserve);
  const result = await reserve.dispatch(p.approval_id);
  assert.equal(calls.length, 1); assert.equal(result.billing, 'usage_unknown');
  await assert.rejects(reserve.dispatch(p.approval_id), code('approval_already_used')); assert.equal(calls.length, 1);
  const db = reserve.db, again = approved(reserve);
  db.prepare("UPDATE deepseek_reserve_approvals SET state='consumed' WHERE id=?").run(again.approval_id);
  db.prepare("INSERT INTO deepseek_reserve_spend VALUES(?,?,?,NULL,'reserved',NULL,?,NULL)").run(again.approval_id, pricing.month(OFF_PEAK), 777, OFF_PEAK);
  new DeepSeekReserve({ db, secretReader: () => KEY, keyPresent: () => true, now: () => OFF_PEAK, request: async () => ok() });
  assert.equal(db.prepare('SELECT state,actual_nano FROM deepseek_reserve_spend WHERE approval_id=?').get(again.approval_id).state, 'unreconciled');
});

test('4 expiry; 5 material change; 30 cross-task isolation', async () => {
  const { reserve, clock, calls } = setup();
  const late = reserve.propose(ask()); clock.t += BASE.approval_ttl_ms;
  assert.throws(() => reserve.approve(late.approval_id), code('approval_expired'));
  clock.t = OFF_PEAK;
  const changed = approved(reserve);
  await assert.rejects(reserve.dispatch(changed.approval_id, ask({ messages: [{ role: 'user', content: 'Something else' }] })), code('approval_scope_mismatch'));
  await assert.rejects(reserve.dispatch(changed.approval_id), code('approval_not_approved'));
  const other = approved(reserve);
  await assert.rejects(reserve.dispatch(other.approval_id, ask({ task_id: 'task-b' })), code('approval_scope_mismatch'));
  assert.equal(calls.length, 0);
});

test('6 personal memory, credentials, secrets and unauthorized sensitive scope are refused', () => {
  const { reserve } = setup();
  assert.throws(() => reserve.propose(ask({ personal_memory: true })), code('personal_memory_prohibited'));
  assert.throws(() => reserve.propose(ask({ memory_refs: ['m1'] })), code('personal_memory_prohibited'));
  assert.throws(() => reserve.propose(ask({ data_class: 'credentials' })), code('credentials_prohibited'));
  assert.throws(() => reserve.propose(ask({ messages: [{ role: 'user', content: 'key ' + KEY }] })), code('secrets_prohibited'));
  const p = reserve.propose(ask({ data_class: 'private' }));
  assert.throws(() => reserve.approve(p.approval_id), code('sensitive_scope_authorization_required'));
  assert.equal(reserve.approve(p.approval_id, { authorize_sensitive: true }).state, 'approved');
});

test('7 missing key; 8 auth failure; 11 quota exhaustion bill nothing', async () => {
  assert.throws(() => setup({ keyPresent: () => false }).reserve.propose(ask()), code('auth_required'));
  assert.equal((await setup({ keyPresent: () => false }).reserve.verify()).state, 'auth_required');
  for (const [status, error] of [[401, 'auth_required'], [402, 'quota_limited']]) {
    const { reserve } = setup({ fetch: async () => new Response('{}', { status }) });
    const result = await reserve.dispatch(approved(reserve).approval_id);
    assert.equal(result.error_class, error); assert.equal(result.cost_nano, 0); assert.equal(result.billing, 'provider_rejected');
  }
});

test('9 network failure and 10 timeout hold the full reservation as unreconciled', async () => {
  for (const fetch of [async () => { throw new TypeError('fetch failed'); }, hang]) {
    const { reserve } = setup({ fetch, config: { ...BASE, request_timeout_ms: 30 } });
    const p = approved(reserve), result = await reserve.dispatch(p.approval_id);
    assert.equal(result.error_class, 'temporary_failure'); assert.equal(result.billing, 'usage_unknown');
    assert.equal(reserve.spend().actual_nano, reserve.approval(p.approval_id).record.max_spend_nano);
  }
});

test('12 budget exhaustion and 13 concurrent reservations fail closed', async () => {
  const { reserve, calls } = setup();
  const one = approved(reserve), two = approved(reserve);
  reserve.setBudget((one.max_spend_usd.slice(1) * 1.5));
  let release; const { reserve: slow } = { reserve };
  slow.adapter = { execute: () => new Promise(r => { release = () => r({ status: 'completed', text: 'x', usage: { prompt_tokens: 1, completion_tokens: 1 } }); }) };
  const first = slow.dispatch(one.approval_id);
  await assert.rejects(slow.dispatch(two.approval_id), code('budget_exhausted'));
  assert.equal(slow.approval(two.approval_id).state, 'approved'); // not consumed by the refusal
  release(); await first; assert.equal(calls.length, 0);
});

test('14 metering, 15 cache-hit and 16 cache-miss pricing in exact nano-USD', async () => {
  const { reserve } = setup();
  const result = await reserve.dispatch(approved(reserve).approval_id);
  assert.deepEqual(result.usage, { input_cache_hit: 60, input_cache_miss: 40, output: 50 });
  assert.equal(result.cost_nano, 60 * 3 + 40 * 150 + 50 * 600); // off-peak flash
  assert.deepEqual(pricing.metered({ prompt_tokens: 100, completion_tokens: 5 }), { input_cache_hit: 0, input_cache_miss: 100, output: 5 });
});

test('17 peak and 18 off-peak official rates', () => {
  const peak = pricing.rates(BASE, 'deepseek-v4-pro', PEAK), off = pricing.rates(BASE, 'deepseek-v4-pro', OFF_PEAK);
  assert.deepEqual([peak.billed_as, peak.input_cache_hit, peak.input_cache_miss, peak.output], ['peak', 44, 1320, 3960]);
  assert.deepEqual([off.billed_as, off.input_cache_hit, off.input_cache_miss, off.output], ['off_peak', 22, 660, 1980]);
});

test('19 PDT, 20 PST, 21 DST transitions and 22 Sunday-evening UTC rollover', () => {
  assert.equal(pricing.vancouver(at('2026-10-12T01:00:00Z')), 'Sun, Oct 11, 6:00 PM PDT');
  assert.equal(pricing.vancouver(at('2026-11-02T01:00:00Z')), 'Sun, Nov 1, 5:00 PM PST');
  assert.equal(pricing.vancouver(at('2026-03-06T01:00:00Z')), 'Thu, Mar 5, 5:00 PM PST');
  assert.equal(pricing.vancouver(at('2026-03-10T01:00:00Z')), 'Mon, Mar 9, 6:00 PM PDT');
  assert.equal(pricing.classify(BASE, at('2026-10-12T01:00:00Z')).period, 'peak'); // Sunday 6 PM in Vancouver
  assert.equal(pricing.classify(BASE, at('2026-10-17T01:00:00Z')).period, 'off_peak'); // Friday 6 PM, Saturday UTC
  const midnight = pricing.timeline(BASE, at('2026-10-12T06:30:00Z')); // 06:00-10:00 UTC spans Vancouver midnight
  assert.equal(pricing.vancouver(midnight.current_peak_end_at), 'Mon, Oct 12, 3:00 AM PDT');
});

test('23 holidays are off-peak; 24 unknown calendars and make-up workdays are conservative peak', () => {
  assert.deepEqual(pricing.classify(BASE, at('2026-10-01T02:00:00Z')), { period: 'off_peak', uncertain: false, reason: 'chinese_public_holiday' });
  assert.deepEqual(pricing.classify(BASE, at('2027-03-01T02:00:00Z')), { period: 'peak', uncertain: true, reason: 'holiday_calendar_unverified' });
  assert.deepEqual(pricing.classify(BASE, at('2026-10-10T02:00:00Z')), { period: 'peak', uncertain: true, reason: 'makeup_workday_assumed_peak' });
});

test('25 pricing changes take effect at their boundary and stale pricing bills peak', () => {
  const next = structuredClone(BASE), doubled = structuredClone(BASE.pricing.schedules[0]);
  doubled.effective_from = '2026-10-20T00:00:00Z'; doubled.rates['deepseek-flash'].off_peak.output = 9.9;
  next.pricing.schedules.push(doubled);
  assert.equal(pricing.rates(next, 'deepseek-flash', at('2026-10-19T12:00:00Z')).output, 600);
  assert.equal(pricing.rates(next, 'deepseek-flash', at('2026-10-20T12:00:00Z')).output, 9900);
  assert.equal(pricing.nextChange(next, at('2026-10-19T23:00:00Z')), at('2026-10-20T00:00:00Z'));
  assert.equal(pricing.maxRates(next, 'deepseek-flash', at('2026-10-19T23:59:00Z'), at('2026-10-20T00:01:00Z')).output, 9900);
  const stale = pricing.rates(BASE, 'deepseek-flash', at('2026-12-31T12:00:00Z'));
  assert.deepEqual([stale.billed_as, stale.uncertain, stale.reason], ['peak', true, 'pricing_verification_stale']);
});

test('26 countdown boundaries roll to the next change exactly at the edge', () => {
  const change = pricing.timeline(BASE, OFF_PEAK).next_change_at;
  assert.equal(pricing.timeline(BASE, change - 1000).next_change_at - (change - 1000), 1000);
  const after = pricing.timeline(BASE, change);
  assert.ok(after.next_change_at > change); assert.notEqual(after.period, pricing.timeline(BASE, change - 1).period);
});

test('27 cancellation before dispatch is free; in-flight cancellation holds unknown usage', async () => {
  const { reserve, calls } = setup({ fetch: hang });
  const idle = approved(reserve); reserve.cancel(idle.approval_id);
  await assert.rejects(reserve.dispatch(idle.approval_id), code('approval_not_approved'));
  const busy = approved(reserve), running = reserve.dispatch(busy.approval_id);
  await new Promise(r => setImmediate(r)); assert.equal(reserve.view().status, 'ACTIVE');
  reserve.cancel(busy.approval_id);
  const result = await running;
  assert.equal(result.error_class, 'cancelled'); assert.equal(result.billing, 'usage_unknown'); assert.equal(calls.length, 1);
});

test('29 audit evidence records every transition without content or credential', async () => {
  const { reserve } = setup();
  await reserve.dispatch(approved(reserve).approval_id);
  const events = reserve.db.prepare('SELECT kind,record FROM deepseek_reserve_events').all();
  assert.deepEqual(events.map(e => e.kind), ['enabled', 'proposed', 'approved', 'dispatched', 'settled']);
  const text = JSON.stringify(events) + JSON.stringify(reserve.view());
  assert.doesNotMatch(text, /sky is blue|sk-test/); assert.ok(events.every(e => JSON.parse(e.record).execution_authority === false));
});
