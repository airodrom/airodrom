#!/usr/bin/env node
'use strict';
/**
 * Real PTY smoke: /research explore against a standing approved origin must
 * skip the interactive permission prompt, avoid null-signal crashes, dispatch
 * exactly once, and print the completed research report. Synthetic service only.
 */
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const root = path.resolve(__dirname, '..');
const mark = path.join(os.tmpdir(), 'airodrom-research-pty-' + process.pid + '.log');
const runner = path.join(os.tmpdir(), 'airodrom-research-pty-runner-' + process.pid + '.cjs');
try { fs.unlinkSync(mark); } catch { /* ignore */ }

fs.writeFileSync(runner, `
'use strict';
const fs = require('node:fs');
const local = require(${JSON.stringify(path.join(root, 'src/local-bootstrap.js'))});
const { interactive } = require(${JSON.stringify(path.join(root, 'src/interactive-cli.js'))});
const mark = ${JSON.stringify(mark)};
const missionId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
let researchPosts = 0;
let polls = 0;
local.attach = async () => ({ default_runtime: 'opencode', nickname: 'Airo', healthy: true, protocol: 'airodrom-local-v1' });
local.start = local.attach;
local.isStopped = () => false;
local.request = async (_home, route, body) => {
  const line = 'ROUTE:' + route + (body && body.confirmed === true ? ':confirmed' : '') + '\\n';
  fs.appendFileSync(mark, line);
  if (route === '/api/interactive/memory?query=name') return { items: [{ content: 'My name is Operator.', subject: 'name' }] };
  if (route === '/api/assistant/conversation/session') return { conversation_id: 'pty-research-session' };
  if (route === '/api/assistant/risk-acceptance') {
    return { preference: { enabled: true, standing_public_origins: ['https://arecibo.ca'], owner_set: true } };
  }
  if (route === '/api/assistant/web/research') {
    researchPosts++;
    fs.appendFileSync(mark, 'RESEARCH_POST:' + researchPosts + ':confirmed=' + String(body?.confirmed) + '\\n');
    if (body?.confirmed === true) fs.appendFileSync(mark, 'CLIENT_CONFIRMED\\n');
    return {
      kind: 'mission',
      mission_id: missionId,
      state: 'dispatching',
      browser_research_available: true,
      message: 'Bounded public website research is registered and dispatch has started.'
    };
  }
  if (String(route).startsWith('/api/interactive/task')) {
    polls++;
    if (polls < 2) return { state: 'running', mission_id: missionId };
    return { state: 'completed', mission_id: missionId, summary: 'Synthetic research complete.' };
  }
  if (String(route).startsWith('/api/assistant/research/report')) {
    fs.appendFileSync(mark, 'REPORT\\n');
    return {
      kind: 'research_report',
      mission_id: missionId,
      markdown: '# arecibo.ca — public website research\\n\\nSynthetic observed homepage.\\n',
      authority: false
    };
  }
  if (route === '/api/interactive/cancel') {
    fs.appendFileSync(mark, 'CANCEL\\n');
    return { cancelled: true };
  }
  return {};
};
interactive('synthetic', { input: process.stdin, output: process.stdout, env: { NO_COLOR: '1', TERM: 'xterm-256color' } })
  .then(() => process.exit(0))
  .catch(error => {
    fs.appendFileSync(mark, 'ERROR:' + String(error && error.message || error) + '\\n');
    console.error(error);
    process.exit(1);
  });
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
deadline = time.time() + 25
def read_ready(timeout=0.2):
  global buf
  r, _, _ = select.select([master], [], [], timeout)
  if master in r:
    try: buf += os.read(master, 8192)
    except OSError: pass
def has_prompt():
  return b'You \\xe2\\x80\\xba' in buf or b'Operator \\xe2\\x80\\xba' in buf or b'You >' in buf or b'Operator >' in buf
try:
  while time.time() < deadline and not has_prompt():
    read_ready()
  if not has_prompt():
    sys.stderr.write('NO_PROMPT:' + repr(buf[-800:]) + '\\n'); proc.kill(); sys.exit(2)
  os.write(master, b'/research explore https://arecibo.ca/\\r')
  for _ in range(120):
    read_ready()
    if b'Synthetic observed homepage' in buf or b'Cannot read properties of null' in buf or b'PUBLIC WEB PERMISSION' in buf:
      break
  text = buf.decode('utf-8', 'replace')
  mark = ${JSON.stringify(mark)}
  log = open(mark).read() if os.path.exists(mark) else ''
  if 'Cannot read properties of null' in text or 'reading \\'signal\\'' in text or 'reading "signal"' in text:
    sys.stderr.write('NULL_SIGNAL:' + repr(text[-1200:]) + '\\n' + log + '\\n'); proc.kill(); sys.exit(3)
  if 'PUBLIC WEB PERMISSION' in text or 'Approve this public web scope' in text:
    sys.stderr.write('PROMPT:' + repr(text[-1200:]) + '\\n' + log + '\\n'); proc.kill(); sys.exit(4)
  if 'CLIENT_CONFIRMED' in log:
    sys.stderr.write('CLIENT_CONFIRMED\\n' + log + '\\n'); proc.kill(); sys.exit(5)
  if log.count('RESEARCH_POST:') != 1:
    sys.stderr.write('DISPATCH:' + repr(log) + '\\n'); proc.kill(); sys.exit(6)
  if 'REPORT' not in log and 'Synthetic observed homepage' not in text:
    sys.stderr.write('NO_REPORT:' + repr(text[-1200:]) + '\\n' + log + '\\n'); proc.kill(); sys.exit(7)
  if 'CANCEL' in log:
    sys.stderr.write('CANCELLED\\n' + log + '\\n'); proc.kill(); sys.exit(8)
  if 'ERROR:' in log:
    sys.stderr.write('RUNNER_ERROR\\n' + log + '\\n'); proc.kill(); sys.exit(9)
  os.write(master, b'/quit\\r')
  for _ in range(40):
    read_ready()
    if proc.poll() is not None: break
  if proc.poll() is None: proc.kill()
  print('RESEARCH_PTY_SMOKE_OK')
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
  if (code !== 0 || !out.includes('RESEARCH_PTY_SMOKE_OK')) {
    console.error('Research PTY smoke failed', { code, err: err.slice(0, 2000) });
    process.exit(code || 1);
  }
  assert.match(out, /RESEARCH_PTY_SMOKE_OK/);
});
