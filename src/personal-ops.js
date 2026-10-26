'use strict';
// Personal Operations capability matrix — Issue #112.
// Host-owned discovery only. Never grants authority from model text.
const NEVER_AUTO = Object.freeze([
  'send_email', 'submit_job_application', 'invite_attendees', 'share_documents',
  'delete_records', 'expand_drive_scope', 'credential_changes', 'paid_external_services',
  'account_deletion', 'unrestricted_memory_disclosure'
]);

function gmailState(server) {
  const oauth = server.gmailOAuth;
  let item = null;
  try {
    item = require('./assistant-service').connectors(server.bridge).status().items.find(i => i.id === 'gmail');
  } catch { /* connectors may be unset in unit fixtures */ }
  if (!oauth && (!item || item.state === 'unavailable')) {
    return {
      id: 'gmail', label: 'Gmail',
      availability: 'NOT_SUPPORTED',
      auth: 'unavailable',
      live_qualified: false,
      reads: [],
      writes: [],
      note: 'Configure an owner Google desktop OAuth client (`airodrom gmail setup <client-id>`), prepare Keychain, restart, then /connect gmail.',
      next: 'airodrom gmail setup <client-id>'
    };
  }
  const st = oauth?.status?.() || {};
  const connected = item ? !!item.connected : !!st.configured;
  const live = item?.live_qualified === true;
  const oauthClientPresent = !!(oauth || item?.configured);
  return {
    id: 'gmail', label: 'Gmail',
    availability: live ? 'AVAILABLE' : 'AUTH_REQUIRED',
    auth: connected ? (live ? 'connected_live' : 'connected_unverified') : (oauthClientPresent ? 'oauth_required' : 'unavailable'),
    live_qualified: live,
    config_indicator: 'configured_means_oauth_client_present_not_live_access',
    reads: ['list', 'search', 'read', 'thread', 'job_categorize'],
    writes: [],
    note: connected
      ? (live
        ? 'Read-only Gmail is live-qualified. Search/read/job categorize are host-routed. Send/archive/label remain unavailable.'
        : 'OAuth token is present but live read qualification has not succeeded. Use /gmail status or authorize a fresh /connect gmail, then run a bounded search.')
      : (oauthClientPresent
        ? 'OAuth client is configured. Account consent is still required via /connect gmail. “Configured” is not live access.'
        : 'Gmail OAuth client is not configured.'),
    next: connected ? (live ? '/gmail search newer_than:14d subject:(application OR interview OR recruiter)' : 'Bounded Gmail search to live-qualify') : '/connect gmail'
  };
}

function calendarState(server) {
  const oauth = server?.calendarOAuth;
  let item = null;
  try { item = require('./calendar-service').connector(server)?.status() || null; } catch { /* fixtures */ }
  if (!oauth && (!item || item.state === 'unavailable')) {
    return {
      id: 'calendar', label: 'Google Calendar',
      availability: 'AUTH_REQUIRED',
      auth: 'unavailable',
      live_qualified: false,
      reads: ['list_calendars', 'events', 'search', 'freebusy'],
      writes: [],
      note: 'Calendar is separate from Gmail. Configure the Google desktop OAuth client (airodrom gmail setup), then /connect calendar for calendar.readonly. Writes need /connect calendar manage.',
      next: '/connect calendar'
    };
  }
  const st = oauth?.status?.() || {};
  const connected = item ? !!item.connected : !!st.connected;
  const live = item?.live_qualified === true;
  return {
    id: 'calendar', label: 'Google Calendar',
    availability: live ? 'AVAILABLE' : 'AUTH_REQUIRED',
    auth: connected ? (live ? 'connected_live' : 'connected_unverified') : 'oauth_required',
    live_qualified: live,
    reads: ['list_calendars', 'events', 'search', 'freebusy'],
    writes: st.can_write ? ['create_preview', 'update_preview', 'delete_with_approval'] : [],
    note: connected
      ? (live
        ? (st.can_write
          ? 'Calendar is live-qualified. Reads are host-routed; writes require preview confirmation (delete is destructive-approval).'
          : 'Calendar reads are live-qualified (calendar.readonly). Event create/update/delete needs /connect calendar manage.')
        : 'Calendar OAuth token is present but live qualification has not succeeded. Run a bounded calendar read.')
      : 'Calendar OAuth client is ready. Account consent still required via /connect calendar. Gmail consent does not grant Calendar.',
    next: connected ? (live ? (st.can_write ? 'Ask what’s on your calendar or schedule with preview confirm' : '/connect calendar manage for writes, or ask what’s on your calendar') : 'Bounded calendar events/freebusy read') : '/connect calendar'
  };
}

function driveState() {
  return {
    id: 'drive', label: 'Google Drive',
    availability: 'NOT_SUPPORTED',
    auth: 'unavailable',
    live_qualified: false,
    reads: [],
    writes: [],
    note: 'Drive is opt-in and not blanket-authorized. No Drive connector is live-qualified here.',
    next: 'WAIT — separate Drive enrollment with exact folder selection'
  };
}

function sheetsState() {
  return {
    id: 'sheets', label: 'Google Sheets',
    availability: 'NOT_SUPPORTED',
    auth: 'unavailable',
    live_qualified: false,
    reads: [],
    writes: [],
    note: 'Google Sheets cloud sync is not live-qualified. Use the local job tracker (CSV/Excel-openable) instead.',
    next: 'Use local job tracker; Sheets requires separate owner consent later'
  };
}

function localFilesState() {
  return {
    id: 'local_files', label: 'Local files (governed)',
    availability: 'AVAILABLE',
    auth: 'host_governed',
    live_qualified: true,
    reads: ['selected_tracker_read'],
    writes: ['selected_tracker_update_with_standing_or_confirm'],
    note: 'Selected local job-tracker files may be created/updated under host policy. Outside those files, ordinary Mission/capability ceilings apply.',
    next: 'Ask to create or update the local job tracker'
  };
}

function jobTrackerState(bridge) {
  let manager = bridge?.jobSearchManager || null;
  const status = manager?.status?.('operator') || { active: false };
  return {
    id: 'job_tracker', label: 'Job Search Tracker',
    availability: 'AVAILABLE',
    auth: status.active ? 'local_tracker_ready' : 'not_created',
    live_qualified: true,
    path: status.path || null,
    reads: ['list_applications', 'daily_digest'],
    writes: ['create_tracker', 'upsert_application', 'record_follow_up'],
    note: status.active
      ? 'Local tracker is ready. Updates require identifiable evidence (message id, URL, or operator confirmation).'
      : 'No tracker yet. Ask to create a local job-search tracker workbook.',
    next: status.active ? 'Ask for a daily job-search digest or to log an application' : 'Create a local job-search tracker'
  };
}

function matrix(server) {
  return {
    version: 1,
    kind: 'personal_ops_plan',
    connectors: [
      gmailState(server),
      calendarState(server),
      driveState(),
      sheetsState(),
      localFilesState(),
      jobTrackerState(server.bridge)
    ],
    never_auto: NEVER_AUTO,
    conversation: {
      tools: false,
      note: 'Ordinary chat stays tool-free. The host router owns connector calls and tracker mutations.'
    },
    authority: false
  };
}

function plan(server, request = '') {
  const m = matrix(server);
  const lines = [
    'Here is what Airodrom can do for personal operations and job search right now (host authority — not model tools):',
    ...m.connectors.map(c => {
      const mark = c.availability === 'AVAILABLE' ? 'AVAILABLE' : c.availability === 'AUTH_REQUIRED' ? 'AUTH_REQUIRED' : 'NOT_SUPPORTED';
      return `- ${c.label}: ${mark} — ${c.note} Next: ${c.next}`;
    }),
    'Never automatic without separate confirmation: ' + NEVER_AUTO.join(', ') + '.',
    'A “configured” connector indicator means setup metadata exists; it is not live OAuth qualification or send access.'
  ];
  const lower = String(request || '').toLowerCase();
  const focus = [];
  if (/gmail|email|inbox|mail|recruiter/.test(lower)) focus.push(m.connectors.find(c => c.id === 'gmail'));
  if (/calendar|interview|schedule|meeting/.test(lower)) focus.push(m.connectors.find(c => c.id === 'calendar'));
  if (/drive|docs?|document/.test(lower)) focus.push(m.connectors.find(c => c.id === 'drive'));
  if (/sheet|excel|tracker|spreadsheet|xlsx|csv/.test(lower)) {
    focus.push(m.connectors.find(c => c.id === 'sheets'));
    focus.push(m.connectors.find(c => c.id === 'job_tracker'));
  }
  if (/job|application|career|recruiter|hiring/.test(lower)) focus.push(m.connectors.find(c => c.id === 'job_tracker'));
  return {
    ...m,
    request_focus: [...new Set(focus.filter(Boolean).map(c => c.id))],
    message: lines.join('\n'),
    actions: m.connectors.filter(c => c.availability !== 'NOT_SUPPORTED' || c.id === 'job_tracker').map(c => ({
      id: c.id, availability: c.availability, next: c.next
    })),
    authority: false
  };
}

function isPersonalOpsRequest(request) {
  if (typeof request !== 'string' || !request.trim()) return false;
  const r = request.trim();
  if (/^(?:help me\s+)?(?:find|search for|look for)\s+a\s+job\b/i.test(r)) return true;
  if (/\bjob search\b|\bmanage (?:my )?(?:job|applications?)\b/i.test(r)) return true;
  // Pure calendar control phrases are routed by calendar-intent, not this matrix.
  if (require('./calendar-intent').parse(r)) return false;
  if (/\b(?:manage|handle|take care of|organize|connect)\b.+\b(?:gmail|google (?:drive|calendar|sheets?)|calendar|drive|excel|notes|inbox)\b/i.test(r)) return true;
  if (/\b(?:gmail|calendar|drive|excel|sheets?|notes)\b.+\b(?:and|,)\b.+\b(?:gmail|calendar|drive|excel|sheets?|notes|job)\b/i.test(r)) return true;
  if (/^what (?:can|could) you (?:do|access|manage) (?:with|for) (?:my )?(?:gmail|calendar|drive|email|job search)/i.test(r)) return true;
  if (/^(?:can you|could you|please)\s+(?:manage|access|read|check|organize)\s+(?:my\s+)?(?:gmail|google|calendar|drive|excel|inbox)\b/i.test(r)) return true;
  return false;
}

module.exports = { matrix, plan, isPersonalOpsRequest, NEVER_AUTO, gmailState, calendarState };
