'use strict';
// ADR 0051. Empirical sandbox containment proof.
//
// A Seatbelt profile is only a claim until a process inside it is observed failing to
// escape. This module runs a small Node canary under the exact profile shape the
// coding workers use (deny default; staged tree readable; literal allowed files
// writable; only one executable; network only to a host proxy port or an explicit
// loopback port) and records what happened. Every boundary is reported as PROVEN,
// FAILED or UNAVAILABLE; nothing is inferred from the profile text alone.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { randomUUID, createHash } = require('node:crypto');

const BOUNDARIES = Object.freeze([
  'allowed_file_write', 'allowed_file_read', 'denied_staged_file_write', 'outside_write', 'home_secret_read', 'ssh_key_read',
  'symlink_escape_read', 'shell_exec', 'keychain_cli_exec', 'external_tcp_connect', 'loopback_other_port_connect', 'metadata_endpoint_connect', 'proxy_port_connect',
]);

// The canary never prints file contents; only boolean outcomes and errno codes.
function canarySource() {
  return `'use strict';
const fs=require('node:fs'),net=require('node:net'),cp=require('node:child_process'),path=require('node:path');
const cfg=JSON.parse(process.argv[2]);const out={};
const tryFs=(name,fn)=>{try{fn();out[name]={ok:true};}catch(e){out[name]={ok:false,code:e.code||'ERR'};}};
tryFs('allowed_file_write',()=>fs.writeFileSync(cfg.allowed,'canary-write\\n'));
tryFs('allowed_file_read',()=>{const s=fs.readFileSync(cfg.readonly,'utf8');if(!s.length)throw Object.assign(Error('empty'),{code:'EMPTY'});});
tryFs('denied_staged_file_write',()=>fs.writeFileSync(cfg.readonly,'tamper\\n'));
tryFs('outside_write',()=>fs.writeFileSync(cfg.outside,'leak\\n'));
tryFs('home_secret_read',()=>fs.readFileSync(cfg.homeSecret));
tryFs('ssh_key_read',()=>fs.readFileSync(cfg.sshKey));
tryFs('symlink_escape_read',()=>fs.readFileSync(cfg.symlink));
const tryExec=(name,file,args)=>{const r=cp.spawnSync(file,args,{timeout:3000});out[name]=r.error?{ok:false,code:r.error.code||'ERR'}:{ok:r.status===0,status:r.status};};
tryExec('shell_exec','/bin/sh',['-c','echo escaped']);
tryExec('keychain_cli_exec','/usr/bin/security',['list-keychains']);
const tryConnect=(name,host,port)=>new Promise(resolve=>{const s=net.connect({host,port,family:4});const done=v=>{try{s.destroy();}catch{}out[name]=v;resolve();};s.setTimeout(2500,()=>done({ok:false,code:'TIMEOUT'}));s.once('connect',()=>done({ok:true}));s.once('error',e=>done({ok:false,code:e.code||'ERR'}));});
(async()=>{await tryConnect('external_tcp_connect','1.1.1.1',443);await tryConnect('loopback_other_port_connect','127.0.0.1',cfg.otherPort);await tryConnect('metadata_endpoint_connect','169.254.169.254',80);await tryConnect('proxy_port_connect','127.0.0.1',cfg.proxyPort);process.stdout.write(JSON.stringify(out));})();
`;
}

/**
 * Prove containment for a worker-shaped profile.
 * @param {object} options
 * @param {'cursor'|'opencode'|'generic'} [options.shape]
 * @param {number} [options.proxyPort] host proxy port the profile admits (cursor shape)
 * @returns {{status:'PROVEN'|'FAILED'|'UNAVAILABLE', platform, boundaries:object, sandbox_id, profile_sha256, reason?}}
 */
async function proveContainment({ shape = 'generic', proxyPort = null, loopbackPorts = null, node = process.execPath } = {}) {
  const sandboxId = randomUUID();
  if (process.platform !== 'darwin' || !fs.existsSync('/usr/bin/sandbox-exec')) {
    return { status: 'UNAVAILABLE', platform: process.platform, reason: 'sandbox_exec_unavailable', boundaries: Object.fromEntries(BOUNDARIES.map(b => [b, 'UNAVAILABLE'])), sandbox_id: sandboxId, profile_sha256: null };
  }
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'airodrom-containment-'))); fs.chmodSync(root, 0o700);
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'airodrom-containment-outside-'))); fs.chmodSync(outside, 0o700);
  const listeners = [];
  try {
    for (const d of ['workspace', 'state', 'home/.ssh', 'brief']) fs.mkdirSync(path.join(root, d), { recursive: true, mode: 0o700 });
    const allowed = path.join(root, 'workspace', 'allowed.txt'), readonly = path.join(root, 'workspace', 'readonly.txt');
    fs.writeFileSync(allowed, 'alpha\n', { mode: 0o600 });
    fs.writeFileSync(readonly, 'keep\n', { mode: 0o600 });
    const homeSecret = path.join(outside, 'home', '.cursor', 'auth.json');
    fs.mkdirSync(path.dirname(homeSecret), { recursive: true, mode: 0o700 });
    fs.writeFileSync(homeSecret, '{"canary":"not-a-real-credential"}\n', { mode: 0o600 });
    const sshKey = path.join(outside, 'home', '.ssh', 'id_ed25519');
    fs.mkdirSync(path.dirname(sshKey), { recursive: true, mode: 0o700 });
    fs.writeFileSync(sshKey, 'canary-not-a-key\n', { mode: 0o600 });
    const symlink = path.join(root, 'workspace', 'escape-link');
    fs.symlinkSync(homeSecret, symlink);
    const canary = path.join(root, 'brief', 'canary.js');
    fs.writeFileSync(canary, canarySource(), { mode: 0o400 });
    // A listener on another loopback port must stay unreachable; the proxy port (when given) reachable.
    const net = require('node:net');
    const other = net.createServer(() => {}); listeners.push(other);
    const otherPort = await listen(other);
    let proxy = proxyPort;
    if (shape === 'cursor' && !proxy) { const p = net.createServer(() => {}); listeners.push(p); proxy = await listen(p); }
    const { makeProfile, SECRET_COMPONENT_PATTERN } = require('./sandbox-policy');
    // The canary runtime's install prefix (bin/ and lib/) must be readable, like a worker's bundled runtime dir.
    const realNode = fs.realpathSync(node);
    const nodeDir = path.dirname(path.dirname(realNode));
    // Package-managed runtimes (Homebrew) link shared libraries from their prefix; the prefix is
    // read-only public code and does not weaken the secret/network/exec boundaries under test.
    const prefix = ['/opt/homebrew', '/usr/local'].find(p => realNode.startsWith(p + '/')) || null;
    let profile = makeProfile({
      readRoots: [root, nodeDir, ...(prefix ? [prefix] : []), '/System', '/usr/lib', '/usr/share', '/Library/Apple/System/Library', '/dev', '/private/var/db/timezone'],
      writeRoots: [path.join(root, 'state')],
      exactReadFiles: [fs.realpathSync(node)],
      protectedReadPatterns: [SECRET_COMPONENT_PATTERN],
      denyFork: true, allowForkWithExactExec: true, execPaths: [fs.realpathSync(node)],
      allowLoopbackNetwork: shape === 'opencode', loopbackPorts: shape === 'opencode' ? loopbackPorts : null,
    });
    if (shape === 'cursor') profile = profile.replace('(deny network*)', `(deny network* (require-not (remote ip "localhost:${proxy}")))\n(allow network-outbound (remote ip "localhost:${proxy}"))`);
    profile += `(allow file-write* (literal ${JSON.stringify(allowed)}))\n`;
    const cfg = { allowed, readonly, outside: path.join(outside, 'leak.txt'), homeSecret, sshKey, symlink, otherPort, proxyPort: proxy || 1 };
    const r = spawnSync('/usr/bin/sandbox-exec', ['-p', profile, fs.realpathSync(node), canary, JSON.stringify(cfg)], { cwd: path.join(root, 'workspace'), encoding: 'utf8', timeout: 20000, env: { PATH: '/usr/bin:/bin', HOME: path.join(root, 'home'), TMPDIR: path.join(root, 'state') } });
    if (r.error || r.status !== 0 && !r.stdout) return { status: 'UNAVAILABLE', platform: 'darwin', reason: 'canary_did_not_run:' + (r.error?.code || r.status || r.signal) + ':' + String(r.stderr || '').replace(/\s+/g, ' ').slice(0, 300), boundaries: Object.fromEntries(BOUNDARIES.map(b => [b, 'UNAVAILABLE'])), sandbox_id: sandboxId, profile_sha256: createHash('sha256').update(profile).digest('hex') };
    let observed; try { observed = JSON.parse(r.stdout.trim().split('\n').pop()); } catch { return { status: 'UNAVAILABLE', platform: 'darwin', reason: 'canary_output_unreadable', boundaries: Object.fromEntries(BOUNDARIES.map(b => [b, 'UNAVAILABLE'])), sandbox_id: sandboxId, profile_sha256: createHash('sha256').update(profile).digest('hex') }; }
    // Expected outcomes: allowed operations succeed; every escape fails.
    // Deployed OpenCode shape allows any loopback port (its private server); cursor admits only the proxy port.
    const expectOk = new Set(['allowed_file_write', 'allowed_file_read', ...(shape === 'cursor' ? ['proxy_port_connect'] : []), ...(shape === 'opencode' && !loopbackPorts ? ['loopback_other_port_connect', 'proxy_port_connect'] : [])]);
    const boundaries = {};
    for (const b of BOUNDARIES) {
      const o = observed[b];
      if (!o) { boundaries[b] = 'UNAVAILABLE'; continue; }
      if (b === 'proxy_port_connect' && shape !== 'cursor') { boundaries[b] = 'NOT_APPLICABLE'; continue; }
      boundaries[b] = expectOk.has(b) ? (o.ok ? 'PROVEN' : 'FAILED') : (o.ok ? 'FAILED' : 'PROVEN');
    }
    // The allowed write must have landed and nothing else may have changed on disk.
    const landed = fs.readFileSync(allowed, 'utf8') === 'canary-write\n';
    const leaked = fs.existsSync(path.join(outside, 'leak.txt')) || fs.readFileSync(readonly, 'utf8') !== 'keep\n';
    if (!landed) boundaries.allowed_file_write = 'FAILED';
    if (leaked) { boundaries.outside_write = fs.existsSync(path.join(outside, 'leak.txt')) ? 'FAILED' : boundaries.outside_write; boundaries.denied_staged_file_write = fs.readFileSync(readonly, 'utf8') !== 'keep\n' ? 'FAILED' : boundaries.denied_staged_file_write; }
    const failed = Object.entries(boundaries).filter(([, v]) => v === 'FAILED').map(([k]) => k);
    const unavailable = Object.entries(boundaries).filter(([, v]) => v === 'UNAVAILABLE').map(([k]) => k);
    return {
      status: failed.length ? 'FAILED' : unavailable.length ? 'PARTIAL' : 'PROVEN', platform: 'darwin', shape, boundaries, failed, unavailable,
      errno: Object.fromEntries(Object.entries(observed).map(([k, v]) => [k, v.ok ? 'ok' : (v.code || v.status || 'denied')])),
      sandbox_id: sandboxId, profile_sha256: createHash('sha256').update(profile).digest('hex'), proven_at: Date.now(), authority: false,
    };
  } finally {
    for (const l of listeners) { try { l.close(); } catch { /* closed */ } }
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
}

function listen(server) {
  return new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve(server.address().port)); });
}

module.exports = { proveContainment, canarySource, BOUNDARIES };
