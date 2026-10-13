'use strict';
// ADR 0051: empirical containment proof for the coding-worker sandbox shapes.
// On darwin these run real sandbox-exec canaries; elsewhere the result is UNAVAILABLE
// and the test records that honestly instead of inferring containment.
const test = require('node:test');
const assert = require('node:assert/strict');
const { proveContainment, BOUNDARIES } = require('../src/sandbox-containment');
const { makeProfile } = require('../src/sandbox-policy');

const darwin = process.platform === 'darwin' && require('node:fs').existsSync('/usr/bin/sandbox-exec');

test('loopback allowlist narrows the sandbox network exception to explicit ports', () => {
  const dir = require('node:os').tmpdir();
  const narrow = makeProfile({ readRoots: [dir], writeRoots: [], allowLoopbackNetwork: true, loopbackPorts: [11434] });
  assert.match(narrow, /\(allow network-outbound \(remote ip "localhost:11434"\)\)/);
  assert.doesNotMatch(narrow, /remote ip "localhost:\*"/);
  const wide = makeProfile({ readRoots: [dir], writeRoots: [], allowLoopbackNetwork: true });
  assert.match(wide, /remote ip "localhost:\*"/);
  assert.throws(() => makeProfile({ readRoots: [dir], writeRoots: [], allowLoopbackNetwork: true, loopbackPorts: [0] }), /Invalid loopback port allowlist/);
  const none = makeProfile({ readRoots: [dir], writeRoots: [] });
  assert.match(none, /\(deny network\*\)/);
});

test('cursor-shaped sandbox: every escape is denied empirically; only allowed file and proxy port succeed', { skip: !darwin && 'sandbox-exec unavailable on this platform' }, async () => {
  const proof = await proveContainment({ shape: 'cursor' });
  assert.equal(proof.status, 'PROVEN', JSON.stringify(proof));
  for (const b of BOUNDARIES) assert.equal(proof.boundaries[b], 'PROVEN', b + ': ' + JSON.stringify(proof.errno));
  assert.equal((await proveContainment({ shape: 'opencode' })).boundaries.proxy_port_connect, 'NOT_APPLICABLE');
  assert.equal(proof.errno.proxy_port_connect, 'ok');
  for (const b of ['outside_write', 'home_secret_read', 'ssh_key_read', 'symlink_escape_read', 'shell_exec', 'keychain_cli_exec', 'external_tcp_connect', 'loopback_other_port_connect', 'metadata_endpoint_connect', 'denied_staged_file_write']) {
    assert.equal(proof.errno[b], 'EPERM', b);
  }
  assert.ok(proof.sandbox_id && proof.profile_sha256);
});

test('opencode-shaped sandbox: loopback reachable (private server), external network and secrets denied', { skip: !darwin && 'sandbox-exec unavailable on this platform' }, async () => {
  const proof = await proveContainment({ shape: 'opencode' });
  assert.equal(proof.status, 'PROVEN', JSON.stringify(proof));
  assert.equal(proof.errno.loopback_other_port_connect, 'ok', 'OpenCode 2.0.25 needs its private loopback server');
  assert.equal(proof.errno.external_tcp_connect, 'EPERM');
  assert.equal(proof.errno.metadata_endpoint_connect, 'EPERM');
  for (const b of ['outside_write', 'home_secret_read', 'ssh_key_read', 'symlink_escape_read', 'shell_exec', 'keychain_cli_exec', 'denied_staged_file_write']) assert.equal(proof.errno[b], 'EPERM', b);
  // The narrowing capability itself is proven separately: with an explicit port list other loopback ports are denied.
  const narrow = await proveContainment({ shape: 'opencode', loopbackPorts: [11434] });
  assert.equal(narrow.errno.loopback_other_port_connect, 'EPERM');
});

test('unavailable platform is reported as UNAVAILABLE, never as proven', async () => {
  if (darwin) return; // covered above
  const proof = await proveContainment({ shape: 'cursor' });
  assert.equal(proof.status, 'UNAVAILABLE');
  assert.ok(Object.values(proof.boundaries).every(v => v === 'UNAVAILABLE'));
});
