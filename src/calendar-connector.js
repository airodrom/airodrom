'use strict';
// Host Google Calendar API adapter. Event bodies are untrusted data, never actions.
const { text, object } = require('./control-plane-store');
const { secret } = require('./assistant-intent');
const { READ_SCOPE, WRITE_SCOPE, hasWriteScope } = require('./calendar-oauth');

const ID = /^[A-Za-z0-9_.:@-]{1,1024}$/;
const clean = (value) => {
  const raw = String(value || '');
  if (secret(raw)) return '[Sensitive content withheld]';
  return require('./secret-observation').redactText(require('node:util').stripVTControlCharacters(raw).slice(0, 4000));
};

function isoOrThrow(value, name) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})?)?$/.test(value)) {
    throw Error(`Valid ${name} required`);
  }
  return value;
}

function assertRange(start, end) {
  const a = start.includes('T') ? Date.parse(start) : Date.parse(start + 'T00:00:00Z');
  const b = end.includes('T') ? Date.parse(end) : Date.parse(end + 'T00:00:00Z');
  if (!Number.isFinite(a) || !Number.isFinite(b) || a >= b) {
    const err = Error('Event end must be strictly after start.');
    err.code = 'calendar_invalid_range';
    err.safe_error_class = 'calendar_invalid_range';
    throw err;
  }
}

class CalendarConnector {
  #oauth; #request; #live = false; #connectedProbe = null;
  constructor({ oauth = null, request = fetch, connected = null } = {}) {
    this.#oauth = oauth;
    this.#request = request;
    this.#connectedProbe = connected;
  }

  status() {
    const oauthClient = !!this.#oauth;
    const st = this.#oauth?.status?.() || {};
    const connected = oauthClient && (typeof this.#connectedProbe === 'function' ? !!this.#connectedProbe() : !!st.connected);
    let state = 'unavailable';
    if (oauthClient && this.#live && connected) state = 'live_qualified';
    else if (oauthClient && connected) state = 'connected';
    else if (oauthClient) state = 'configured';
    return {
      id: 'calendar',
      protocol: 'Google Calendar API / OAuth 2.0',
      state,
      configured: oauthClient,
      connected: !!connected,
      token_present: !!st.token_present,
      read_only: st.read_only !== false && !st.can_write,
      can_write: !!st.can_write,
      live_qualified: this.#live && connected,
      setup: connected
        ? (this.#live
          ? (st.can_write
            ? 'Calendar is live-qualified for bounded read and governed writes in this process.'
            : 'Calendar is live-qualified for bounded reads. Event create/update/delete needs /connect calendar manage.')
          : 'OAuth credentials appear usable. Run a bounded calendar list/events read to live-qualify. Presence alone is not live access.')
        : (oauthClient
          ? 'OAuth client is configured. Account consent still required via /connect calendar. Gmail consent does not grant Calendar.'
          : 'Requires owner Google desktop OAuth client (same Desktop client as Gmail setup) then /connect calendar.'),
      mutations: st.can_write
        ? 'Create/update require host preview confirmation. Delete/cancel requires explicit destructive approval. Bulk invites escalate.'
        : 'Remote create/update/delete unavailable until /connect calendar manage (calendar.events). Read-only calendar.readonly is separate from Gmail.',
      scope: st.scope || READ_SCOPE,
      authority: false,
    };
  }

  markLive() { this.#live = true; return this; }
  clearLive() { this.#live = false; return this; }

  async #token() {
    if (!this.#oauth) throw Error('Calendar OAuth connector is not configured.');
    return this.#oauth.resolve();
  }

  async #api(method, path, { query = {}, body = null, write = false } = {}) {
    if (write && !this.#oauth.canWrite()) {
      const err = Error('Calendar write requires /connect calendar manage (calendar.events). Read-only Calendar consent is not enough.');
      err.code = 'calendar_write_scope_required';
      err.safe_error_class = 'calendar_write_scope_required';
      throw err;
    }
    const token = await this.#token();
    const url = new URL('https://www.googleapis.com/calendar/v3/' + path.replace(/^\//, ''));
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null || v === '') continue;
      url.searchParams.set(k, String(v));
    }
    try {
      const response = await this.#request(url, {
        method,
        headers: {
          Authorization: 'Bearer ' + token,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        redirect: 'error',
        signal: AbortSignal.timeout(15000),
      });
      if (response.status === 204) return null;
      const raw = await response.text();
      if (Buffer.byteLength(raw) > 512000) throw Error();
      if (!response.ok) {
        const err = Error('Calendar API unavailable; credentials and provider diagnostics withheld.');
        err.code = 'calendar_api_rejected';
        err.safe_error_class = 'calendar_api_rejected';
        err.http_status = response.status;
        throw err;
      }
      return raw ? JSON.parse(raw) : null;
    } catch (error) {
      if (error?.safe_error_class || error?.code?.startsWith?.('calendar_oauth_') || error?.code === 'calendar_write_scope_required') throw error;
      throw Error('Calendar request unavailable; credentials and provider diagnostics withheld.');
    }
  }

  #event(row, queriedCalendarId = 'primary') {
    if (!row || !ID.test(row.id || '')) throw Error('Invalid Calendar event reference');
    const start = row.start?.dateTime || row.start?.date || null;
    const end = row.end?.dateTime || row.end?.date || null;
    const all_day = !!(row.start?.date && !row.start?.dateTime);
    // Authoritative target calendar is the one we queried — never the organizer email.
    const calendar_id = (queriedCalendarId && (ID.test(queriedCalendarId) || queriedCalendarId === 'primary'))
      ? queriedCalendarId
      : (row.calendarId && ID.test(row.calendarId) ? row.calendarId : 'primary');
    return {
      id: row.id,
      calendar_id,
      organizer_email: row.organizer?.email && ID.test(row.organizer.email) ? clean(row.organizer.email) : null,
      summary: clean(row.summary),
      description: clean(String(row.description || '').slice(0, 500)),
      location: clean(row.location),
      start,
      end,
      all_day,
      time_zone: clean(row.start?.timeZone || row.end?.timeZone || null),
      status: clean(row.status),
      html_link: typeof row.htmlLink === 'string' && /^https:\/\//i.test(row.htmlLink) ? row.htmlLink : null,
      attendees: Array.isArray(row.attendees)
        ? row.attendees.slice(0, 20).map((a) => ({ email: clean(a.email), response: clean(a.responseStatus), optional: !!a.optional }))
        : [],
      recurring_event_id: row.recurringEventId && ID.test(row.recurringEventId) ? row.recurringEventId : null,
      untrusted: true,
      authority: false,
    };
  }

  async listCalendars({ limit = 20 } = {}) {
    const max = Math.min(Math.max(limit, 1), 50);
    const data = await this.#api('GET', 'users/me/calendarList', { query: { maxResults: max } });
    this.#live = true;
    const items = (data?.items || []).slice(0, max).map((c) => ({
      id: ID.test(c.id || '') ? c.id : null,
      summary: clean(c.summary),
      primary: !!c.primary,
      access_role: clean(c.accessRole),
      time_zone: clean(c.timeZone),
      untrusted: true,
      authority: false,
    })).filter((c) => c.id);
    return {
      items,
      next_page_token: typeof data?.nextPageToken === 'string' ? data.nextPageToken : null,
      has_more: !!data?.nextPageToken,
      host_verified: true,
      live_qualified: true,
      untrusted: true,
      authority: false,
    };
  }

  async listEvents({
    calendarId = 'primary',
    timeMin = null,
    timeMax = null,
    query = null,
    limit = 10,
    pageToken = null,
    singleEvents = true,
  } = {}) {
    if (!ID.test(calendarId) && calendarId !== 'primary') throw Error('Bounded calendar id required');
    const max = Math.min(Math.max(limit, 1), 20);
    if (query !== null && query !== undefined) {
      text(query, 'query', 500);
      if (secret(query)) throw Error('Secret query refused.');
    }
    const data = await this.#api('GET', `calendars/${encodeURIComponent(calendarId)}/events`, {
      query: {
        maxResults: max,
        singleEvents: singleEvents ? 'true' : 'false',
        orderBy: singleEvents ? 'startTime' : undefined,
        timeMin: timeMin || undefined,
        timeMax: timeMax || undefined,
        q: query || undefined,
        pageToken: pageToken || undefined,
      },
    });
    this.#live = true;
    const items = (data?.items || []).slice(0, max).map((e) => this.#event(e, calendarId));
    return {
      items,
      calendar_id: calendarId,
      next_page_token: typeof data?.nextPageToken === 'string' ? data.nextPageToken : null,
      has_more: !!data?.nextPageToken,
      provider_exhausted: !data?.nextPageToken,
      host_verified: true,
      live_qualified: true,
      untrusted: true,
      authority: false,
      // Internal only — callers must not project onto operator receipts.
      _provider_next_page_token: typeof data?.nextPageToken === 'string' ? data.nextPageToken : null,
    };
  }

  async getEvent({ calendarId = 'primary', eventId }) {
    if (!ID.test(eventId || '')) throw Error('Explicit event ID required');
    if (!ID.test(calendarId) && calendarId !== 'primary') throw Error('Bounded calendar id required');
    const data = await this.#api('GET', `calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`);
    this.#live = true;
    return { item: this.#event(data, calendarId), host_verified: true, live_qualified: true, untrusted: true, authority: false };
  }

  async freeBusy({ timeMin, timeMax, calendars = ['primary'] } = {}) {
    isoOrThrow(timeMin, 'timeMin');
    isoOrThrow(timeMax, 'timeMax');
    if (new Date(timeMin).getTime() >= new Date(timeMax).getTime()) {
      const err = Error('freeBusy requires timeMin strictly before timeMax.');
      err.code = 'calendar_freebusy_invalid_range';
      err.safe_error_class = 'calendar_freebusy_invalid_range';
      throw err;
    }
    if (!Array.isArray(calendars) || !calendars.length || calendars.length > 10) throw Error('Bounded calendar list required');
    for (const id of calendars) {
      if (!ID.test(id) && id !== 'primary') throw Error('Bounded calendar id required');
    }
    const data = await this.#api('POST', 'freeBusy', {
      body: {
        timeMin,
        timeMax,
        items: calendars.map((id) => ({ id })),
      },
    });
    this.#live = true;
    const calendarsOut = {};
    for (const [id, row] of Object.entries(data?.calendars || {})) {
      calendarsOut[id] = {
        busy: Array.isArray(row.busy)
          ? row.busy.slice(0, 100).map((b) => ({ start: b.start, end: b.end }))
          : [],
        errors: Array.isArray(row.errors) ? row.errors.slice(0, 5).map((e) => clean(e.reason || e.domain)) : [],
      };
    }
    const missing = calendars.filter((id) => !calendarsOut[id]);
    const errored = calendars.filter((id) => (calendarsOut[id]?.errors || []).length > 0);
    const incomplete = missing.length > 0 || errored.length > 0;
    return {
      time_min: timeMin,
      time_max: timeMax,
      calendars: calendarsOut,
      requested_calendars: calendars.slice(),
      missing_calendars: missing,
      errored_calendars: errored,
      complete: !incomplete,
      host_verified: true,
      live_qualified: !incomplete,
      untrusted: true,
      authority: false,
    };
  }

  async createEvent({ calendarId = 'primary', summary, start, end, description = null, location = null, attendees = [], hostDedupeKey = null, timeZone = null }) {
    text(summary, 'summary', 500);
    if (secret(summary)) throw Error('Secret-like event title refused.');
    isoOrThrow(start, 'start');
    isoOrThrow(end, 'end');
    assertRange(start, end);
    if (description) { text(description, 'description', 8000); if (secret(description)) throw Error('Secret-like description refused.'); }
    if (location) { text(location, 'location', 500); }
    if (!Array.isArray(attendees) || attendees.length > 20) throw Error('Bounded attendees required');
    const startBody = start.includes('T')
      ? { dateTime: start, ...(timeZone ? { timeZone } : {}) }
      : { date: start };
    const endBody = end.includes('T')
      ? { dateTime: end, ...(timeZone ? { timeZone } : {}) }
      : { date: end };
    const body = {
      summary: clean(summary),
      start: startBody,
      end: endBody,
      ...(description ? { description: clean(description) } : {}),
      ...(location ? { location: clean(location) } : {}),
      ...(attendees.length ? { attendees: attendees.map((email) => ({ email: String(email).toLowerCase() })) } : {}),
    };
    // Google Calendar has no standard create idempotency header. Host-local dedupe
    // (hostDedupeKey) must never be reported as provider-side idempotency.
    const data = await this.#api('POST', `calendars/${encodeURIComponent(calendarId)}/events`, {
      write: true,
      body,
    });
    this.#live = true;
    return {
      item: this.#event(data, calendarId),
      created: true,
      host_verified: true,
      live_qualified: true,
      untrusted: true,
      authority: false,
      host_dedupe_key: hostDedupeKey || null,
      google_idempotent: false,
    };
  }

  async updateEvent({ calendarId = 'primary', eventId, patch = {}, sendUpdates = 'none' }) {
    if (!ID.test(eventId || '')) throw Error('Explicit event ID required');
    object(patch, ['summary', 'start', 'end', 'description', 'location', 'attendees']);
    const body = {};
    if (patch.summary !== undefined) {
      text(patch.summary, 'summary', 500);
      if (secret(patch.summary)) throw Error('Secret-like event title refused.');
      body.summary = clean(patch.summary);
    }
    if (patch.start !== undefined) {
      isoOrThrow(patch.start, 'start');
      body.start = patch.start.includes('T') ? { dateTime: patch.start } : { date: patch.start };
    }
    if (patch.end !== undefined) {
      isoOrThrow(patch.end, 'end');
      body.end = patch.end.includes('T') ? { dateTime: patch.end } : { date: patch.end };
    }
    if (patch.description !== undefined) {
      text(patch.description, 'description', 8000);
      body.description = clean(patch.description);
    }
    if (patch.location !== undefined) {
      text(patch.location, 'location', 500);
      body.location = clean(patch.location);
    }
    if (patch.attendees !== undefined) {
      if (!Array.isArray(patch.attendees) || patch.attendees.length > 20) throw Error('Bounded attendees required');
      body.attendees = patch.attendees.map((email) => ({ email: String(email).toLowerCase() }));
    }
    if (!Object.keys(body).length) throw Error('Event update requires at least one field');
    if (patch.start !== undefined && patch.end !== undefined) assertRange(patch.start, patch.end);
    if (!ID.test(calendarId) && calendarId !== 'primary') throw Error('Bounded calendar id required');
    const data = await this.#api('PATCH', `calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`, {
      write: true,
      body,
      query: { sendUpdates: ['all', 'externalOnly', 'none'].includes(sendUpdates) ? sendUpdates : 'none' },
    });
    this.#live = true;
    return { item: this.#event(data, calendarId), updated: true, host_verified: true, live_qualified: true, untrusted: true, authority: false };
  }

  async deleteEvent({ calendarId = 'primary', eventId, sendUpdates = 'none' }) {
    if (!ID.test(eventId || '')) throw Error('Explicit event ID required');
    if (!ID.test(calendarId) && calendarId !== 'primary') throw Error('Bounded calendar id required');
    await this.#api('DELETE', `calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`, {
      write: true,
      query: { sendUpdates: ['all', 'externalOnly', 'none'].includes(sendUpdates) ? sendUpdates : 'none' },
    });
    this.#live = true;
    return { deleted: true, event_id: eventId, calendar_id: calendarId, host_verified: true, live_qualified: true, authority: false };
  }
}

module.exports = { CalendarConnector, clean, isoOrThrow, assertRange };
