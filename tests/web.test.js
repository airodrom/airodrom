'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { createHash } = require('node:crypto');
const tls = require('node:tls');
const WebReader = require('../src/web-reader');
const context = { taskId: 'task-one', sessionId: 'session-one' };
const public4 = { address: '93.184.216.34', family: 4 };
const public6 = { address: '2606:4700:4700::1111', family: 6 };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

function transport(steps = [{}]) {
  const calls = [];
  const request = (options, callback) => {
    const step = steps[Math.min(calls.length, steps.length - 1)];
    if (step.throw) throw new Error(step.throw);
    const req = new EventEmitter(); req.destroyed = false;
    let res;
    req.destroy = () => { req.destroyed = true; res?.destroy(); return req; };
    req.end = () => queueMicrotask(() => {
      if (req.destroyed || step.hangHeaders) return;
      if (step.error) return req.emit('error', new Error(step.error));
      if (step.upgrade) {
        const socket = { destroyed: false, destroy() { this.destroyed = true; } };
        calls[calls.length - 1].upgradeSocket = socket;
        return req.emit('upgrade', {}, socket);
      }
      res = new PassThrough(); res.complete = false; res.statusCode = step.status || 200;
      res.headers = { 'content-type': 'text/plain; charset=utf-8', ...step.headers };
      callback(res);
      if (req.destroyed) return;
      for (const chunk of step.chunks || [step.body || 'Public text']) { if (!req.destroyed) res.write(chunk); }
      if (step.responseError) return res.emit('error', new Error(step.responseError));
      if (step.hangBody) return;
      res.complete = !step.incomplete; res.end();
    });
    calls.push({ options, req });
    return req;
  };
  return { request, calls };
}

function reader(options = {}, steps) {
  const wire = transport(steps);
  return { web: new WebReader({ allowedHosts: ['example.com', 'nodejs.org'], lookup: async () => [public4], request: wire.request, ...options }), ...wire };
}

test('URL policy canonicalizes exact HTTPS hosts and rejects authorization and parser tricks', () => {
  const { web } = reader();
  assert.equal(web.validate({ url: 'HTTPS://EXAMPLE.COM:443/a/../docs', method: 'HEAD' }), 'https://example.com/docs');
  const rejected = ['http://example.com', '//example.com', 'https://evil.com', 'https://example.com.evil.com', 'https://sub.example.com', 'https://example.com.', 'https://example.com:444', 'https://user:pass@example.com', 'https://@example.com', 'https://example.com/?x=1', 'https://example.com/?', 'https://example.com/#x', 'https://example.com/\\evil', ' https://example.com/', 'https://example.com/\nfoo', 'https://example.com/%0d%0aX', 'https://example.com/%5cfoo', 'https://127.0.0.1', 'https://2130706433', 'https://0x7f000001', 'https://127.1', 'https://[::ffff:127.0.0.1]', 'https://exаmple.com'];
  for (const url of rejected) assert.throws(() => web.validate({ url }), undefined, url);
  for (const input of [{ url: 'https://example.com', method: 'POST' }, { url: 'https://example.com', headers: {} }, { url: 'https://example.com', body: 'secret' }]) assert.throws(() => web.validate(input));
  assert.throws(() => new WebReader({ allowedHosts: ['*.example.com'] }));
});

test('disabled, unauthorized and missing-provenance reads cannot reach DNS', async () => {
  let lookups = 0;
  const { web } = reader({ enabled: false, lookup: async () => { lookups++; return [public4]; } });
  await assert.rejects(web.fetch({ url: 'https://example.com' }, context), /disabled/);
  web.enabled = true;
  await assert.rejects(web.fetch({ url: 'https://evil.com' }, context), /allowlisted/);
  await assert.rejects(web.fetch({ url: 'https://example.com' }), /provenance/);
  assert.equal(lookups, 0); assert.equal(web.status().active, 0); assert.ok(web.status().lastError);
});

test('DNS rejects private, local, reserved and translated addresses in either family', async () => {
  const blocked = [
    ['0.0.0.0', 4], ['10.1.2.3', 4], ['100.100.100.200', 4], ['127.0.0.1', 4], ['169.254.169.254', 4], ['172.31.0.1', 4], ['192.0.0.1', 4], ['192.0.2.1', 4], ['192.88.99.1', 4], ['192.168.1.1', 4], ['198.18.1.1', 4], ['198.51.100.1', 4], ['203.0.113.1', 4], ['224.0.0.1', 4], ['255.255.255.255', 4],
    ['::', 6], ['::1', 6], ['::ffff:127.0.0.1', 6], ['::ffff:93.184.216.34', 6], ['64:ff9b::a00:1', 6], ['fc00::1', 6], ['fe80::1', 6], ['ff02::1', 6], ['2001::1', 6], ['2001:db8::1', 6], ['2002:7f00:1::', 6], ['3ffe::1', 6], ['3fff::1', 6], ['2606:4700::1%en0', 6]
  ];
  for (const [address, family] of blocked) {
    const { web, calls } = reader({ lookup: async () => [{ address, family }] });
    await assert.rejects(web.fetch({ url: 'https://example.com' }, context), /public addresses/, address);
    assert.equal(calls.length, 0);
  }
});

test('all DNS answers must be valid and public, including mixed and empty results', async () => {
  for (const answers of [[], [public4, { address: '10.0.0.1', family: 4 }], [{ address: public4.address, family: 6 }], [null], { address: public4.address, family: 4 }]) {
    const { web, calls } = reader({ lookup: async () => answers });
    await assert.rejects(web.fetch({ url: 'https://example.com' }, context), /public addresses/); assert.equal(calls.length, 0);
  }
});

test('connection uses the pinned public address and original hostname TLS verification', async () => {
  for (const address of [public4, public6]) {
    let lookups = 0;
    const body = Buffer.from('Public snowman ☃');
    const { web, calls } = reader({ lookup: async (host, options) => { lookups++; assert.equal(host, 'example.com'); assert.equal(options.all, true); return [address]; } }, [{ chunks: [body.subarray(0, body.length - 1), body.subarray(body.length - 1)] }]);
    const result = await web.fetch({ url: 'https://example.com/docs' }, context);
    const options = calls[0].options;
    assert.equal(lookups, 1); assert.equal(options.hostname, 'example.com'); assert.equal(options.servername, 'example.com');
    assert.equal(options.rejectUnauthorized, true); assert.equal(options.checkServerIdentity, tls.checkServerIdentity);
    assert.equal(options.family, address.family); assert.equal(options.autoSelectFamily, false); assert.equal(options.agent, false);
    assert.equal(options.port, 443); assert.equal(options.path, '/docs'); assert.equal(options.headers['Accept-Encoding'], 'identity');
    for (const key of ['Authorization', 'Cookie', 'Referer', 'Host']) assert.equal(options.headers[key], undefined);
    await new Promise((resolve, reject) => options.lookup('example.com', {}, (error, ip, family) => { if (error) return reject(error); assert.equal(ip, address.address); assert.equal(family, address.family); resolve(); }));
    await new Promise((resolve, reject) => options.lookup('example.com', { all: true }, (error, records) => { if (error) return reject(error); assert.deepEqual(records, [address]); resolve(); }));
    assert.equal(result.text, 'Public snowman ☃'); assert.equal(result.provenance.untrusted, true); assert.equal(result.provenance.taskId, context.taskId);
    assert.equal(result.provenance.sha256, createHash('sha256').update(body).digest('hex')); assert.equal(web.status().active, 0);
  }
});

test('safe redirects preserve provenance and do not replay cookies; HEAD returns no body', async () => {
  const { web, calls } = reader({}, [{ status: 302, headers: { location: '/docs', 'set-cookie': 'private=value' } }, { body: 'Public docs' }]);
  const result = await web.fetch({ url: 'https://example.com' }, context);
  assert.equal(calls.length, 2); assert.equal(result.provenance.finalUrl, 'https://example.com/docs'); assert.equal(result.provenance.redirectChain.length, 1);
  assert.equal(calls[0].req.destroyed, true); assert.equal(calls[1].options.headers.Cookie, undefined);
  const head = reader({}, [{ chunks: [] }]);
  const response = await head.web.fetch({ url: 'https://example.com', method: 'HEAD' }, context);
  assert.equal(response.text, ''); assert.equal(response.provenance.bytes, 0); assert.equal(head.calls[0].options.method, 'HEAD');
});

test('redirects cannot bypass host, address, query, scheme or hop restrictions', async () => {
  for (const location of ['http://example.com', 'https://evil.com', 'https://127.0.0.1', '/?secret=data', '/#frag', '/\\evil', 'https://user@example.com', 'https://example.com/']) {
    const { web, calls } = reader({}, [{ status: 302, headers: { location } }]);
    await assert.rejects(web.fetch({ url: 'https://example.com/' }, context)); assert.equal(calls.length, 1);
  }
  let resolves = 0;
  const rebinding = reader({ lookup: async () => ++resolves === 1 ? [public4] : [{ address: '127.0.0.1', family: 4 }] }, [{ status: 302, headers: { location: '/next' } }]);
  await assert.rejects(rebinding.web.fetch({ url: 'https://example.com' }, context), /public addresses/); assert.equal(rebinding.calls.length, 1);
  const hops = reader({}, ['/one', '/two', '/three', '/four'].map(location => ({ status: 302, headers: { location } })));
  await assert.rejects(hops.web.fetch({ url: 'https://example.com' }, context), /redirect limit/); assert.equal(hops.calls.length, 4);
});

test('byte, content type, charset, compression and completion limits fail closed', async () => {
  for (const step of [
    { headers: { 'content-length': '100' } }, { chunks: [Buffer.alloc(40), Buffer.alloc(40)] },
    { headers: { 'content-length': 'not-a-number' } }, { headers: { 'content-type': 'application/octet-stream' } },
    { headers: { 'content-type': 'text/html; charset=iso-8859-1' } }, { headers: { 'content-type': '' } },
    { headers: { 'content-encoding': 'gzip' } }, { incomplete: true }, { status: 401 }
  ]) {
    const { web, calls } = reader({ maxBytes: 64 }, [step]);
    await assert.rejects(web.fetch({ url: 'https://example.com' }, context)); assert.equal(calls[0].req.destroyed, true); assert.equal(web.status().active, 0);
  }
});

test('deadline covers DNS and stalled transfer, late DNS never makes a connection, cancellation stops transfer', async () => {
  let resolveDNS;
  const delayed = reader({ timeoutMs: 20, lookup: () => new Promise(resolve => { resolveDNS = resolve; }) });
  await assert.rejects(delayed.web.fetch({ url: 'https://example.com' }, context), /deadline/);
  resolveDNS([public4]); await wait(5); assert.equal(delayed.calls.length, 0);
  for (const step of [{ hangHeaders: true }, { hangBody: true }]) {
    const hanging = reader({ timeoutMs: 20 }, [step]);
    await assert.rejects(hanging.web.fetch({ url: 'https://example.com' }, context), /deadline/); assert.equal(hanging.calls[0].req.destroyed, true);
  }
  const cancelled = reader({}, [{ hangBody: true }]), controller = new AbortController();
  const fetching = cancelled.web.fetch({ url: 'https://example.com' }, { ...context, signal: controller.signal });
  const rejected = assert.rejects(fetching, /cancelled/);
  await wait(5); controller.abort(new Error('User cancelled'));
  await rejected; assert.equal(cancelled.calls[0].req.destroyed, true); assert.equal(cancelled.web.status().active, 0);
});

test('two-request limit applies across readers and releases slots on cancellation', async () => {
  const first = reader({}, [{ hangHeaders: true }]), second = reader({}, [{ hangHeaders: true }]), third = reader();
  const controllers = [new AbortController(), new AbortController()];
  const pending = [first, second].map((item, index) => item.web.fetch({ url: 'https://example.com' }, { ...context, signal: controllers[index].signal }));
  const rejections = pending.map(promise => assert.rejects(promise, /cancelled/));
  await assert.rejects(third.web.fetch({ url: 'https://example.com' }, context), /concurrency/);
  controllers.forEach(controller => controller.abort(new Error('Test cancelled'))); await Promise.all(rejections);
  assert.equal(first.web.status().active, 0); assert.equal(second.web.status().active, 0);
  assert.equal((await third.web.fetch({ url: 'https://example.com' }, context)).text, 'Public text');
});

test('HTML becomes bounded inert text with untrusted provenance and no subresource fetches', async () => {
  const source = '<html><!--hidden--><script>SECRET_SCRIPT</script><style>SECRET_STYLE</style><svg>SECRET_SVG</svg><p>Public &amp; useful &#9731;.</p><img src="https://evil.com/secret"><p>&lt;script&gt;inert text&lt;/script&gt;</p>' + 'extra '.repeat(30) + '</html>';
  const { web, calls } = reader({ maxChars: 70 }, [{ body: source, headers: { 'content-type': 'text/html' } }]);
  const result = await web.fetch({ url: 'https://example.com' }, context);
  assert.match(result.text, /Public & useful ☃/); assert.doesNotMatch(result.text, /SECRET_|hidden|evil\.com/);
  assert.match(result.text, /<script>inert text<\/script>/); assert.ok(result.text.length <= 70);
  assert.equal(result.provenance.truncated, true); assert.equal(result.provenance.untrusted, true); assert.equal(calls.length, 1);
});

test('request errors, response errors, abrupt close and upgrades terminate cleanly', async () => {
  for (const step of [{ error: 'TLS failed' }, { responseError: 'stream failed' }, { incomplete: true }, { upgrade: true }, { throw: 'construction failed' }]) {
    const { web, calls } = reader({}, [step]);
    await assert.rejects(web.fetch({ url: 'https://example.com' }, context)); assert.equal(web.status().active, 0); assert.ok(web.status().lastError);
    if (calls[0]?.upgradeSocket) assert.equal(calls[0].upgradeSocket.destroyed, true);
  }
});
