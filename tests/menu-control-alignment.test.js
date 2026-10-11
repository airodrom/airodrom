'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { expectedControl, readControlPath, assertMenuControlAligned, validateTree } = require('../scripts/macos/prepare-local-menu.cjs');

function writePlist(app, control) {
  const contents = path.join(app, 'Contents');
  fs.mkdirSync(path.join(contents, 'MacOS'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(contents, 'MacOS', 'AirodromMenu'), '#!/bin/sh\n', { mode: 0o700 });
  fs.writeFileSync(path.join(contents, 'Info.plist'), [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0"><dict>',
    '<key>CFBundleIdentifier</key><string>io.airodrom.local.menu</string>',
    '<key>AirodromControl</key><string>' + control + '</string>',
    '</dict></plist>\n',
  ].join('\n'), { mode: 0o600 });
}

test('expectedControl points at this installation product-control', () => {
  const control = expectedControl();
  assert.equal(control, path.join(require('../src/local-bootstrap').ROOT, 'scripts/macos/product-control.cjs'));
  assert.equal(fs.existsSync(control), true);
});

test('assertMenuControlAligned accepts matching control path and rejects drift', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'airodrom-menu-align-'));
  const app = path.join(home, 'menu', 'Airodrom.app');
  const root = path.join(home, 'install-root');
  const control = path.join(root, 'scripts/macos/product-control.cjs');
  fs.mkdirSync(path.dirname(control), { recursive: true, mode: 0o700 });
  fs.writeFileSync(control, "'use strict';\n", { mode: 0o600 });
  writePlist(app, control);
  validateTree(app);
  assert.deepEqual(assertMenuControlAligned(home, root), { app, control, aligned: true });
  assert.equal(readControlPath(app), control);
  const drifted = path.join(home, 'other-install', 'scripts/macos/product-control.cjs');
  writePlist(app, drifted);
  assert.throws(() => assertMenuControlAligned(home, root), /different installation/);
});
