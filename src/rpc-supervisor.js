'use strict';
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { randomUUID } = require('node:crypto');
const { StringDecoder } = require('node:string_decoder');
const path = require('node:path');
const { normalizeProbeText } = require('./worker-sandbox');
const { redact } = require('./chatgpt-events');
const ALLOWED = new Set(['prompt', 'abort', 'get_state', 'get_messages', 'get_session_stats', 'get_entries']);
const EXIT_STDERR_LIMIT = 2000;
const SAFE_BASENAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SAFE_PACKAGE = /^(?:@([A-Za-z0-9][A-Za-z0-9._-]{0,63})\/)?([A-Za-z0-9][A-Za-z0-9._-]{0,127})(?:\/[A-Za-z0-9][A-Za-z0-9._-]{0,127})*$/;

function safeBasename(value) {
  const base = path.basename(value.split(/[?#]/, 1)[0]);
  return SAFE_BASENAME.test(base) ? base : null;
}

function stderrText(value) {
  return Buffer.isBuffer(value) ? value.toString('utf8') : typeof value === 'string' ? value : value == null ? '' : String(value);
}

function missingModule(value) {
  const stderr = stderrText(value);
  if (!/\bERR_MODULE_NOT_FOUND\b/.test(stderr)) return null;
  const match = stderr.match(/Cannot find (?:module|package)\s+['"`]([^'"`\r\n]+)['"`]/i);
  if (!match || match[1].length > 1024) return null;
  const candidate = match[1];
  if (candidate.startsWith('/')) return safeBasename(candidate);
  if (candidate.startsWith('file://')) {
    try {
      const url = new URL(candidate);
      return url.protocol === 'file:' ? safeBasename(decodeURIComponent(url.pathname)) : null;
    } catch { return null; }
  }
  const packageMatch = candidate.match(SAFE_PACKAGE);
  if (!packageMatch) return null;
  return packageMatch[1] ? `@${packageMatch[1]}/${packageMatch[2]}` : packageMatch[2];
}

function exitError(code, signal, stderr) {
  const exit = `Pi exited (${code ?? signal ?? 'unknown'})`;
  const module = missingModule(stderr);
  const diagnostic = redact(normalizeProbeText(redact(stderrText(stderr)), EXIT_STDERR_LIMIT));
  const bounded = diagnostic.length > EXIT_STDERR_LIMIT ? `${diagnostic.slice(0, EXIT_STDERR_LIMIT)}…[truncated]` : diagnostic;
  return new Error(`${exit}${module ? `; missingModule=${module}` : ''}${bounded.trim() ? `: ${bounded}` : ''}`);
}

class PiRpcSupervisor extends EventEmitter {
  constructor({ executable, args, cwd, env, requestTimeoutMs = 15000, sandboxExec = null, sandboxProfile = null, allowUnsandboxedTestFixture = false } = {}) {
    super(); Object.assign(this, { executable, args, cwd, env, requestTimeoutMs, sandboxExec, sandboxProfile, allowUnsandboxedTestFixture });
    this.pending = new Map(); this.running = false; this.stderr = ''; this.stopping = null;
  }
  async start() {
    if ((!this.sandboxExec || !this.sandboxProfile) && !this.allowUnsandboxedTestFixture) throw new Error('Pi worker sandbox is required; refusing an unsandboxed launch');
    const executable = this.sandboxExec && this.sandboxProfile ? this.sandboxExec : this.executable;
    const args = this.sandboxExec && this.sandboxProfile ? ['-f', this.sandboxProfile, this.executable, ...this.args] : this.args;
    this.child = spawn(executable, args, { cwd: this.cwd, env: this.env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.running = true;
    let buffer = ''; const decoder = new StringDecoder('utf8');
    this.child.stdout.on('data', data => {
      buffer += decoder.write(data);
      if (Buffer.byteLength(buffer) > 16 * 1024 * 1024) return this.fail(new Error('Pi protocol record exceeded limit'));
      let at;
      while ((at = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, at).replace(/\r$/, ''); buffer = buffer.slice(at + 1);
        if (!line) continue;
        let record;
        try { record = JSON.parse(line); } catch { this.fail(new Error('Invalid Pi JSONL')); return; }
        if (!record || typeof record !== 'object' || Array.isArray(record) || typeof record.type !== 'string') { this.fail(new Error('Invalid Pi protocol record')); return; }
        if (record.type === 'response') {
          const p = this.pending.get(record.id);
          if (p) { this.pending.delete(record.id); clearTimeout(p.timer); record.success ? p.resolve(record.data ?? {}) : p.reject(new Error(record.error || 'Pi command rejected')); }
        } else this.emit('event', record);
      }
    });
    this.child.stderr.on('data', d => { this.stderr = (this.stderr + d.toString()).slice(-8000); });
    this.child.stdin.on('error', e => this.fail(e));
    this.child.on('error', e => { this.running = false; this.fail(e); });
    this.child.on('close', (code, signal) => { this.running = false; this.rejectPending(exitError(code, signal, this.stderr)); this.emit('exit', { code, signal }); });
    return this.sendCommand({ type: 'get_state' });
  }
  rejectPending(error) { for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); } this.pending.clear(); }
  _signalWorkerGroup(signal, child = this.child) {
    if (!child?.pid) return;
    try { process.kill(-child.pid, signal); }
    catch { try { child.kill(signal); } catch {} }
  }

  _workerStillAlive(child = this.child) {
    const pid = child?.pid;
    if (!pid) return false;

    const alive = target => {
      try { process.kill(target, 0); return true; }
      catch (error) {
        if (error?.code === 'EPERM') return true;
        if (error?.code === 'ESRCH') return false;
        return true;
      }
    };

    return alive(-pid) || alive(pid);
  }
  fail(error) { this.rejectPending(error); this.emit('fault', error); this._signalWorkerGroup('SIGTERM'); }
  sendCommand(command) {
    if (!command || !ALLOWED.has(command.type)) return Promise.reject(new Error(`RPC command is not allowed: ${command?.type}`));
    if (!this.running || !this.child?.stdin.writable) return Promise.reject(new Error('Pi is not running'));
    // Never forward arbitrary command fields supplied by a caller.
    const record = { id: randomUUID(), type: command.type };
    if (command.type === 'prompt') {
      if (typeof command.message !== 'string' || !command.message.trim() || command.message.length > 64000 || /^\s*[/!@]/.test(command.message)) return Promise.reject(new Error('Invalid plain-text prompt'));
      record.message = command.message;
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(record.id); reject(new Error(`Pi ${command.type} response timed out`)); }, this.requestTimeoutMs);
      this.pending.set(record.id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify(record) + '\n', e => { if (e) { clearTimeout(timer); this.pending.delete(record.id); reject(e); } });
    });
  }
  async shutdown() {
    if (this.stopping) return this.stopping;

    this.stopping = (async () => {
      const child = this.child;

      // Stop admitting new RPC and immediately settle anything awaiting a
      // response, including the get_state request used by start().
      this.running = false;
      this.rejectPending(new Error('Pi shutdown requested'));

      if (!child?.pid) return;

      await new Promise((resolve, reject) => {
        let settled = false;
        let termTimer;
        let killTimer;
        let verifyTimer;

        const cleanup = () => {
          clearTimeout(termTimer);
          clearTimeout(killTimer);
          clearTimeout(verifyTimer);
          child.off('close', onClose);
        };

        const finish = () => {
          if (settled) return;
          settled = true;
          cleanup();
          if (this.child === child) this.child = null;
          resolve();
        };

        const fail = error => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(error);
        };

        const onClose = () => finish();
        child.once('close', onClose);

        try {
          if (child.stdin?.writable) child.stdin.end();
        } catch {}

        // Give normal EOF shutdown a short grace period, then escalate.
        termTimer = setTimeout(() => this._signalWorkerGroup('SIGTERM', child), 250);
        killTimer = setTimeout(() => this._signalWorkerGroup('SIGKILL', child), 3000);

        // Never wait forever for a missing close event. Only resolve without
        // close when both the process group and direct child are proven gone.
        verifyTimer = setTimeout(() => {
          if (!this._workerStillAlive(child)) return finish();
          fail(new Error('Pi worker termination could not be verified after SIGKILL'));
        }, 4500);
      });
    })();

    try {
      return await this.stopping;
    } finally {
      this.stopping = null;
    }
  }
}
module.exports = PiRpcSupervisor;
