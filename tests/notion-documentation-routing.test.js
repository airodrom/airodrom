'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { resolvePublishParent, normalizeId } = require('../src/notion-documentation-routing');

const config = JSON.parse(fs.readFileSync(path.join(__dirname, '../config/notion-documentation-v1.json'), 'utf8'));

test('verified Airodrom hub is the only allowed publish parent', () => {
  const result = resolvePublishParent(config);
  assert.equal(result.ok, true);
  assert.equal(result.product, 'Airodrom');
  assert.equal(result.parent_page_id, normalizeId(config.hub.page_id));
  assert.equal(result.documentation_sync_is_not_shipped, true);
});

test('historical Pi Bridge hub is refused', () => {
  assert.throws(
    () => resolvePublishParent(config, { parent_page_id: '3ef593eead7481d79081dab81405a34f' }),
    /Pi Bridge|forbidden/i
  );
});

test('missing or unverified hub fails closed', () => {
  assert.throws(
    () => resolvePublishParent({ ...config, hub: { ...config.hub, page_id: '' } }),
    /not established|refused/i
  );
  assert.throws(
    () => resolvePublishParent({ ...config, rules: { ...config.rules, require_verified_airodrom_hub: false } }),
    /ownership rules|refused/i
  );
  assert.throws(
    () => resolvePublishParent(config, { parent_page_id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }),
    /not the verified Airodrom/i
  );
});

test('owned page IDs remain distinct and non-Pi-Bridge', () => {
  const hub = normalizeId(config.hub.page_id);
  const pi = normalizeId('3ef593eead7481d79081dab81405a34f');
  assert.notEqual(hub, pi);
  for (const page of config.owned_pages) {
    const id = normalizeId(page.page_id);
    assert.equal(id.length, 32);
    assert.notEqual(id, pi);
    assert.notEqual(id, hub);
  }
});
