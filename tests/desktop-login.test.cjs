'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const desktop = require('../scripts/macos/desktop-login.cjs');

test('desktop login LaunchAgent plist is labeled, RunAtLoad, and not KeepAlive', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'airo-desktop-login-'));
  fs.chmodSync(home, 0o700);
  const dest = path.join(home, 'local.airodrom.desktop-login.plist');
  const written = desktop.writeAgent({
    node: process.execPath,
    control: path.join(home, 'desktop-login.cjs'),
    home,
    destination: dest,
    workingDirectory: home
  });
  assert.equal(written, dest);
  assert.equal(fs.statSync(dest).mode & 0o777, 0o600);
  const xml = fs.readFileSync(dest, 'utf8');
  assert.match(xml, /local\.airodrom\.desktop-login/);
  assert.match(xml, /<key>RunAtLoad<\/key><true\/>/);
  assert.match(xml, /<key>KeepAlive<\/key><false\/>/);
  assert.doesNotMatch(xml, /pi-chatgpt/);
  assert.equal(typeof desktop.ollamaReady(), 'boolean');
  fs.rmSync(home, { recursive: true, force: true });
});

test('desktop login module exports install/disable/status without legacy bridge labels', () => {
  assert.equal(typeof desktop.installAgent, 'function');
  assert.equal(typeof desktop.disableAgent, 'function');
  assert.equal(typeof desktop.uninstallAgent, 'function');
  assert.equal(typeof desktop.start, 'function');
  assert.equal(desktop.LABEL, 'local.airodrom.desktop-login');
});
