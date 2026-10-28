'use strict';
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { PassThrough, Readable } = require('node:stream');
const { help, interactive, parseLine } = require('../src/interactive-cli');
const local = require('../src/local-bootstrap');
const service = require('../src/gcp-gcs-tf-state-service');
const intent = require('../src/gcp-intent');
const { SOMIN_TF_STATE_BACKEND_V1 } = require('../src/gcp-exact-scope');
const { GcpProjectEnrollment } = require('../src/gcp-project-enrollment');
const { GcpGcsTfStateOps } = require('../src/gcp-gcs-tf-state-ops');

const SPEC = { ...SOMIN_TF_STATE_BACKEND_V1 };
const FOUNDER = SPEC.founder_email;

function matchingBucket() {
  return {
    name: SPEC.bucket,
    projectNumber: SPEC.project_number,
    location: SPEC.location.toUpperCase(),
    storageClass: 'STANDARD',
    versioning: { enabled: true },
    iamConfiguration: {
      uniformBucketLevelAccess: { enabled: true },
      publicAccessPrevention: 'enforced',
    },
  };
}

function mockTransport() {
  let inserted = false;
  let iam = { etag: 'etag-1', bindings: [] };
  return {
    async getBucket() {
      if (inserted) return { status: 200, body: matchingBucket() };
      return { status: 404, body: null };
    },
    async insertBucket() {
      inserted = true;
      return { status: 200, body: matchingBucket() };
    },
    async getBucketIam() {
      return { status: 200, body: iam };
    },
    async setBucketIam(_b, policy) {
      iam = policy;
      return { status: 200, body: policy };
    },
  };
}

function serverFixture({ enroll = true, identity = FOUNDER } = {}) {
  const db = new DatabaseSync(':memory:');
  const enrollment = new GcpProjectEnrollment({ db });
  if (enroll) {
    enrollment.enroll({
      project_id: SPEC.project_id,
      project_number: SPEC.project_number,
      operator: 'operator',
      account_email: FOUNDER,
    });
  }
  return {
    conversation_id: randomUUID(),
    enrollment,
    server: {
      gcpDb: db,
      gcpProjectEnrollment: enrollment,
      gcpGcsTfStateOps: new GcpGcsTfStateOps({ db }),
      gcpStorageTransport: mockTransport(),
      gcpAllowTestCredentials: true,
      gcpTokenProvider: async () => ({
        accessToken: 'ya29.test-token-value',
        account_email: identity,
      }),
    },
  };
}

function cliFixture(t, request) {
  const calls = [];
  const output = new PassThrough();
  let text = '';
  output.on('data', (chunk) => { text += String(chunk); });
  t.mock.method(local, 'start', async () => ({ default_runtime: 'opencode' }));
  t.mock.method(local, 'attach', async () => ({ default_runtime: 'opencode', healthy: true, protocol: 'airodrom-local-v1' }));
  t.mock.method(local, 'request', async (_home, route, body, options) => {
    calls.push({ route, body, options });
    return request(route, body, options);
  });
  return { calls, output, text: () => text };
}

test('/help documents governed GCP terminal commands', () => {
  const text = help();
  assert.match(text, /\/gcp help\|status\|list/);
  assert.match(text, /tf-state preview somin/);
  assert.match(text, /confirm <preview-id>/);
});

test('parseLine recognizes /gcp preview and confirm shapes', () => {
  assert.equal(parseLine('/gcp tf-state preview somin').command, 'gcp');
  assert.equal(parseLine('/gcp tf-state preview somin').arg, 'tf-state preview somin');
  const id = '16faefb1-500d-4d95-94f1-ccbdbbd7117a';
  assert.equal(parseLine(`/gcp confirm ${id}`).command, 'gcp');
  assert.equal(parseLine(`/gcp confirm ${id}`).arg, `confirm ${id}`);
});

test('interactive CLI registers /gcp with session-bound assistant input', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/interactive-cli.js'), 'utf8');
  assert.match(src, /READ_COMMANDS = new Set\(\[[^\]]*['"]gcp['"]/);
  const block = src.match(/else if\(command==='gcp'\)\{[\s\S]*?(?=else if\(command==='gmail')/);
  assert.ok(block, 'gcp slash command block missing');
  assert.match(block[0], /conversation_id:gcpConversationId/);
  assert.match(block[0], /const gcpConversationId=await session\(\)/);
  assert.match(block[0], /const message=`\/gcp\$\{arg\?/);
  assert.match(block[0], /\/api\/assistant\/input/);
  assert.match(block[0], /Chat cannot authorize cloud writes/);
});

test('intent routes preview and confirm; free-form create clarified', () => {
  assert.equal(intent.parse('/gcp tf-state preview somin').action, 'preview');
  const id = randomUUID();
  assert.equal(intent.parse(`/gcp confirm ${id}`).preview_id, id);
  assert.match(intent.parse('please create the somin tf-state bucket').message, /host-gated|cannot authorize/i);
});

test('ordinary chat cannot authorize GCP mutation', async () => {
  const { server, conversation_id } = serverFixture();
  const parsed = intent.parse('create the somin terraform state bucket now');
  assert.equal(parsed.action, 'help');
  const out = await service.run(server, parsed, { conversation_id });
  assert.notEqual(out.action, 'completed');
  assert.ok(out.action === 'help' || out.clarify || /host-gated|confirm/i.test(out.message || ''));
});

test('missing enrollment / wrong identity / missing confirm / expired / duplicate', async () => {
  {
    const { server, conversation_id } = serverFixture({ enroll: false });
    const denied = await service.run(server, { kind: 'gcp_gcs_tf_state', action: 'preview', spec: SPEC }, { conversation_id });
    assert.equal(denied.code, 'gcp_project_not_enrolled');
  }
  {
    const { server, conversation_id } = serverFixture({ identity: 'intruder@example.com' });
    const denied = await service.run(server, { kind: 'gcp_gcs_tf_state', action: 'preview', spec: SPEC }, { conversation_id });
    assert.equal(denied.code, 'gcp_identity_mismatch');
  }
  {
    const { server, conversation_id } = serverFixture();
    const missing = await service.run(server, {
      kind: 'gcp_gcs_tf_state', action: 'confirm', preview_id: randomUUID(),
    }, { conversation_id });
    assert.equal(missing.code, 'gcp_tf_state_preview_missing');
  }
  {
    let now = 1_000_000;
    const db = new DatabaseSync(':memory:');
    const enrollment = new GcpProjectEnrollment({ db });
    enrollment.enroll({ project_id: SPEC.project_id, project_number: SPEC.project_number });
    const ops = new GcpGcsTfStateOps({ db, now: () => now });
    const conversation_id = randomUUID();
    const server = {
      gcpDb: db,
      gcpProjectEnrollment: enrollment,
      gcpGcsTfStateOps: ops,
      gcpStorageTransport: mockTransport(),
      gcpAllowTestCredentials: true,
      gcpTokenProvider: async () => ({ accessToken: 'ya29.token', account_email: FOUNDER }),
    };
    const preview = await service.run(server, { kind: 'gcp_gcs_tf_state', action: 'preview', spec: SPEC }, { conversation_id });
    assert.ok(preview.preview_id);
    now += 16 * 60 * 1000;
    const expired = await service.run(server, {
      kind: 'gcp_gcs_tf_state', action: 'confirm', preview_id: preview.preview_id,
    }, { conversation_id });
    assert.ok(['gcp_tf_state_expired', 'gcp_tf_state_preview_missing'].includes(expired.code), expired.code);
  }
  {
    const { server, conversation_id } = serverFixture();
    const preview = await service.run(server, { kind: 'gcp_gcs_tf_state', action: 'preview', spec: SPEC }, { conversation_id });
    const done = await service.run(server, {
      kind: 'gcp_gcs_tf_state', action: 'confirm', preview_id: preview.preview_id,
    }, { conversation_id });
    assert.equal(done.action, 'completed');
    const again = await service.run(server, {
      kind: 'gcp_gcs_tf_state', action: 'confirm', preview_id: preview.preview_id,
    }, { conversation_id });
    assert.equal(again.code, 'gcp_tf_state_replay_completed');
  }
});

test('revoked enrollment blocks confirm after preview', async () => {
  const { server, conversation_id, enrollment } = serverFixture();
  const preview = await service.run(server, { kind: 'gcp_gcs_tf_state', action: 'preview', spec: SPEC }, { conversation_id });
  enrollment.revoke(SPEC.project_id);
  const out = await service.run(server, {
    kind: 'gcp_gcs_tf_state', action: 'confirm', preview_id: preview.preview_id,
  }, { conversation_id });
  assert.equal(out.code, 'gcp_project_not_enrolled');
});

test('interactive Terminal routes /gcp preview and confirm with conversation_id', async (t) => {
  const previewId = '16faefb1-500d-4d95-94f1-ccbdbbd7117a';
  const f = cliFixture(t, (route, body) => {
    if (route === '/api/interactive/memory?query=name') return { items: [] };
    if (route === '/api/assistant/conversation/session') return { conversation_id: 'sess-gcp-1' };
    if (route === '/api/assistant/input') {
      assert.equal(body.conversation_id, 'sess-gcp-1');
      if (body.message === '/gcp tf-state preview somin') {
        return {
          kind: 'gcp_gcs_tf_state',
          action: 'preview',
          preview_id: previewId,
          message: `Exact-scope GCS tf-state backend CREATE\nConfirm with: /gcp confirm ${previewId}`,
        };
      }
      if (body.message === `/gcp confirm ${previewId}`) {
        return {
          kind: 'gcp_gcs_tf_state',
          action: 'awaiting_host_confirm',
          preview_id: previewId,
          message: 'Host authorization required before CREATE.',
        };
      }
      throw Error(`Unexpected input: ${body.message}`);
    }
    return { state: 'completed', summary: 'ok' };
  });
  const input = Readable.from([
    '/gcp tf-state preview somin\n',
    `/gcp confirm ${previewId}\n`,
    '/quit\n',
  ]);
  await interactive('synthetic', { input, output: f.output, env: { NO_COLOR: '1', TERM: 'dumb' } });
  const inputs = f.calls.filter((c) => c.route === '/api/assistant/input');
  assert.equal(inputs.length, 2);
  assert.equal(inputs[0].body.message, '/gcp tf-state preview somin');
  assert.equal(inputs[0].body.conversation_id, 'sess-gcp-1');
  assert.equal(inputs[1].body.message, `/gcp confirm ${previewId}`);
  assert.equal(inputs[1].body.conversation_id, 'sess-gcp-1');
  assert.doesNotMatch(f.text(), /Unknown command/);
  assert.match(f.text(), /Exact-scope GCS tf-state|Confirm with: \/gcp confirm/i);
});

test('interactive Terminal rejects malformed /gcp without host dispatch', async (t) => {
  const f = cliFixture(t, (route) => {
    if (route === '/api/interactive/memory?query=name') return { items: [] };
    if (route === '/api/assistant/conversation/session') return { conversation_id: 'sess-gcp-2' };
    if (route === '/api/assistant/input') throw Error('malformed /gcp must not reach host');
    return { state: 'completed', summary: 'ok' };
  });
  await interactive('synthetic', {
    input: Readable.from(['/gcp create everything\n', '/quit\n']),
    output: f.output,
    env: { NO_COLOR: '1', TERM: 'dumb' },
  });
  assert.equal(f.calls.filter((c) => c.route === '/api/assistant/input').length, 0);
  assert.match(f.text(), /Use \/gcp help|tf-state preview|Chat cannot authorize/i);
  assert.doesNotMatch(f.text(), /Unknown command\. Use \/help\./);
});

test('unknown slash commands still fail closed', async (t) => {
  const f = cliFixture(t, (route) => {
    if (route === '/api/interactive/memory?query=name') return { items: [] };
    if (route === '/api/assistant/conversation/session') return { conversation_id: 'sess-unknown' };
    if (route === '/api/assistant/input') throw Error('unknown slash must not reach host');
    return { state: 'completed', summary: 'ok' };
  });
  await interactive('synthetic', {
    input: Readable.from(['/not-a-real-command\n', '/quit\n']),
    output: f.output,
    env: { NO_COLOR: '1', TERM: 'dumb' },
  });
  assert.equal(f.calls.filter((c) => c.route === '/api/assistant/input').length, 0);
  assert.match(f.text(), /Unknown command/);
});

test('ordinary chat text is not a GCP confirm path', async (t) => {
  const f = cliFixture(t, (route, body) => {
    if (route === '/api/interactive/memory?query=name') return { items: [] };
    if (route === '/api/assistant/conversation/session') return { conversation_id: 'sess-chat' };
    if (route === '/api/assistant/input') {
      assert.equal(body.message, 'please confirm the gcp preview and create the bucket');
      return {
        kind: 'clarify',
        message: 'Live CREATE is host-gated. Use /gcp tf-state preview somin then /gcp confirm <preview-id>. Chat cannot authorize cloud writes.',
      };
    }
    return { state: 'completed', summary: 'ok' };
  });
  await interactive('synthetic', {
    input: Readable.from(['please confirm the gcp preview and create the bucket\n', '/quit\n']),
    output: f.output,
    env: { NO_COLOR: '1', TERM: 'dumb' },
  });
  const inputs = f.calls.filter((c) => c.route === '/api/assistant/input');
  assert.equal(inputs.length, 1);
  assert.doesNotMatch(inputs[0].body.message, /^\/gcp confirm /);
  assert.match(f.text(), /host-gated|cannot authorize/i);
});
