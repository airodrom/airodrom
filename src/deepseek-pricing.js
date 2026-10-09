'use strict';
// DeepSeek peak/off-peak pricing (ADR 0032). Pure functions over a verified schedule.
// Amounts are integer nano-USD: a rate of $X per 1M tokens is X*1000 nano-USD per token.
// Unverifiable holidays or stale pricing fall back to peak rates and say so.
const DAY = 86400000;
const ZONE = 'America/Vancouver';
const nano = usd => Math.round(Number(usd) * 1000);

function toMinutes(hhmm) { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; }
// The China calendar date of an instant; holiday lists are in China local dates.
function chinaDate(t) { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(t); }

function schedule(config, t) {
  const found = config.pricing.schedules.filter(s => Date.parse(s.effective_from) <= t).sort((a, b) => Date.parse(b.effective_from) - Date.parse(a.effective_from))[0];
  if (!found) throw Error('No DeepSeek pricing schedule covers this time');
  return found;
}

function pricingStale(config, now) {
  return now - Date.parse(config.pricing.verified_at + 'T00:00:00Z') > config.pricing.max_age_days * DAY;
}

// Peak/off-peak for an instant. `uncertain` marks a conservative peak assumption.
function classify(config, t) {
  const s = schedule(config, t), d = new Date(t), minute = d.getUTCHours() * 60 + d.getUTCMinutes();
  const inWindow = s.peak_windows_utc.some(([a, b]) => minute >= toMinutes(a) && minute < toMinutes(b));
  if (!inWindow) return { period: 'off_peak', uncertain: false, reason: 'outside_peak_hours' };
  const date = chinaDate(t), year = Number(date.slice(0, 4)), verified = config.holidays.verified_years.includes(year);
  if (!s.peak_weekdays_utc.includes(d.getUTCDay())) {
    // DeepSeek names Monday-Friday; a Chinese make-up workday on a weekend is ambiguous.
    if (config.holidays.makeup_workdays.includes(date)) return { period: 'peak', uncertain: true, reason: 'makeup_workday_assumed_peak' };
    return { period: 'off_peak', uncertain: false, reason: 'weekend' };
  }
  if (!verified) return { period: 'peak', uncertain: true, reason: 'holiday_calendar_unverified' };
  if (config.holidays.dates.includes(date)) return { period: 'off_peak', uncertain: false, reason: 'chinese_public_holiday' };
  return { period: 'peak', uncertain: false, reason: 'peak_hours' };
}

// Rates in nano-USD per token. Stale pricing always uses peak rates.
function rates(config, model, t, now = t) {
  const table = schedule(config, t).rates[model];
  if (!table) throw Error('Unknown DeepSeek model');
  const c = classify(config, t), stale = pricingStale(config, now), period = stale ? 'peak' : c.period, r = table[period];
  return { model, period: c.period, billed_as: period, uncertain: c.uncertain || stale, reason: stale ? 'pricing_verification_stale' : c.reason,
    input_cache_hit: nano(r.input_cache_hit), input_cache_miss: nano(r.input_cache_miss), output: nano(r.output) };
}

// Next instant after t where the price changes: a peak window edge or a new schedule.
function nextChange(config, t, horizonDays = 21) {
  // Every rate of every model: an output-only or Pro-only change still counts.
  const signature = c => JSON.stringify(config.models.map(m => { const r = rates(config, m, c, t); return [r.billed_as, r.input_cache_hit, r.input_cache_miss, r.output]; }));
  const current = signature(t), start = Date.UTC(new Date(t).getUTCFullYear(), new Date(t).getUTCMonth(), new Date(t).getUTCDate());
  const edges = [...new Set(schedule(config, t).peak_windows_utc.flat().map(toMinutes))].sort((a, b) => a - b);
  const candidates = config.pricing.schedules.map(s => Date.parse(s.effective_from)).filter(x => x > t);
  for (let day = 0; day <= horizonDays; day++) for (const minute of edges) candidates.push(start + day * DAY + minute * 60000);
  for (const c of candidates.filter(x => x > t).sort((a, b) => a - b)) {
    if (signature(c) !== current) return c;
  }
  return null;
}

// Current state plus the next peak window, all instants as epoch ms.
function timeline(config, now) {
  const current = classify(config, now), change = nextChange(config, now);
  // No confirmable change (stale pricing or unverified calendar): everything stays peak.
  let peakStart = current.period === 'peak' ? null : change;
  if (current.period === 'peak' && change) peakStart = nextChange(config, change);
  while (peakStart && classify(config, peakStart).period !== 'peak') peakStart = nextChange(config, peakStart);
  const peakEnd = peakStart ? nextChange(config, peakStart) : null;
  return { period: current.period, uncertain: current.uncertain, reason: current.reason, next_change_at: change,
    current_peak_end_at: current.period === 'peak' ? change : null, next_peak_start_at: peakStart, next_peak_end_at: peakEnd };
}

// Component-wise maximum rates over [from, to], covering requests that cross a boundary.
function maxRates(config, model, from, to, now = from) {
  const points = [from];
  for (let c = nextChange(config, from); c && c <= to; c = nextChange(config, c)) points.push(c);
  const all = points.map(p => rates(config, model, p, now)), max = key => Math.max(...all.map(r => r[key]));
  return { ...all[0], billed_as: all.some(r => r.billed_as === 'peak') ? 'peak' : all[0].billed_as, uncertain: all.some(r => r.uncertain),
    input_cache_hit: max('input_cache_hit'), input_cache_miss: max('input_cache_miss'), output: max('output'), crosses_boundary: points.length > 1 };
}

function cost(usage, r) {
  const hit = usage.input_cache_hit || 0, miss = usage.input_cache_miss || 0, out = usage.output || 0;
  return hit * r.input_cache_hit + miss * r.input_cache_miss + out * r.output;
}

// Provider usage to billable tokens. Missing cache detail is billed as cache-miss.
function metered(usage) {
  if (!usage || !Number.isSafeInteger(usage.prompt_tokens) || !Number.isSafeInteger(usage.completion_tokens)) return null;
  const hit = Number.isSafeInteger(usage.prompt_cache_hit_tokens) ? usage.prompt_cache_hit_tokens : 0;
  const miss = Number.isSafeInteger(usage.prompt_cache_miss_tokens) ? usage.prompt_cache_miss_tokens : usage.prompt_tokens - hit;
  if (hit < 0 || miss < 0 || hit + miss !== usage.prompt_tokens) return { input_cache_hit: 0, input_cache_miss: usage.prompt_tokens, output: usage.completion_tokens };
  return { input_cache_hit: hit, input_cache_miss: miss, output: usage.completion_tokens };
}

// UTF-8 bytes bound tokens from above for text, plus per-message framing.
function inputTokenBound(messages) { return messages.reduce((n, m) => n + Buffer.byteLength(String(m.content ?? '')) + 16, 0); }

function vancouver(t) {
  return t == null ? null : new Intl.DateTimeFormat('en-US', { timeZone: ZONE, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(t);
}
// Vancouver calendar month, the budget period shown to the operator.
function month(t) { return new Intl.DateTimeFormat('en-CA', { timeZone: ZONE, year: 'numeric', month: '2-digit' }).format(t); }
const usd = n => '$' + (n / 1e9).toFixed(n !== 0 && Math.abs(n) < 1e7 ? 6 : 4);

module.exports = { ZONE, nano, chinaDate, schedule, pricingStale, classify, rates, nextChange, timeline, maxRates, cost, metered, inputTokenBound, vancouver, month, usd };
