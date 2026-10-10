#!/usr/bin/env node
'use strict';
// Prepare webhook-only HTTPS ingress config for Meta → Airodrom.
// Never starts tunnels, never binds ports, never prints secrets.

const fs = require('node:fs');
const path = require('node:path');

function usage() {
  console.log(`Usage:
  node scripts/whatsapp-webhook-ingress-prep.cjs --hostname hooks.example.com --port 43117 [--write DIR]

Writes a cloudflared ingress snippet that forwards ONLY /webhooks/whatsapp to 127.0.0.1:<port>.
Does not start cloudflared, ngrok, or change Meta settings.`);
}

function main(argv = process.argv.slice(2)) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { usage(); return 0; }
    if (a === '--hostname' || a === '--port' || a === '--write') {
      args[a.slice(2)] = argv[++i];
      continue;
    }
    throw new Error('Unknown argument: ' + a);
  }
  if (!args.hostname || !/^[a-z0-9][a-z0-9.-]{1,240}[a-z0-9]$/i.test(args.hostname) || args.hostname.includes('..')) {
    throw new Error('Provide a DNS hostname via --hostname');
  }
  const port = Number(args.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Provide a local control port via --port');

  const yaml = [
    '# Airodrom WhatsApp webhook-only ingress — NOT activated by this script.',
    '# Forward only GET|POST /webhooks/whatsapp. All other paths return 404.',
    '# httpHostHeader keeps the loopback Host gate (127.0.0.1:<port>); Control Center/API stay private.',
    '# Do not reuse the ChatGPT MCP stdio tunnel helper under scripts/macos/.',
    'ingress:',
    `  - hostname: ${args.hostname}`,
    '    path: /webhooks/whatsapp',
    `    service: http://127.0.0.1:${port}`,
    '    originRequest:',
    `      httpHostHeader: 127.0.0.1:${port}`,
    '  - service: http_status:404',
    ''
  ].join('\n');

  const plan = {
    public_ingress: false,
    activated: false,
    hostname: args.hostname,
    path: '/webhooks/whatsapp',
    local_service: `http://127.0.0.1:${port}`,
    exposes_control_plane: false,
    exposes_mcp: false,
    mcp_tunnel_suitable: false,
    next: [
      'Owner-authorize named tunnel / DNS for the hostname.',
      'Apply this ingress without exposing /api, /mcp, /hub, or /workspace.',
      'POST /api/assistant/whatsapp/inbound/prepare-callback with https://' + args.hostname + '/webhooks/whatsapp',
      'Bind Vault whatsapp secrets; then authorize Meta webhook subscription separately.'
    ]
  };

  if (args.write) {
    const dir = path.resolve(args.write);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, 'whatsapp-webhook-only.cloudflared.yml');
    fs.writeFileSync(file, yaml, { mode: 0o600 });
    fs.writeFileSync(path.join(dir, 'whatsapp-webhook-ingress-plan.json'), JSON.stringify(plan, null, 2) + '\n', { mode: 0o600 });
    console.log('Wrote webhook-only ingress plan under ' + dir);
    console.log('public_ingress remains false; no tunnel was started.');
    return 0;
  }

  process.stdout.write(yaml);
  process.stdout.write('\n' + JSON.stringify(plan, null, 2) + '\n');
  return 0;
}

if (require.main === module) {
  try { process.exitCode = main(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}

module.exports = { main };
