'use strict';
// Host Calendar execution. Deterministic reads succeed without OpenCode.
const { CalendarConnector } = require('./calendar-connector');
const { CalendarSessions } = require('./calendar-session');
const { WRITE_SCOPE } = require('./calendar-oauth');

function sessions(server) {
  if (!server.calendarSessions) server.calendarSessions = new CalendarSessions();
  return server.calendarSessions;
}

function connector(server) {
  if (!server.calendarOAuth) return null;
  if (!server.calendarConnector) {
    // Mirror Gmail: test processes must inject calendarConnector; never auto-wire live Google.
    if (require('./external-write-context').isTestProcess()) return null;
    server.calendarConnector = new CalendarConnector({
      oauth: server.calendarOAuth,
      mode: 'live',
      connected: () => !!server.calendarOAuth.status().connected,
    });
  }
  return server.calendarConnector;
}

function requireConversation(conversation_id) {
  if (typeof conversation_id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(conversation_id)) {
    return {
      kind: 'clarify',
      route: 'CALENDAR',
      message: 'Calendar follow-ups and writes require an authenticated Terminal conversation session. Re-open the interactive chat and try again.',
      authority: false,
      host_verified: true,
      model_invoked: false,
      code: 'calendar_session_required',
    };
  }
  return null;
}

function authorizationOffer(server, { write = false } = {}) {
  const oauth = !!server.calendarOAuth;
  return {
    kind: 'connect_required',
    route: 'CALENDAR',
    connector: 'calendar',
    can_start_oauth: oauth,
    write_required: !!write,
    message: write
      ? 'Calendar writes need a separate Google consent for calendar.events. Run /connect calendar manage. Gmail and read-only Calendar consent do not grant writes.'
      : 'Google Calendar needs authorization. Run /connect calendar for read-only calendar.readonly access. Gmail consent does not grant Calendar. A “configured” indicator is not live access.',
    authorized: false,
    authority: false,
    host_verified: true,
    model_invoked: false,
  };
}

function dayWindow(day = 'today', { afternoon = false, morning = false } = {}) {
  const now = new Date();
  const start = new Date(now);
  start.setSeconds(0, 0);
  const dow = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  if (day === 'tomorrow') start.setDate(start.getDate() + 1);
  else if (dow.includes(String(day).toLowerCase())) {
    const target = dow.indexOf(String(day).toLowerCase());
    let delta = (target - start.getDay() + 7) % 7;
    if (delta === 0 && now.getHours() >= 18) delta = 7;
    start.setDate(start.getDate() + delta);
  }
  const end = new Date(start);
  if (afternoon) {
    start.setHours(12, 0, 0, 0);
    end.setHours(18, 0, 0, 0);
  } else if (morning) {
    start.setHours(6, 0, 0, 0);
    end.setHours(12, 0, 0, 0);
  } else if (day === 'today') {
    end.setHours(23, 59, 59, 999);
  } else {
    start.setHours(0, 0, 0, 0);
    end.setHours(23, 59, 59, 999);
  }
  if (start.getTime() >= end.getTime()) {
    const err = Error('Calendar window end must be after start.');
    err.code = 'calendar_invalid_range';
    throw err;
  }
  return { timeMin: start.toISOString(), timeMax: end.toISOString(), label: day };
}

function parseClockOnDay(baseIso, hm) {
  const [h, m] = String(hm).split(':').map(Number);
  if (!Number.isInteger(h) || !Number.isInteger(m) || h < 0 || h > 23 || m < 0 || m > 59) {
    const err = Error('Valid HH:MM start and end times are required.');
    err.code = 'calendar_invalid_time';
    throw err;
  }
  const start = new Date(baseIso);
  start.setHours(h, m, 0, 0);
  return start;
}

function formatEvents(items, { day, partial = false, has_more = false } = {}) {
  if (!items.length) return `No events found${day ? ' for ' + day : ''} on the authorized calendar (host-verified).`;
  const lines = items.map((e, i) => {
    const when = [e.start, e.end].filter(Boolean).join(' → ');
    const allDay = e.all_day ? ' · all-day' : '';
    return `${i + 1}. ${e.summary || '(no title)'} · ${when || 'time unavailable'}${allDay} · ref ${e.id}`;
  });
  let message = `Host-verified calendar results${day ? ' (' + day + ')' : ''}. Showing ${items.length} event${items.length === 1 ? '' : 's'}${partial || has_more ? ' (partial page)' : ''}.\n` + lines.join('\n');
  if (has_more) message += '\nSay “show more” for the next bounded page.';
  return message;
}

function helpMessage(server) {
  const item = connector(server)?.status() || { state: 'unavailable', connected: false, live_qualified: false, can_write: false };
  const lines = [
    'Google Calendar control is host-routed (not a model tool claim).',
    `State: ${item.state} · connected=${!!item.connected} · live_qualified=${!!item.live_qualified} · writes=${item.can_write ? 'manage scope present' : 'read-only or unauthorized'}.`,
    'Gmail gmail.readonly does not grant Calendar. Use /connect calendar for calendar.readonly reads; /connect calendar manage for calendar.events writes.',
    'Reads: “What’s on my calendar tomorrow?”, “Am I free Friday afternoon?”, “Search calendar for interview”, “List calendars”.',
    'Writes (after manage consent + preview confirm): “Create event Team sync tomorrow 14:00 to 14:30”, then confirm the preview.',
    'Destructive cancel: stage a preview, independently `/calendar approve <approval_id>`, then `/calendar confirm <preview_id> --destructive`. A textual --destructive flag alone is not sufficient.',
    'Follow-ups (“show more”, “cancel that”) resolve only from a verified Calendar session in this Terminal conversation — they do not continue Gmail search.',
    item.setup ? `Next: ${item.setup}` : 'Next: configure the Google desktop OAuth client (airodrom gmail setup shares the Desktop client), then /connect calendar.',
  ];
  return lines.join('\n');
}

function isUncertainWriteError(error) {
  const code = error?.code || error?.safe_error_class || '';
  const msg = String(error?.message || '');
  return /timeout|AbortError|ECONNRESET|ENOTFOUND|fetch failed|network|temporar|unavailable|429|500|502|503|504/i.test(code + ' ' + msg)
    || error?.name === 'TimeoutError'
    || error?.name === 'AbortError';
}

async function run(server, parsed, { conversation_id = null, confirm_id = null, confirmed = false, destructive = false } = {}) {
  const model_invoked = false;
  const host_verified = true;
  if (parsed.action === 'help') {
    return {
      kind: 'calendar',
      action: 'help',
      route: 'CALENDAR',
      message: helpMessage(server),
      status: connector(server)?.status() || null,
      host_verified,
      model_invoked,
      authority: false,
    };
  }

  if (parsed.action === 'approve') {
    const missing = requireConversation(conversation_id);
    if (missing) return missing;
    try {
      const approved = sessions(server).approveWrite(parsed.approval_id || confirm_id, { conversation_id, operator: 'operator' });
      return {
        kind: 'calendar',
        action: 'approval_recorded',
        route: 'CALENDAR',
        ...approved,
        message: `Independent destructive approval recorded for preview ${approved.preview_id}. Confirm with /calendar confirm ${approved.preview_id} --destructive.`,
        host_verified,
        model_invoked,
        authority: false,
      };
    } catch (error) {
      return {
        kind: 'clarify',
        route: 'CALENDAR',
        message: error.message,
        code: error.code,
        host_verified,
        model_invoked,
        authority: false,
      };
    }
  }

  const adapter = connector(server);
  if (!adapter) return authorizationOffer(server, { write: ['create', 'reschedule', 'followup_duration', 'followup_cancel', 'cancel', 'confirm'].includes(parsed.action) });

  const st = adapter.status();
  if (!st.connected && !['help'].includes(parsed.action)) {
    return authorizationOffer(server, { write: false });
  }

  try {
    if (parsed.action === 'list_calendars') {
      const data = await adapter.listCalendars({ limit: 20 });
      return {
        kind: 'calendar',
        action: 'list_calendars',
        route: 'CALENDAR',
        items: data.items,
        message: data.items.length
          ? `Host-verified calendars (${data.items.length}${data.has_more ? ', more available' : ''}):\n` + data.items.map((c, i) => `${i + 1}. ${c.summary}${c.primary ? ' · primary' : ''} · ${c.id}`).join('\n')
          : 'No calendars returned for this account.',
        has_more: data.has_more,
        host_verified,
        model_invoked,
        live_qualified: true,
        authority: false,
        untrusted: true,
      };
    }

    if (parsed.action === 'continue') {
      const missing = requireConversation(conversation_id);
      if (missing) return missing;
      let active;
      try {
        active = sessions(server).getActive({ conversation_id, operator: 'operator' });
      } catch (error) {
        return { kind: 'clarify', route: 'CALENDAR', message: error.message, code: error.code, host_verified, model_invoked, authority: false };
      }
      if (!active?.next_page_token) {
        return { kind: 'clarify', route: 'CALENDAR', message: 'No active calendar page to continue in this conversation. Ask what’s on your calendar first.', host_verified, model_invoked, authority: false };
      }
      const data = await adapter.listEvents({
        calendarId: active.calendar_id || 'primary',
        query: active.query,
        pageToken: active.next_page_token,
        limit: 10,
      });
      sessions(server).rememberList({
        items: data.items,
        action: active.action,
        query: active.query,
        day: active.day,
        calendar_id: active.calendar_id || data.calendar_id || 'primary',
        next_page_token: data._provider_next_page_token,
        conversation_id,
        operator: 'operator',
      });
      const { _provider_next_page_token, ...safe } = data;
      void _provider_next_page_token;
      return {
        kind: 'calendar',
        action: 'events',
        route: 'CALENDAR',
        items: safe.items,
        message: formatEvents(safe.items, { day: active.day, has_more: safe.has_more, partial: true }),
        has_more: safe.has_more,
        exhausted: safe.provider_exhausted,
        host_verified,
        model_invoked,
        live_qualified: true,
        authority: false,
        untrusted: true,
      };
    }

    if (parsed.action === 'events' || parsed.action === 'search') {
      const missing = requireConversation(conversation_id);
      if (missing) return missing;
      const window = dayWindow(parsed.day || (parsed.action === 'search' ? null : 'today'));
      const calendarId = 'primary';
      const data = await adapter.listEvents({
        calendarId,
        timeMin: parsed.action === 'search' ? new Date(Date.now() - 7 * 86400000).toISOString() : window.timeMin,
        timeMax: parsed.action === 'search' ? new Date(Date.now() + 30 * 86400000).toISOString() : window.timeMax,
        query: parsed.query || null,
        limit: 10,
        singleEvents: true,
      });
      sessions(server).rememberList({
        items: data.items,
        action: parsed.action,
        query: parsed.query || null,
        day: parsed.day || window.label,
        calendar_id: data.calendar_id || calendarId,
        next_page_token: data._provider_next_page_token,
        conversation_id,
        operator: 'operator',
      });
      return {
        kind: 'calendar',
        action: parsed.action,
        route: 'CALENDAR',
        items: data.items,
        message: formatEvents(data.items, { day: parsed.day || window.label, has_more: data.has_more }),
        has_more: data.has_more,
        exhausted: data.provider_exhausted,
        host_verified,
        model_invoked,
        live_qualified: true,
        authority: false,
        untrusted: true,
      };
    }

    if (parsed.action === 'freebusy') {
      const window = dayWindow(parsed.day || 'today', { afternoon: parsed.afternoon, morning: parsed.morning });
      const data = await adapter.freeBusy({ timeMin: window.timeMin, timeMax: window.timeMax, calendars: ['primary'] });
      if (!data.complete) {
        return {
          kind: 'clarify',
          route: 'CALENDAR',
          action: 'freebusy',
          message: 'Free/busy is incomplete: Google omitted the expected calendar or reported errors. Availability is unverified — not claimed available.',
          missing_calendars: data.missing_calendars,
          errored_calendars: data.errored_calendars,
          host_verified: true,
          model_invoked: false,
          live_qualified: false,
          authority: false,
          code: 'calendar_freebusy_incomplete',
        };
      }
      const busy = data.calendars.primary?.busy || [];
      const message = busy.length
        ? `Host-verified busy periods (${window.label}${parsed.afternoon ? ' afternoon' : parsed.morning ? ' morning' : ''}):\n` + busy.map((b) => `• ${b.start} → ${b.end}`).join('\n')
        : `Host-verified: no busy blocks on primary calendar for ${window.label}${parsed.afternoon ? ' afternoon' : parsed.morning ? ' morning' : ''} (free/busy evidence complete).`;
      return {
        kind: 'calendar',
        action: 'freebusy',
        route: 'CALENDAR',
        ...data,
        message,
        host_verified,
        model_invoked,
        live_qualified: true,
        authority: false,
        untrusted: true,
      };
    }

    if (parsed.clarify && parsed.message) {
      return { kind: 'clarify', route: 'CALENDAR', message: parsed.message, host_verified, model_invoked, authority: false };
    }

    if (parsed.action === 'create' && parsed.summary && parsed.start_hm && parsed.end_hm) {
      const missing = requireConversation(conversation_id);
      if (missing) return missing;
      if (!server.calendarOAuth.canWrite()) return authorizationOffer(server, { write: true });
      const window = dayWindow(parsed.day || 'tomorrow');
      const start = parseClockOnDay(window.timeMin, parsed.start_hm);
      const end = parseClockOnDay(window.timeMin, parsed.end_hm);
      if (end.getTime() <= start.getTime()) {
        return { kind: 'clarify', route: 'CALENDAR', message: 'Event end must be strictly after start. Check the times (including AM/PM and DST boundaries).', host_verified, model_invoked, authority: false };
      }
      const proposal = {
        op: 'create',
        summary: parsed.summary,
        start: start.toISOString(),
        end: end.toISOString(),
        calendar_id: 'primary',
      };
      const staged = sessions(server).stageWrite(proposal, { conversation_id, operator: 'operator' });
      return {
        kind: 'calendar',
        action: 'preview',
        route: 'CALENDAR',
        preview_id: staged.preview_id,
        proposal,
        message: `Preview (not created yet):\n• ${proposal.summary}\n• ${proposal.start} → ${proposal.end}\nConfirm with /calendar confirm ${staged.preview_id} or reject by ignoring. No attendees invited in this V1 create path.`,
        host_verified,
        model_invoked,
        authority: false,
        requires_confirmation: true,
      };
    }

    if (parsed.action === 'followup_cancel' || parsed.action === 'cancel') {
      const missing = requireConversation(conversation_id);
      if (missing) return missing;
      const resolved = sessions(server).selectByHint(parsed.raw || '', { conversation_id, operator: 'operator' });
      if (resolved.error) {
        return { kind: 'clarify', route: 'CALENDAR', message: resolved.error, choices: resolved.choices, code: resolved.code, host_verified, model_invoked, authority: false };
      }
      if (!server.calendarOAuth.canWrite()) return authorizationOffer(server, { write: true });
      const proposal = {
        op: 'delete',
        event_id: resolved.event.id,
        calendar_id: resolved.event.calendar_id || 'primary',
        summary: resolved.event.summary,
        destructive: true,
      };
      const staged = sessions(server).stageWrite(proposal, { conversation_id, operator: 'operator' });
      return {
        kind: 'calendar',
        action: 'preview',
        route: 'CALENDAR',
        preview_id: staged.preview_id,
        approval_id: staged.approval_id,
        proposal,
        message: `Destructive preview — cancel “${proposal.summary}” (${proposal.event_id}) on calendar ${proposal.calendar_id}.\n1) Independently approve: /calendar approve ${staged.approval_id}\n2) Confirm: /calendar confirm ${staged.preview_id} --destructive\nA textual --destructive flag alone is not sufficient.`,
        host_verified,
        model_invoked,
        authority: false,
        requires_confirmation: true,
        requires_independent_approval: true,
        destructive: true,
      };
    }

    if (parsed.action === 'reschedule' || parsed.action === 'followup_duration') {
      const missing = requireConversation(conversation_id);
      if (missing) return missing;
      const resolved = sessions(server).selectByHint(parsed.time_hint || parsed.raw || '', { conversation_id, operator: 'operator' });
      if (resolved.error && parsed.action !== 'followup_duration') {
        return { kind: 'clarify', route: 'CALENDAR', message: resolved.message || resolved.error, choices: resolved.choices, host_verified, model_invoked, authority: false };
      }
      const event = resolved.event || sessions(server).selected({ conversation_id, operator: 'operator' });
      if (!event) {
        return { kind: 'clarify', route: 'CALENDAR', message: 'No verified event selected in this conversation. Show the schedule first, then refer to a specific meeting.', host_verified, model_invoked, authority: false };
      }
      if (!server.calendarOAuth.canWrite()) return authorizationOffer(server, { write: true });
      let start = event.start;
      let end = event.end;
      if (event.all_day && parsed.action === 'reschedule') {
        return { kind: 'clarify', route: 'CALENDAR', message: 'This is an all-day event. Timed reschedule is not supported in V1; cancel and recreate, or adjust in Google Calendar.', host_verified, model_invoked, authority: false };
      }
      if (parsed.action === 'followup_duration' && start) {
        const s = new Date(start);
        const e = new Date(s.getTime() + parsed.minutes * 60000);
        end = e.toISOString();
      } else if (parsed.time_hint && start) {
        const m = /(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i.exec(parsed.time_hint);
        if (!m) {
          return { kind: 'clarify', route: 'CALENDAR', message: 'Could not parse the new time. Use e.g. 15:00 or 3 PM.', host_verified, model_invoked, authority: false };
        }
        let h = Number(m[1]);
        const min = m[2] ? Number(m[2]) : 0;
        const ap = (m[3] || '').toLowerCase();
        if (ap === 'pm' && h < 12) h += 12;
        if (ap === 'am' && h === 12) h = 0;
        const s = new Date(start);
        const duration = end ? (new Date(end) - new Date(start)) : 3600000;
        s.setHours(h, min, 0, 0);
        start = s.toISOString();
        end = new Date(s.getTime() + Math.max(duration, 600000)).toISOString();
      }
      if (start && end && new Date(end).getTime() <= new Date(start).getTime()) {
        return { kind: 'clarify', route: 'CALENDAR', message: 'Updated end must be strictly after start (check DST / time zone).', host_verified, model_invoked, authority: false };
      }
      const proposal = {
        op: 'update',
        event_id: event.id,
        calendar_id: event.calendar_id || 'primary',
        summary: event.summary,
        start,
        end,
      };
      const staged = sessions(server).stageWrite(proposal, { conversation_id, operator: 'operator' });
      return {
        kind: 'calendar',
        action: 'preview',
        route: 'CALENDAR',
        preview_id: staged.preview_id,
        proposal,
        message: `Preview update for “${proposal.summary}” on calendar ${proposal.calendar_id}:\n• ${proposal.start} → ${proposal.end}\nConfirm with /calendar confirm ${staged.preview_id}.`,
        host_verified,
        model_invoked,
        authority: false,
        requires_confirmation: true,
      };
    }

    if (parsed.action === 'confirm' || confirm_id) {
      const missing = requireConversation(conversation_id);
      if (missing) return missing;
      const id = confirm_id || parsed.preview_id;
      // Host-local create replay: completed preview IDs must not re-POST or claim Google idempotency.
      const priorCreate = sessions(server).getCompletedCreate(id, { conversation_id, operator: 'operator' });
      if (priorCreate) {
        return { ...priorCreate, host_verified, model_invoked, live_qualified: true, authority: false };
      }
      let row;
      try {
        row = sessions(server).peekWrite(id, { conversation_id, operator: 'operator' });
      } catch (error) {
        return { kind: 'clarify', route: 'CALENDAR', message: error.message, code: error.code, host_verified, model_invoked, authority: false };
      }

      const ownerConfirmed = confirmed === true || parsed.confirmed === true;
      const destructiveOk = destructive === true || parsed.destructive === true;

      if (row.destructive) {
        // Independent approval + owner confirmation + --destructive — flag alone fails closed.
        if (row.approval_status !== 'approved') {
          return {
            kind: 'clarify',
            route: 'CALENDAR',
            message: `Destructive calendar cancel requires independent approval first: /calendar approve ${row.approval_id}. The --destructive flag alone is not sufficient.`,
            approval_id: row.approval_id,
            host_verified,
            model_invoked,
            authority: false,
            code: 'calendar_destructive_approval_required',
          };
        }
        if (!ownerConfirmed) {
          return {
            kind: 'clarify',
            route: 'CALENDAR',
            message: 'Destructive calendar cancel requires explicit owner confirmation via /calendar confirm <id> --destructive.',
            host_verified,
            model_invoked,
            authority: false,
            code: 'calendar_owner_confirmation_required',
          };
        }
        if (!destructiveOk) {
          return {
            kind: 'clarify',
            route: 'CALENDAR',
            message: 'Destructive calendar cancel requires /calendar confirm <id> --destructive after independent approval.',
            host_verified,
            model_invoked,
            authority: false,
          };
        }
      } else if (!ownerConfirmed) {
        return { kind: 'clarify', route: 'CALENDAR', message: 'Confirm the preview with /calendar confirm <id>.', host_verified, model_invoked, authority: false };
      }

      if (!server.calendarOAuth.canWrite()) return authorizationOffer(server, { write: true });

      if (row.op === 'create') {
        try {
          const created = await adapter.createEvent({
            summary: row.summary,
            start: row.start,
            end: row.end,
            calendarId: row.calendar_id,
            hostDedupeKey: id,
          });
          sessions(server).commitWrite(id, { conversation_id, operator: 'operator' });
          const receipt = {
            kind: 'calendar',
            action: 'created',
            route: 'CALENDAR',
            item: created.item,
            message: `Created host-verified event “${created.item.summary}” (${created.item.id}).`,
            google_idempotent: false,
            host_verified,
            model_invoked,
            live_qualified: true,
            authority: false,
          };
          sessions(server).markCreateCompleted(id, receipt, { conversation_id, operator: 'operator' });
          return receipt;
        } catch (error) {
          if (isUncertainWriteError(error)) {
            return {
              kind: 'clarify',
              route: 'CALENDAR',
              action: 'uncertain',
              message: 'Calendar create did not return a verified success. The preview remains available — re-confirm after checking Google Calendar. Host does not claim Google-side deduplication.',
              preview_id: id,
              code: 'calendar_write_uncertain',
              host_verified: true,
              model_invoked: false,
              authority: false,
            };
          }
          throw error;
        }
      }

      // Consume only after we are about to mutate for update/delete.
      const proposal = sessions(server).commitWrite(id, { conversation_id, operator: 'operator' });

      if (proposal.op === 'update') {
        // Verify exact event/calendar identity before mutating.
        const verified = await adapter.getEvent({ calendarId: proposal.calendar_id, eventId: proposal.event_id });
        if (verified.item.id !== proposal.event_id || verified.item.calendar_id !== proposal.calendar_id) {
          return {
            kind: 'clarify',
            route: 'CALENDAR',
            message: 'Event identity mismatch against the verified calendar. Refresh the schedule and try again.',
            host_verified,
            model_invoked,
            authority: false,
            code: 'calendar_event_identity_mismatch',
          };
        }
        try {
          const updated = await adapter.updateEvent({
            calendarId: proposal.calendar_id,
            eventId: proposal.event_id,
            patch: { start: proposal.start, end: proposal.end },
          });
          return { kind: 'calendar', action: 'updated', route: 'CALENDAR', item: updated.item, message: `Updated host-verified event “${updated.item.summary}”.`, host_verified, model_invoked, live_qualified: true, authority: false };
        } catch (error) {
          if (isUncertainWriteError(error)) {
            return {
              kind: 'clarify',
              route: 'CALENDAR',
              action: 'uncertain',
              message: 'Calendar update did not return a verified success. Re-list the schedule before retrying; the prior preview was consumed and must be re-staged.',
              code: 'calendar_write_uncertain',
              host_verified: true,
              model_invoked: false,
              authority: false,
            };
          }
          throw error;
        }
      }

      if (proposal.op === 'delete') {
        const verified = await adapter.getEvent({ calendarId: proposal.calendar_id, eventId: proposal.event_id });
        if (verified.item.id !== proposal.event_id || verified.item.calendar_id !== proposal.calendar_id) {
          return {
            kind: 'clarify',
            route: 'CALENDAR',
            message: 'Event identity mismatch against the verified calendar. Refresh the schedule and try again.',
            host_verified,
            model_invoked,
            authority: false,
            code: 'calendar_event_identity_mismatch',
          };
        }
        try {
          await adapter.deleteEvent({ calendarId: proposal.calendar_id, eventId: proposal.event_id });
          return { kind: 'calendar', action: 'deleted', route: 'CALENDAR', message: `Cancelled host-verified event ${proposal.event_id} on calendar ${proposal.calendar_id}.`, host_verified, model_invoked, live_qualified: true, authority: false };
        } catch (error) {
          if (isUncertainWriteError(error)) {
            return {
              kind: 'clarify',
              route: 'CALENDAR',
              action: 'uncertain',
              message: 'Calendar cancel did not return a verified success. Check Google Calendar before retrying; do not assume the event was deleted.',
              code: 'calendar_write_uncertain',
              host_verified: true,
              model_invoked: false,
              authority: false,
            };
          }
          throw error;
        }
      }
    }

    return { kind: 'clarify', route: 'CALENDAR', message: parsed.message || 'Unsupported calendar request. Try “help me control my calendar” or “what’s on my calendar tomorrow?”.', host_verified, model_invoked, authority: false };
  } catch (error) {
    if (error?.safe_error_class || /^calendar_oauth_/.test(error?.code || '') || error?.code === 'calendar_write_scope_required') {
      const offer = authorizationOffer(server, { write: error?.code === 'calendar_write_scope_required' });
      offer.safe_error_class = error.safe_error_class || error.code;
      if (error?.message && !/token|Bearer|refresh_token|access_token/i.test(error.message)) offer.failure_message = error.message;
      return offer;
    }
    if (error?.code === 'calendar_invalid_range' || error?.code === 'calendar_invalid_time' || error?.code === 'calendar_freebusy_invalid_range') {
      return { kind: 'clarify', route: 'CALENDAR', message: error.message, code: error.code, host_verified, model_invoked, authority: false };
    }
    throw error;
  }
}

module.exports = {
  run,
  helpMessage,
  authorizationOffer,
  dayWindow,
  connector,
  sessions,
  WRITE_SCOPE,
};
