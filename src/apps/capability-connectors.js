'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { keys, text, integer, bool, list, oneOf, pattern, fail } = require('../capability-util');

// Accounts are routed by alias; credentials live only in the connector's own
// secure store and are never passed through Airodrom or Personal Memory.
const CONNECTORS = Object.freeze({
  gmail: { label: 'Gmail', accounts: ['gmail.personal', 'gmail.arecibo'], humanGate: 'google_oauth_login' },
  whatsapp: { label: 'WhatsApp', accounts: ['whatsapp.personal'], humanGate: 'touch_id_webauthn' },
  calendar: { label: 'Calendar', accounts: ['calendar.personal', 'calendar.arecibo'], humanGate: 'google_oauth_login' },
  reminders: { label: 'Reminders', accounts: ['reminders.local'], humanGate: 'macos_automation' },
  contacts: { label: 'Contacts', accounts: ['contacts.local'], humanGate: 'macos_automation' },
  cloud: { label: 'Cloud', accounts: [], humanGate: 'password_mfa_entry' }
});
const EMAIL = /^[^\s@<>(),;:"]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,63}$/;
const ID = /^[A-Za-z0-9._:@+-]{1,200}$/;
const SQLITE_FILE = /\.(?:sqlite3?|db|db3)$/i;

const account = (value, connector) => { oneOf(value, CONNECTORS[connector].accounts, 'account'); return value; };
const recipients = (value, name, optional = false) => list(value, name, { max: 500, optional, item: entry => pattern(entry, EMAIL, 'recipient') });
const ids = (value, name, max = 200) => list(value, name, { max, item: entry => pattern(entry, ID, name) });

function bulk(ctx, count, broadcast, what) {
  if (broadcast === true || count > ctx.policy.bulkRecipientThreshold) return { decision: 'approval_required', riskClass: 'EXTERNAL_WRITE', v1Category: 'messaging_bulk_broadcast', reason: `${what} to ${count} recipients is bulk/broadcast and requires approval` };
  return null;
}

function connector(name, validate, assess = null) {
  const connectorName = name.split('_')[0] === 'reminder' ? 'reminders' : name.split('_')[0] === 'contact' ? 'contacts' : name.split('_')[0];
  return {
    validate,
    // Pure: derived from the validated input only, so it also runs for inactive
    // connectors and reports the would-be standing decision.
    pureAssess: true,
    assess: (ctx, input) => ({ scope: input.account || connectorName, dynamic: assess ? assess(ctx, input) : null }),
    // Reached only if an operator later activates a connector without an adapter.
    perform: () => fail(`${CONNECTORS[connectorName]?.label || connectorName} connector is not connected`)
  };
}

function connectorCapabilities() {
  const mail = (required, optional = []) => input => { keys(input, ['account', ...required], optional); account(input.account, 'gmail'); return input; };
  const message = input => { text(input.subject, 'subject', { max: 998, optional: true, multiline: false }); text(input.body, 'body', { max: 200_000, min: 0, optional: true }); recipients(input.to, 'to', !input.to); recipients(input.cc, 'cc', true); recipients(input.bcc, 'bcc', true); bool(input.broadcast, 'broadcast'); return input; };
  const recipientCount = input => (input.to || []).length + (input.cc || []).length + (input.bcc || []).length;
  const calendar = (required, optional = []) => input => { keys(input, ['account', ...required], optional); account(input.account, 'calendar'); return input; };
  const isoTime = (value, name, optional = false) => pattern(value, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/, name, { optional });
  return {
    gmail_read: connector('gmail_read', input => { mail(['messageId'])(input); pattern(input.messageId, ID, 'messageId'); return input; }),
    gmail_search: connector('gmail_search', input => { mail(['query'], ['limit'])(input); text(input.query, 'query', { max: 1_000 }); integer(input.limit, 'limit', { min: 1, max: 100, optional: true }); return input; }),
    gmail_draft: connector('gmail_draft', input => message(mail(['to', 'subject', 'body'], ['cc', 'bcc'])(input))),
    gmail_send: connector('gmail_send', input => message(mail(['to', 'subject', 'body'], ['cc', 'bcc', 'broadcast'])(input)), (ctx, input) => bulk(ctx, recipientCount(input), input.broadcast, 'Email')),
    gmail_reply: connector('gmail_reply', input => { mail(['threadId', 'body'], ['to', 'cc', 'replyAll'])(input); pattern(input.threadId, ID, 'threadId'); bool(input.replyAll, 'replyAll'); return message(input); }, (ctx, input) => bulk(ctx, recipientCount(input), false, 'Reply')),
    gmail_forward: connector('gmail_forward', input => { mail(['messageId', 'to'], ['body'])(input); pattern(input.messageId, ID, 'messageId'); return message(input); }, (ctx, input) => bulk(ctx, recipientCount(input), false, 'Forward')),
    gmail_archive: connector('gmail_archive', input => { mail(['messageIds'])(input); ids(input.messageIds, 'messageIds', 100); return input; }),
    gmail_label: connector('gmail_label', input => { mail(['messageIds', 'label'])(input); ids(input.messageIds, 'messageIds', 100); text(input.label, 'label', { max: 100, multiline: false }); return input; }),
    whatsapp_read: connector('whatsapp_read', input => { keys(input, ['chatId'], ['limit']); pattern(input.chatId, ID, 'chatId'); integer(input.limit, 'limit', { min: 1, max: 100, optional: true }); return input; }),
    whatsapp_send: connector('whatsapp_send', input => { keys(input, ['to', 'body'], ['broadcast']); ids(input.to, 'to', 500); text(input.body, 'body', { max: 65_000 }); bool(input.broadcast, 'broadcast'); return input; }, (ctx, input) => bulk(ctx, input.to.length, input.broadcast, 'WhatsApp message')),
    whatsapp_reply: connector('whatsapp_reply', input => { keys(input, ['chatId', 'body']); pattern(input.chatId, ID, 'chatId'); text(input.body, 'body', { max: 65_000 }); return input; }),
    calendar_read: connector('calendar_read', input => { calendar(['from', 'to'])(input); isoTime(input.from, 'from'); isoTime(input.to, 'to'); return input; }),
    calendar_search: connector('calendar_search', input => { calendar(['query'])(input); text(input.query, 'query', { max: 500 }); return input; }),
    calendar_create: connector('calendar_create', input => { calendar(['title', 'start', 'end'], ['attendees', 'location', 'notes'])(input); text(input.title, 'title', { max: 500, multiline: false }); isoTime(input.start, 'start'); isoTime(input.end, 'end'); recipients(input.attendees, 'attendees', true); text(input.location, 'location', { max: 500, optional: true }); text(input.notes, 'notes', { max: 8_000, optional: true }); return input; }, (ctx, input) => bulk(ctx, (input.attendees || []).length, false, 'Invitation')),
    calendar_update: connector('calendar_update', input => { calendar(['eventId'], ['title', 'start', 'end', 'attendees', 'location', 'notes'])(input); pattern(input.eventId, ID, 'eventId'); isoTime(input.start, 'start', true); isoTime(input.end, 'end', true); recipients(input.attendees, 'attendees', true); return input; }, (ctx, input) => bulk(ctx, (input.attendees || []).length, false, 'Invitation update')),
    calendar_delete: connector('calendar_delete', input => { calendar(['eventIds'], ['notifyAttendees'])(input); ids(input.eventIds, 'eventIds', 200); bool(input.notifyAttendees, 'notifyAttendees'); return input; }),
    reminder_list: connector('reminder_list', input => { keys(input, [], ['list']); text(input.list, 'list', { max: 200, optional: true, multiline: false }); return input; }),
    reminder_create: connector('reminder_create', input => { keys(input, ['title'], ['list', 'due', 'notes']); text(input.title, 'title', { max: 500, multiline: false }); isoTime(input.due, 'due', true); return input; }),
    reminder_update: connector('reminder_update', input => { keys(input, ['reminderId'], ['title', 'due', 'notes']); pattern(input.reminderId, ID, 'reminderId'); isoTime(input.due, 'due', true); return input; }),
    reminder_complete: connector('reminder_complete', input => { keys(input, ['reminderId']); pattern(input.reminderId, ID, 'reminderId'); return input; }),
    contact_search: connector('contact_search', input => { keys(input, ['query']); text(input.query, 'query', { max: 200 }); return input; }),
    contact_get: connector('contact_get', input => { keys(input, ['contactId']); pattern(input.contactId, ID, 'contactId'); return input; }),
    contact_create: connector('contact_create', input => { keys(input, ['name'], ['email', 'phone']); text(input.name, 'name', { max: 200, multiline: false }); pattern(input.email, EMAIL, 'email', { optional: true }); pattern(input.phone, /^\+?[0-9 ().-]{4,32}$/, 'phone', { optional: true }); return input; }),
    contact_update: connector('contact_update', input => { keys(input, ['contactId'], ['name', 'email', 'phone']); pattern(input.contactId, ID, 'contactId'); pattern(input.email, EMAIL, 'email', { optional: true }); return input; }),
    contact_import_bulk: connector('contact_import_bulk', input => { keys(input, ['contacts']); list(input.contacts, 'contacts', { max: 5_000, item: entry => entry }); return input; }),
    contact_delete: connector('contact_delete', input => { keys(input, ['contactIds']); ids(input.contactIds, 'contactIds', 5_000); return input; }),
    ...Object.fromEntries(['cloud_inventory', 'cloud_health', 'cloud_logs', 'cloud_deploy_status', 'cloud_cost', 'cloud_deploy_production', 'cloud_iam_mutate', 'cloud_dns_mutate', 'cloud_secret_mutate', 'cloud_infra_destroy'].map(name => [name, connector(name, input => { keys(input, ['provider'], ['resource', 'target']); oneOf(input.provider, ['aws', 'gcp', 'azure', 'cloudflare', 'vercel', 'fly'], 'provider'); text(input.resource, 'resource', { max: 400, optional: true }); text(input.target, 'target', { max: 400, optional: true }); return input; })])),
    financial_transaction: connector('financial_transaction', input => { keys(input, ['description']); text(input.description, 'description', { max: 500 }); return input; }),
    ...Object.fromEntries(['screen_inspect', 'ui_find', 'ui_click', 'ui_type', 'ui_select'].map(name => [name, { validate: input => { keys(input, [], ['app', 'target', 'text']); return input; }, perform: () => fail('UI control is a foundation boundary only; no adapter is active') }])),
    ...Object.fromEntries(['disk_repair', 'disk_erase', 'disk_partition', 'disk_format', 'credential_update', 'github_repo_settings_update', 'browser_download_safe', 'sudo', 'system_settings_change', 'firewall_change', 'secret_read_value', 'db_migrate_dev', 'db_restore_overwrite', 'db_production_mutation'].map(name => [name, { validate: input => { keys(input, [], ['target', 'device', 'name', 'url', 'path', 'sql']); return input; }, perform: () => fail(`${name} has no active adapter`) }]))
  };
}

// Development SQLite files only: opened read-only, extensions disabled and
// ATTACH refused so a query cannot reach files outside the resolved scope.
function databaseCapabilities() {
  const { DatabaseSync, backup } = require('node:sqlite');
  const database = (ctx, value) => {
    const resolved = ctx.scopes.resolve(value, { mode: 'read', workspace: ctx.task.workspace });
    if (!SQLITE_FILE.test(resolved.canonical) || !fs.statSync(resolved.canonical).isFile()) fail('Only development SQLite files (.sqlite, .sqlite3, .db, .db3) are supported');
    return resolved;
  };
  const open = file => new DatabaseSync(file, { readOnly: true, allowExtension: false });
  const fileInput = input => { keys(input, ['path']); text(input.path, 'path'); return input; };
  return {
    db_status: {
      validate: fileInput, assess: (ctx, input) => ({ scope: database(ctx, input.path).scope }),
      perform: (ctx, input) => { const { canonical } = database(ctx, input.path); const db = open(canonical); try { const tables = db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE type = 'table'").get().n; const integrity = db.prepare('PRAGMA quick_check').get(); return { path: ctx.scopes.display(canonical), bytes: fs.statSync(canonical).size, tables, quick_check: Object.values(integrity)[0] }; } finally { db.close(); } }
    },
    db_schema: {
      validate: fileInput, assess: (ctx, input) => ({ scope: database(ctx, input.path).scope }),
      perform: (ctx, input) => { const { canonical } = database(ctx, input.path); const db = open(canonical); try { return { objects: db.prepare("SELECT type, name, tbl_name AS tableName, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all().slice(0, 500) }; } finally { db.close(); } }
    },
    db_query_read: {
      validate: input => {
        keys(input, ['path', 'sql'], ['params', 'limit']); text(input.path, 'path'); text(input.sql, 'sql', { max: 20_000 });
        const sql = input.sql.trim().replace(/;\s*$/, '');
        if (!/^(?:select|with|explain)\b/i.test(sql) || sql.includes(';') || /\b(?:attach|detach|pragma|vacuum|load_extension|insert|update|delete|replace|create|drop|alter|reindex)\b/i.test(sql)) fail('Only a single read-only SELECT/WITH/EXPLAIN statement is allowed');
        if (input.params !== undefined) list(input.params, 'params', { max: 100, item: value => (['string', 'number'].includes(typeof value) || value === null) ? value : fail('Invalid params') });
        integer(input.limit, 'limit', { min: 1, max: 1_000, optional: true }); return input;
      },
      assess: (ctx, input) => ({ scope: database(ctx, input.path).scope }),
      perform: (ctx, input) => {
        const { canonical } = database(ctx, input.path); const db = open(canonical);
        try {
          const rows = []; const limit = input.limit || 200;
          for (const row of db.prepare(input.sql.trim().replace(/;\s*$/, '')).iterate(...(input.params || []))) { if (rows.length >= limit) break; rows.push(row); }
          return { rows, row_count: rows.length, limit };
        } finally { db.close(); }
      }
    },
    db_backup: {
      validate: input => { keys(input, ['path', 'destination']); text(input.path, 'path'); text(input.destination, 'destination'); if (!SQLITE_FILE.test(input.destination)) fail('Backup destination must be a SQLite file name'); return input; },
      assess: (ctx, input) => {
        database(ctx, input.path);
        const target = ctx.scopes.resolve(input.destination, { mode: 'write', workspace: ctx.task.workspace, mustExist: false });
        return { scope: target.scope, dynamic: fs.existsSync(target.canonical) ? { decision: 'deny', kind: 'capability_denied', reason: 'Backup destination exists; choose a new file' } : null };
      },
      perform: async (ctx, input) => {
        const { canonical } = database(ctx, input.path);
        const target = ctx.scopes.resolve(input.destination, { mode: 'write', workspace: ctx.task.workspace, mustExist: false }).canonical;
        if (fs.existsSync(target)) fail('Backup destination exists');
        const db = open(canonical);
        try { await backup(db, target); } finally { db.close(); }
        ctx.touch(target); return { source: ctx.scopes.display(canonical), destination: ctx.scopes.display(target), bytes: fs.statSync(target).size };
      }
    }
  };
}

const AGENTS = Object.freeze({
  opencode: {label:'OpenCode (default / primary)',capabilities:['coding','bounded_file_work'],cost_class:'local',privacy_class:'local_only',preferred_task_types:['large_multi_file_coding','ide_diagnostics']},
  host: { label: 'Airodrom host primitives', capabilities: ['local_diagnostics', 'files', 'tests', 'git', 'mac_capabilities', 'developer_tools'], cost_class: 'local', privacy_class: 'local_only', preferred_task_types: ['local_diagnostics', 'local_files', 'tests', 'git'] },
  chatgpt: { label: 'ChatGPT', capabilities: ['architecture', 'review', 'orchestration', 'planning'], cost_class: 'subscription', privacy_class: 'cloud', preferred_task_types: ['architecture', 'review', 'orchestration'] },
  codex: { label: 'Codex', capabilities: ['multi_file_coding','repository_tasks','durable_handoff'], cost_class:'subscription',privacy_class:'cloud',preferred_task_types:['large_multi_file_coding'] },
  cursor: { label: 'Cursor', capabilities: ['ide', 'multi_file_coding', 'ide_diagnostics'], cost_class: 'subscription', privacy_class: 'cloud', preferred_task_types: ['ide_diagnostics', 'large_multi_file_coding'] },
  claude_code: { label: 'Claude Code', capabilities: ['multi_file_coding', 'refactoring', 'repository_tasks'], cost_class: 'subscription_or_api', privacy_class: 'cloud', preferred_task_types: ['large_multi_file_coding'] }
});
const TASK_TYPES = ['local_diagnostics', 'local_files', 'tests', 'git', 'large_multi_file_coding', 'architecture', 'review', 'orchestration', 'ide_diagnostics'];

function agentCapabilities() {
  const availability = async ctx => {
    const tools = ctx.devtools || {};
    const opencode = await ctx.opencodeStatus?.();
    const claude = await tools.claudeStatus?.(ctx).catch(() => null);
    const cursor = await tools.cursorStatus?.(ctx).catch(() => null);
    return {
      opencode: {state:opencode?.available===true?'available':'unavailable',reason:opencode?.reason||'opencode_unavailable'},
      host: { state: 'available' },
      chatgpt: { state: ctx.mcpConnected?.() ? 'connected' : 'unknown' },
      cursor: {
        state: 'unqualified',
        editor_available: cursor?.installed === true,
        agent_execution: false,
        agent_availability: 'unqualified',
        reason: 'cursor_execution_unqualified',
        last_ide_task: (() => { try { return require('../capability-devtools').ideTaskJobs.last('cursor'); } catch { return null; } })()
      },
      codex:{state:'unavailable',implemented:true,dispatch_mode:'local_handoff',reason:'native_dispatch_unavailable'},
      claude_code: { state: !claude?.installed?'not_installed':!claude.logged_in?'needs_login':claude.auth_mode!=='subscription'||claude.api_key_overrides_subscription?'unavailable':claude.running_jobs>0?'busy':'available', auth_mode: claude?.auth_mode || null,reason:claude?.api_key_overrides_subscription?'billing_override_requires_review':claude?.auth_mode!=='subscription'?'subscription_required':null }
    };
  };
  return {
    agent_list: { validate: input => keys(input), perform: async ctx => { const live = await availability(ctx); return { agents: Object.entries(AGENTS).map(([id, agent]) => ({ id, ...agent, ...live[id] })), dispatch: 'not_available_in_this_phase' }; } },
    agent_route_suggest: {
      validate: input => { keys(input, ['taskType'], ['size', 'privacy']); oneOf(input.taskType, TASK_TYPES, 'taskType'); oneOf(input.size, ['small', 'medium', 'large'], 'size', { optional: true }); oneOf(input.privacy, ['local_only', 'cloud_ok'], 'privacy', { optional: true }); return input; },
      perform: async (ctx, input) => {
        const live = await availability(ctx);
        const taxonomy={large_multi_file_coding:'large_multi_file_coding',ide_diagnostics:'ide_diagnostics'};
        const observations=Object.fromEntries(Object.entries(live).map(([id,a])=>[id,{...a,available:['available','connected'].includes(a.state)}]));
        const advice=require('../agent-routing').routeTask({task_type:taxonomy[input.taskType]||input.taskType,privacy:input.privacy},observations);
        return {...advice,state:advice.selected?'suggested':'waiting',suggested_agent:advice.selected,alternatives:advice.fallback_plan||[],availability:live};
      }
    }
  };
}

module.exports = { connectorCapabilities, databaseCapabilities, agentCapabilities, CONNECTORS, AGENTS };
