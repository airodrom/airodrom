#!/usr/bin/env node
'use strict';
// Safe local follow of host-observed Live Activity / Mission events (redacted projections only).
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

function homeDir() {
  return process.env.AIRODROM_HOME || path.join(os.homedir(), '.airodrom');
}

function readDiscovery(home) {
  const file = path.join(home, 'data', 'ui.json');
  const raw = fs.readFileSync(file, 'utf8');
  const data = JSON.parse(raw);
  if (!data?.url || typeof data.url !== 'string') throw Error('Control Center discovery unavailable');
  const u = new URL(data.url);
  const token = new URLSearchParams(u.hash.slice(1)).get('token');
  if (!token) throw Error('Authorization token unavailable; reopen Control Center from the menu');
  return { origin: u.origin, token };
}

function parseArgs(argv) {
  let mission = null, category = '', json = false, once = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') json = true;
    else if (a === '--once') once = true;
    else if (a === '--mission' || a === '-m') mission = argv[++i];
    else if (a === '--category' || a === '-c') category = argv[++i] || '';
    else if (a === '--help' || a === '-h') return { help: true };
    else if (!a.startsWith('-') && !mission) mission = a;
  }
  if (mission && !/^[a-f0-9-]{36}$/i.test(mission)) throw Error('Mission id must be a UUID');
  return { mission, category, json, once };
}

function help() {
  return `airodrom logs follow — stream host-observed Mission / Live Activity events

Usage:
  airodrom logs follow [--mission <uuid>] [--category File|Worker|Test|...] [--once] [--json]

Notes:
  - Uses the existing local Control Center discovery token (same privacy boundary).
  - Never prints credentials, Memory contents, or raw worker reasoning.
  - Prefer Control Center → Live Activity for the Mission-centered UI.
`;
}

async function follow({ mission, category, json, once }) {
  const { origin, token } = readDiscovery(homeDir());
  const auth = { Authorization: 'Bearer ' + token };
  let after = 0;
  const params = () => {
    const p = new URLSearchParams({ after: String(after) });
    if (mission) p.set('mission', mission);
    if (category) p.set('category', category);
    return p;
  };
  // Snapshot board once for context
  if (!json) {
    const boardUrl = new URL('/api/product/live-activity', origin);
    boardUrl.searchParams.set('tab', 'now');
    const board = await fetch(boardUrl, { headers: auth }).then(r => r.json());
    const sum = board.supervisor?.summary || {};
    process.stdout.write(`Live Activity · active Runs ${sum.active_agent_runs ?? 0} · live work ${sum.live_work ?? 0}\n`);
    if (mission) process.stdout.write(`Following Mission ${mission}\n`);
    else process.stdout.write('Following global recent events (Ctrl+C to stop)\n');
  }
  do {
    const page = await fetch(origin + '/api/product/live-events?' + params(), { headers: auth }).then(r => {
      if (!r.ok) throw Error('Live events unavailable (' + r.status + ')');
      return r.json();
    });
    for (const e of page.events || []) {
      after = Math.max(after, e.sequence || after);
      if (json) process.stdout.write(JSON.stringify(e) + '\n');
      else {
        const ts = e.timestamp_ms ? new Date(e.timestamp_ms).toISOString() : '—';
        const mid = e.mission_id ? e.mission_id.slice(0, 8) : 'workspace';
        process.stdout.write(`${ts}  ${mid}  ${(e.category || '').padEnd(12)}  ${e.label || e.event_type}\n`);
      }
    }
    if (once) break;
    await new Promise(r => setTimeout(r, 1000));
  } while (true);
}

async function main(argv = process.argv.slice(2)) {
  const [head, ...rest] = argv;
  if (!head || head === 'help' || head === '--help') {
    process.stdout.write(help());
    return;
  }
  if (head !== 'follow') throw Error('Use: airodrom logs follow [--mission <uuid>]');
  const opts = parseArgs(rest);
  if (opts.help) {
    process.stdout.write(help());
    return;
  }
  await follow(opts);
}

if (require.main === module) {
  main().catch(error => {
    console.error('Airodrom: ' + String(error.message || error).slice(0, 240));
    process.exitCode = 1;
  });
}

module.exports = { main, parseArgs, help };
