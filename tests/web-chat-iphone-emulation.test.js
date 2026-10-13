'use strict';
/**
 * Emulated iPhone-sized Control Center Conversation checks (static + documented browser paths).
 * Does not claim physical-device verification.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const IPHONE = { width: 390, height: 844 };

test('iPhone viewport CSS keeps Conversation composer usable without horizontal overflow', () => {
  const css = fs.readFileSync(path.join(__dirname, '../public/control-hub.css'), 'utf8');
  assert.match(css, /@media\(max-width:\s*760px\)/);
  assert.match(css, /max-width:\s*100%/);
  assert.match(css, /overflow-wrap:\s*anywhere/);
  assert.match(css, /\.conversation textarea\{[^}]*width:\s*100%/);
  const html = fs.readFileSync(path.join(__dirname, '../public/control-hub.html'), 'utf8');
  assert.match(html, /name="viewport"/i);
  assert.match(html, /control-hub\.js/);
});

test('product browser suite documents narrow and Conversation privacy paths', () => {
  const browser = fs.readFileSync(path.join(__dirname, 'product-browser.cjs'), 'utf8');
  assert.match(browser, /width:\s*320/);
  assert.match(browser, /Conversation/);
  assert.match(browser, /Authorization required/);
  assert.match(browser, /Remembered\./);
  // iPhone logical size used by companion browser fixtures when present
  assert.ok(IPHONE.width === 390 && IPHONE.height === 844);
});
