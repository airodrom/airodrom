'use strict';
// Local macOS OAuth browser handoff for operator Terminal only.
// Never log authorization URLs, state, codes, or tokens.
const fs = require('node:fs');
const { spawn } = require('node:child_process');

const OPEN = '/usr/bin/open';
const DEFAULT_TIMEOUT_MS = 15_000;
const AUTH_HOST = 'accounts.google.com';

const CODES = Object.freeze({
  OPENED: 'oauth_browser_opened',
  OPENER_UNAVAILABLE: 'oauth_browser_opener_unavailable',
  LAUNCH_ERROR: 'oauth_browser_launch_error',
  NONZERO_EXIT: 'oauth_browser_nonzero_exit',
  TIMEOUT: 'oauth_browser_launch_timed_out',
  NO_GUI: 'oauth_browser_no_graphical_session',
  INVALID_URL: 'oauth_browser_url_invalid',
});

function redact(value) {
  return String(value || '')
    .replace(/https:\/\/accounts\.google\.com\/[^\s"'\\]*/gi, 'https://accounts.google.com/[redacted]')
    .replace(/[?&](state|code|code_challenge|client_id)=[^&\s"'\\]*/gi, '&$1=[redacted]')
    .replace(/\b(?:ya29|ya29\.[A-Za-z0-9._-]+|token[=:]\s*\S+)/gi, '[redacted]')
    .replace(/[A-Za-z0-9_-]{16,}/g, '[redacted]')
    .slice(0, 240);
}

function assertAuthorizationUrl(url) {
  let parsed;
  try { parsed = new URL(String(url || '')); }
  catch {
    const err = Error('Authorization URL is invalid.');
    err.code = CODES.INVALID_URL;
    throw err;
  }
  if (parsed.protocol !== 'https:' || parsed.hostname !== AUTH_HOST) {
    const err = Error('Authorization URL host is not permitted for automatic browser launch.');
    err.code = CODES.INVALID_URL;
    throw err;
  }
  return parsed;
}

function openerAvailable(openPath = OPEN) {
  try {
    fs.accessSync(openPath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Best-effort local GUI signal. Absence is not authoritative alone —
 * LaunchServices may still succeed for the console user.
 */
function graphicalSessionHint(env = process.env, platform = process.platform) {
  if (platform !== 'darwin') return { available: false, code: CODES.NO_GUI };
  if (env.SSH_CONNECTION && !env.TERM_PROGRAM && !env.CURSOR_TRACE_ID && !env.VSCODE_PID) {
    return { available: false, code: CODES.NO_GUI, soft: true };
  }
  return { available: true };
}

/**
 * Hand the authorization URL to macOS LaunchServices without blocking the
 * interactive Terminal event loop. Success means opener handoff, not Gmail consent.
 *
 * @param {string} authorizationUrl
 * @param {{openPath?: string, timeoutMs?: number, spawnImpl?: typeof spawn,
 *   platform?: string, env?: NodeJS.ProcessEnv}} [options]
 */
function launchAuthorizationUrl(authorizationUrl, options = {}) {
  const openPath = options.openPath || OPEN;
  const timeoutMs = Number.isInteger(options.timeoutMs) && options.timeoutMs > 0
    ? Math.min(options.timeoutMs, 60_000) : DEFAULT_TIMEOUT_MS;
  const spawnImpl = options.spawnImpl || spawn;
  const platform = options.platform || process.platform;
  const env = options.env || process.env;

  try { assertAuthorizationUrl(authorizationUrl); }
  catch (error) {
    return Promise.resolve({
      ok: false,
      code: error.code || CODES.INVALID_URL,
      message: error.message,
    });
  }

  if (platform !== 'darwin') {
    return Promise.resolve({
      ok: false,
      code: CODES.NO_GUI,
      message: 'No accessible graphical session for automatic browser launch on this platform.',
    });
  }

  if (!openerAvailable(openPath)) {
    return Promise.resolve({
      ok: false,
      code: CODES.OPENER_UNAVAILABLE,
      message: 'Browser opener unavailable (/usr/bin/open is missing or not executable).',
    });
  }

  const gui = graphicalSessionHint(env, platform);

  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    let stderr = '';
    let child;
    let timer = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };

    try {
      child = spawnImpl(openPath, [authorizationUrl], {
        stdio: ['ignore', 'ignore', 'pipe'],
        env,
        shell: false,
      });
    } catch (error) {
      finish({
        ok: false,
        code: CODES.LAUNCH_ERROR,
        message: 'macOS LaunchServices could not start the browser opener.',
        detail: redact(error && error.message),
      });
      return;
    }

    timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGTERM'); } catch { /* already exited */ }
      finish({
        ok: false,
        code: CODES.TIMEOUT,
        message: 'Browser launch timed out waiting for macOS LaunchServices.',
      });
    }, timeoutMs);

    if (child.stderr) {
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => {
        stderr = (stderr + String(chunk)).slice(0, 400);
      });
    }

    child.on('error', (error) => {
      if (timedOut) return;
      const missing = error && error.code === 'ENOENT';
      finish({
        ok: false,
        code: missing ? CODES.OPENER_UNAVAILABLE : CODES.LAUNCH_ERROR,
        message: missing
          ? 'Browser opener unavailable.'
          : 'macOS LaunchServices error while opening the authorization page.',
        detail: redact(error && error.message),
      });
    });

    child.on('close', (status, signal) => {
      // Timeout path may kill the child synchronously; ignore the resulting close.
      if (timedOut) return;
      if (status === 0) {
        finish({
          ok: true,
          code: CODES.OPENED,
          message: 'Authorization page opened; waiting for operator consent in your browser.',
        });
        return;
      }
      const redacted = redact(stderr);
      const noGui = gui.available === false
        || /not allowed|LSNotAllowed|WindowServer|no user session|GUI/i.test(stderr);
      finish({
        ok: false,
        code: noGui ? CODES.NO_GUI : CODES.NONZERO_EXIT,
        message: noGui
          ? 'No accessible graphical session for automatic browser launch.'
          : 'macOS browser opener exited without opening the authorization page.',
        detail: redacted || undefined,
        status: status == null ? null : status,
        signal: signal || null,
      });
    });
  });
}

function recoveryMessage(result) {
  const base = result && result.message
    ? result.message
    : 'Automatic browser launch did not complete.';
  return base
    + ' No new OAuth session was started by the retry path.'
    + ' In this Terminal only: `/connect gmail retry-open` retries LaunchServices,'
    + ' or `/connect gmail show-local` prints the authorization URL locally'
    + ' (never sent to ChatGPT, Missions, or remote logs).'
    + ' Gmail is connected only after Google consent and the localhost callback succeed.';
}

module.exports = {
  launchAuthorizationUrl,
  recoveryMessage,
  redact,
  assertAuthorizationUrl,
  openerAvailable,
  graphicalSessionHint,
  CODES,
  OPEN,
  DEFAULT_TIMEOUT_MS,
  AUTH_HOST,
};
