#!/usr/bin/env node
'use strict';
/**
 * Real PTY smoke: bracketed single-line paste must appear before Enter,
 * then submit once on Enter. Synthetic local service only — no live install.
 */
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const root = path.resolve(__dirname, '..');
const mark = path.join(os.tmpdir(), 'airodrom-paste-tty-submit-' + process.pid + '.log');
const runner = path.join(os.tmpdir(), 'airodrom-paste-tty-runner-' + process.pid + '.cjs');
try { fs.unlinkSync(mark); } catch { /* ignore */ }

fs.writeFileSync(runner, `
'use strict';
const fs = require('node:fs');
const local = require(${JSON.stringify(path.join(root, 'src/local-bootstrap.js'))});
const { interactive } = require(${JSON.stringify(path.join(root, 'src/interactive-cli.js'))});
const mark = ${JSON.stringify(mark)};
local.attach = async () => ({ default_runtime: 'opencode', nickname: 'Airo', healthy: true, protocol: 'airodrom-local-v1' });
local.start = local.attach;
local.request = async (_home, route, body) => {
  if (route === '/api/interactive/memory?query=name') return { items: [{ content: 'My name is Operator.', subject: 'name' }] };
  if (route === '/api/assistant/conversation/session') return { conversation_id: 'pty-session' };
  if (route === '/api/assistant/input') {
    fs.appendFileSync(mark, 'SUBMIT:' + body.message + '\\n');
    return { kind: 'chat', conversation_id: 'pty-session', turn_id: 't1' };
  }
  if (String(route).startsWith('/api/assistant/conversation?')) {
    return { state: 'completed', summary: 'PTY smoke answer.', conversation_id: 'pty-session', turn_id: 't1' };
  }
  return {};
};
interactive('synthetic', { input: process.stdin, output: process.stdout, env: { NO_COLOR: '1', TERM: 'xterm-256color' } })
  .then(() => process.exit(0))
  .catch(error => { console.error(error); process.exit(1); });
`);

const py = `
import os, pty, select, sys, time, subprocess
master, slave = pty.openpty()
env = os.environ.copy()
env['TERM'] = 'xterm-256color'
env['NO_COLOR'] = '1'
proc = subprocess.Popen([${JSON.stringify(process.execPath)}, '--experimental-sqlite', ${JSON.stringify(runner)}],
  stdin=slave, stdout=slave, stderr=subprocess.DEVNULL, env=env, close_fds=True)
os.close(slave)
buf = b''
deadline = time.time() + 15
def read_ready(timeout=0.2):
  global buf
  r, _, _ = select.select([master], [], [], timeout)
  if master in r:
    try: buf += os.read(master, 8192)
    except OSError: pass
def has_prompt():
  return b'You \\xe2\\x80\\xba' in buf or b'Operator \\xe2\\x80\\xba' in buf or b'You >' in buf
try:
  while time.time() < deadline and not has_prompt():
    read_ready()
  if not has_prompt():
    sys.stderr.write('NO_PROMPT:' + repr(buf[-600:]) + '\\n'); proc.kill(); sys.exit(2)
  # Single-line bracketed paste — must render before Enter
  os.write(master, b'\\x1b[200~Visible paste question\\x1b[201~')
  seen = False
  for _ in range(50):
    read_ready()
    if b'Visible paste question' in buf:
      seen = True
      break
  if not seen:
    sys.stderr.write('INVISIBLE:' + repr(buf[-800:]) + '\\n'); proc.kill(); sys.exit(3)
  mark = ${JSON.stringify(mark)}
  if os.path.exists(mark):
    sys.stderr.write('AUTO_SUBMIT\\n'); proc.kill(); sys.exit(4)
  os.write(master, b'\\r')
  for _ in range(60):
    read_ready()
    if b'PTY smoke answer' in buf: break
  text = open(mark).read() if os.path.exists(mark) else ''
  if 'SUBMIT:Visible paste question' not in text:
    sys.stderr.write('NO_SUBMIT:' + repr(text) + '\\n' + repr(buf[-800:]) + '\\n'); proc.kill(); sys.exit(5)
  if text.count('SUBMIT:') != 1:
    sys.stderr.write('DUP:' + repr(text) + '\\n'); proc.kill(); sys.exit(6)
  os.write(master, b'/quit\\r')
  for _ in range(30):
    read_ready()
    if proc.poll() is not None: break
  if proc.poll() is None: proc.kill()
  print('PTY_SMOKE_OK')
  sys.exit(0)
finally:
  try: os.close(master)
  except Exception: pass
`;

const child = spawn('python3', ['-c', py], { stdio: ['ignore', 'pipe', 'pipe'] });
let out = '', err = '';
child.stdout.on('data', c => { out += c; process.stdout.write(c); });
child.stderr.on('data', c => { err += c; process.stderr.write(c); });
child.on('exit', code => {
  try { fs.unlinkSync(runner); } catch { /* ignore */ }
  try { fs.unlinkSync(mark); } catch { /* ignore */ }
  if (code !== 0 || !out.includes('PTY_SMOKE_OK')) {
    console.error('TTY smoke failed', { code, err: err.slice(0, 1200) });
    process.exit(code || 1);
  }
  assert.match(out, /PTY_SMOKE_OK/);
});
