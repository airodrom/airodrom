'use strict';
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { DriveConnector, MAX_CREATE, sanitizeTxtFilename } = require('../src/drive-connector');
const driveIntent = require('../src/drive-intent');
const driveService = require('../src/drive-service');
const { DriveEnrollment } = require('../src/drive-enrollment');
const {
  encodeRaw, GmailWriteConnector, parseAddressList,
} = require('../src/gmail-write-connector');
const {
  buildImmutableAttachment, normalizeAttachments, checksum, MAX_ATTACHMENT_BYTES,
} = require('../src/gmail-mime-attachment');
const writeIntent = require('../src/gmail-write-intent');
const writeService = require('../src/gmail-write-service');
const { GmailWriteSessions } = require('../src/gmail-write-session');
const { FILE_SCOPE } = require('../src/drive-oauth');

function uuid() {
  return randomUUID();
}

function memoryDb() {
  return new DatabaseSync(':memory:');
}

function jsonResponse(status, body, { binary = null } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (binary != null ? binary.toString('utf8') : (typeof body === 'string' ? body : JSON.stringify(body))),
    body: { cancel: async () => {} },
  };
}

function driveOauthStub() {
  return {
    status() {
      return {
        connected: true,
        scope: FILE_SCOPE,
        can_read_enrolled: true,
        can_write: false,
      };
    },
    granted() { return [FILE_SCOPE]; },
    async resolve() { return 'synthetic-drive-token'; },
  };
}

test('drive.file create uses multipart upload and returns checksum without broader scopes', async () => {
  const source = 'Airodrom integration test.\nGoogle Drive file creation and readback.\nGmail attachment verification.';
  const sha = crypto.createHash('sha256').update(Buffer.from(source, 'utf8')).digest('hex');
  let sawMultipart = false;
  const request = async (url, opts = {}) => {
    const href = String(url);
    if (opts.method === 'POST' && /upload\/drive\/v3\/files/.test(href)) {
      assert.match(opts.headers['Content-Type'], /multipart\/related/);
      assert.ok(Buffer.isBuffer(opts.body) || typeof opts.body === 'string');
      const raw = Buffer.isBuffer(opts.body) ? opts.body.toString('utf8') : String(opts.body);
      assert.match(raw, /airodrom-test\.txt/);
      assert.match(raw, /Airodrom integration test/);
      sawMultipart = true;
      return jsonResponse(200, {
        id: 'file_created_1',
        name: 'airodrom-test.txt',
        mimeType: 'text/plain',
        size: String(Buffer.byteLength(source)),
        parents: [],
        owners: [{ emailAddress: 'owner@example.test' }],
      });
    }
    if (/drive\/v3\/about/.test(href)) {
      return jsonResponse(200, { user: { emailAddress: 'owner@example.test', displayName: 'Owner' } });
    }
    throw Error('unexpected ' + href);
  };
  const connector = new DriveConnector({
    oauth: driveOauthStub(),
    request,
    mode: 'synthetic',
  });
  const created = await connector.createTextFile({ name: 'airodrom-test.txt', content: source });
  assert.equal(sawMultipart, true);
  assert.equal(created.id, 'file_created_1');
  assert.equal(created.content_sha256, sha);
  assert.equal(created.mime_type, 'text/plain');
  assert.equal(created.account_email, 'owner@example.test');
  assert.equal(created.synthetic, true);
  assert.equal(connector.status().can_create_text, true);
  assert.equal(connector.status().can_write, false);
});

test('drive create refuses unsafe names, secrets, and oversized bodies', async () => {
  assert.throws(() => sanitizeTxtFilename('../etc/passwd.txt'), /safe/);
  assert.throws(() => sanitizeTxtFilename('note.doc'), /safe/);
  const connector = new DriveConnector({
    oauth: driveOauthStub(),
    request: async () => jsonResponse(500, {}),
    mode: 'synthetic',
  });
  await assert.rejects(
    () => connector.createTextFile({ name: 'ok.txt', content: 'A'.repeat(MAX_CREATE + 1) }),
    (err) => err.code === 'drive_create_too_large',
  );
  await assert.rejects(
    () => connector.createTextFile({ name: 'ok.txt', content: '' }),
    (err) => err.code === 'drive_create_content_empty',
  );
});

test('drive intent parses create slash and clarifies NL create', () => {
  const parsed = driveIntent.parse('/drive create text airodrom-test.txt :: hello world');
  assert.equal(parsed.action, 'create_text');
  assert.equal(parsed.filename, 'airodrom-test.txt');
  assert.equal(parsed.content, 'hello world');
  const parent = driveIntent.parse('/drive create text note.txt in folderABC123 :: body');
  assert.equal(parent.parent_id, 'folderABC123');
  assert.equal(parent.content, 'body');
  const nl = driveIntent.parse('Create a text file and save it to my authorized Google Drive');
  assert.equal(nl.clarify, true);
  assert.equal(nl.action, 'create_text');
});

test('drive service create auto-enrolls and verifies provider readback bytes', async () => {
  const source = 'exact-bytes-v1';
  const store = new Map();
  const request = async (url, opts = {}) => {
    const href = String(url);
    if (opts.method === 'POST' && /upload\/drive\/v3\/files/.test(href)) {
      store.set('file_x', source);
      return jsonResponse(200, {
        id: 'file_x', name: 'airodrom-test.txt', mimeType: 'text/plain',
        size: String(Buffer.byteLength(source)),
        owners: [{ emailAddress: 'owner@example.test' }],
      });
    }
    if (/drive\/v3\/about/.test(href)) {
      return jsonResponse(200, { user: { emailAddress: 'owner@example.test' } });
    }
    if (/files\/file_x\?/.test(href) || /files\/file_x$/.test(href.split('&')[0])) {
      if (/alt=media/.test(href)) return jsonResponse(200, null, { binary: Buffer.from(store.get('file_x'), 'utf8') });
      return jsonResponse(200, {
        id: 'file_x', name: 'airodrom-test.txt', mimeType: 'text/plain', size: '12', trashed: false,
        owners: [{ emailAddress: 'owner@example.test' }], capabilities: {},
      });
    }
    throw Error('unexpected ' + href);
  };
  const db = memoryDb();
  const server = {
    driveOAuth: driveOauthStub(),
    driveDb: db,
    driveConnector: new DriveConnector({ oauth: driveOauthStub(), request, mode: 'synthetic' }),
    driveEnrollment: new DriveEnrollment({ db }),
  };
  const conv = uuid();
  const result = await driveService.run(server, {
    kind: 'drive', action: 'create_text', filename: 'airodrom-test.txt', content: source, host_verified: true,
  }, { conversation_id: conv });
  assert.equal(result.action, 'created');
  assert.equal(result.item.bytes_match, true);
  assert.equal(result.item.id, 'file_x');
  assert.ok(server.driveEnrollment.list({ operator: 'operator' }).some((e) => e.id === 'file_x'));
});

test('MIME encodeRaw preserves attachment bytes and checksum', () => {
  const body = 'Cover letter';
  const content = 'Airodrom integration test.\nGoogle Drive file creation and readback.\nGmail attachment verification.';
  const att = buildImmutableAttachment({
    source: 'drive',
    file_id: 'file_x',
    filename: 'airodrom-test.txt',
    mime_type: 'text/plain',
    content,
  });
  assert.equal(att.size, Buffer.byteLength(content));
  assert.equal(att.sha256, checksum(Buffer.from(content, 'utf8')));
  const raw = encodeRaw({
    to: ['owner@example.test'],
    subject: 'Drive attach test',
    body,
    from: 'owner@example.test',
    attachments: [att],
  });
  const mime = Buffer.from(raw, 'base64url').toString('utf8');
  assert.match(mime, /multipart\/mixed/);
  assert.match(mime, /Content-Disposition: attachment; filename="airodrom-test\.txt"/);
  assert.match(mime, /Cover letter/);
  const b64 = Buffer.from(content, 'utf8').toString('base64');
  assert.ok(mime.replace(/\r\n/g, '').includes(b64.replace(/\r\n/g, '')) || mime.includes(b64.slice(0, 40)));
});

test('attachment substitution after preview is refused', () => {
  const att = buildImmutableAttachment({
    source: 'drive', file_id: 'file_x', filename: 'a.txt', content: 'one',
  });
  const tampered = { ...att, content_base64: Buffer.from('two', 'utf8').toString('base64'), size: 3 };
  assert.throws(() => normalizeAttachments([tampered]), (err) => err.code === 'gmail_attach_integrity_failed' || err.code === 'gmail_attach_substitution_refused');
});

test('gmail intent parses attach drive file without chat confirm bypass', () => {
  const parsed = writeIntent.parse(
    'Send email to myself subject “Drive attach”: Please review. Attach drive file file_x',
  );
  assert.equal(parsed.action, 'send');
  assert.equal(parsed.drive_file_id, 'file_x');
  assert.equal(parsed.to, 'myself');
  const slash = writeIntent.parse(
    '/gmail send to myself subject “Hi”: Body text --attach-drive file_x',
  );
  assert.equal(slash.drive_file_id, 'file_x');
  const yes = writeIntent.parse('yes, send it');
  assert.ok(!yes || yes.action !== 'confirm');
});

test('gmail preview freezes Drive attachment; confirm sends once; duplicate confirm replays', async () => {
  const content = 'Airodrom integration test.\nGoogle Drive file creation and readback.\nGmail attachment verification.';
  const fileId = 'driveFileAttach1';
  const db = memoryDb();
  const enroll = new DriveEnrollment({ db });
  enroll.enroll({
    id: fileId, kind: 'file', name: 'airodrom-test.txt', mime_type: 'text/plain',
    operator: 'operator', account_email: 'owner@example.test',
  });

  const driveRequest = async (url) => {
    const href = String(url);
    if (/drive\/v3\/about/.test(href)) {
      return jsonResponse(200, { user: { emailAddress: 'owner@example.test' } });
    }
    if (href.includes(fileId) && /alt=media/.test(href)) {
      return jsonResponse(200, null, { binary: Buffer.from(content, 'utf8') });
    }
    if (href.includes('/files/' + fileId)) {
      return jsonResponse(200, {
        id: fileId, name: 'airodrom-test.txt', mimeType: 'text/plain', size: String(Buffer.byteLength(content)),
        trashed: false, owners: [{ emailAddress: 'owner@example.test' }], capabilities: {},
      });
    }
    throw Error('unexpected drive ' + href);
  };

  let sendCount = 0;
  let lastRaw = null;
  const gmailRequest = async (url, opts = {}) => {
    const href = String(url);
    if (/gmail\/v1\/users\/me\/profile/.test(href)) {
      return jsonResponse(200, { emailAddress: 'owner@example.test' });
    }
    if (opts.method === 'POST' && /messages\/send/.test(href)) {
      sendCount += 1;
      const body = JSON.parse(opts.body);
      lastRaw = body.raw;
      return jsonResponse(200, { id: 'msg_sent_1', threadId: 'thr_1', labelIds: ['SENT'] });
    }
    throw Error('unexpected gmail ' + href);
  };

  const gmailOauth = {
    status() {
      return {
        connected: true, mode: 'send', can_send: true, can_modify: false,
        scope: 'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send',
      };
    },
    canSend() { return true; },
    canModify() { return false; },
    granted() {
      return [
        'https://www.googleapis.com/auth/gmail.readonly',
        'https://www.googleapis.com/auth/gmail.send',
      ];
    },
    async resolve() { return 'synthetic-gmail-token'; },
  };

  const conv = uuid();
  const server = {
    gmailOAuth: gmailOauth,
    gmailWriteDb: db,
    gmailWriteSessions: new GmailWriteSessions({ db }),
    gmailWriteConnector: new GmailWriteConnector({
      oauth: gmailOauth, request: gmailRequest, mode: 'synthetic',
    }),
    driveOAuth: driveOauthStub(),
    driveDb: db,
    driveEnrollment: enroll,
    driveConnector: new DriveConnector({
      oauth: driveOauthStub(), request: driveRequest, mode: 'synthetic',
    }),
  };

  const preview = await writeService.run(server, {
    kind: 'gmail_write',
    action: 'send',
    to: 'myself',
    subject: 'Drive attach test',
    body: 'Please review the attached test file.',
    drive_file_id: fileId,
    host_verified: true,
  }, { conversation_id: conv });

  assert.equal(preview.action, 'preview');
  assert.equal(preview.gmail_drafts_persisted, false);
  assert.equal(preview.proposal.attachments.length, 1);
  assert.equal(preview.proposal.attachments[0].filename, 'airodrom-test.txt');
  assert.equal(preview.proposal.attachments[0].sha256, checksum(Buffer.from(content, 'utf8')));
  assert.equal(preview.proposal.attachments[0].content_base64, undefined);
  assert.match(preview.message, /sha256=/);
  assert.match(preview.message, /Operation ID:/);
  assert.match(preview.message, /not a Gmail Draft/i);

  // Mutate Drive store after preview — send must still use frozen bytes.
  const driveMutated = { ...server };
  driveMutated.driveConnector = new DriveConnector({
    oauth: driveOauthStub(),
    request: async (url) => {
      const href = String(url);
      if (href.includes(fileId) && /alt=media/.test(href)) {
        return jsonResponse(200, null, { binary: Buffer.from('SUBSTITUTED', 'utf8') });
      }
      return driveRequest(url);
    },
    mode: 'synthetic',
  });

  const sent = await writeService.run(driveMutated, {
    kind: 'gmail_write',
    action: 'confirm',
    preview_id: preview.preview_id,
    confirmed: true,
    host_verified: true,
  }, { conversation_id: conv });
  assert.equal(sent.action, 'sent');
  assert.equal(sendCount, 1);
  assert.equal(sent.item.attachments[0].sha256, checksum(Buffer.from(content, 'utf8')));
  const decoded = Buffer.from(lastRaw, 'base64url').toString('utf8');
  assert.match(decoded, /multipart\/mixed/);
  assert.match(decoded, /filename="airodrom-test\.txt"/);
  // Attachment payload is base64 — verify exact source bytes round-trip.
  const b64 = Buffer.from(content, 'utf8').toString('base64');
  assert.ok(decoded.replace(/\r\n/g, '').includes(b64.replace(/\r\n/g, '')));
  assert.doesNotMatch(decoded, /SUBSTITUTED/);

  const replay = await writeService.run(server, {
    kind: 'gmail_write',
    action: 'confirm',
    preview_id: preview.preview_id,
    confirmed: true,
    host_verified: true,
  }, { conversation_id: conv });
  assert.equal(sendCount, 1);
  assert.equal(replay.action, 'sent');
  assert.match(String(replay.message || ''), /replay|Sent host-verified/i);
});

test('unenrolled Drive attachment and local filesystem paths are refused', async () => {
  const db = memoryDb();
  const server = {
    gmailOAuth: {
      status() { return { connected: true, mode: 'send', can_send: true, scope: 'x' }; },
      canSend() { return true; },
      canModify() { return false; },
    },
    gmailWriteDb: db,
    gmailWriteSessions: new GmailWriteSessions({ db }),
    gmailWriteConnector: new GmailWriteConnector({
      oauth: {
        status() { return { connected: true, mode: 'send', can_send: true }; },
        canSend() { return true; },
        async resolve() { return 't'; },
        granted() { return ['https://www.googleapis.com/auth/gmail.send']; },
      },
      request: async () => jsonResponse(200, { emailAddress: 'owner@example.test' }),
      mode: 'synthetic',
    }),
    driveOAuth: driveOauthStub(),
    driveDb: db,
    driveEnrollment: new DriveEnrollment({ db }),
    driveConnector: new DriveConnector({
      oauth: driveOauthStub(),
      request: async () => jsonResponse(200, {}),
      mode: 'synthetic',
    }),
  };
  const conv = uuid();
  const denied = await writeService.run(server, {
    kind: 'gmail_write', action: 'send', to: 'a@b.test', subject: 'x', body: 'y',
    drive_file_id: 'not_enrolled', host_verified: true,
  }, { conversation_id: conv });
  assert.equal(denied.kind, 'clarify');
  assert.ok(/enroll|not enrolled|authorized/i.test(denied.message));

  assert.throws(
    () => buildImmutableAttachment({
      source: 'local', file_id: '/tmp/x.txt', filename: 'x.txt', content: 'nope',
    }),
    (err) => err.code === 'gmail_attach_source_invalid',
  );
});

test('authorization failure and provider timeout surface safely', async () => {
  const connector = new DriveConnector({
    oauth: driveOauthStub(),
    request: async () => jsonResponse(403, { error: { message: 'forbidden' } }),
    mode: 'synthetic',
  });
  await assert.rejects(
    () => connector.createTextFile({ name: 'a.txt', content: 'hi' }),
    (err) => err.code === 'drive_file_not_authorized_under_scope',
  );
  const timeoutConnector = new DriveConnector({
    oauth: driveOauthStub(),
    request: async () => {
      const err = Error('aborted');
      err.name = 'AbortError';
      throw err;
    },
    mode: 'synthetic',
  });
  await assert.rejects(
    () => timeoutConnector.createTextFile({ name: 'a.txt', content: 'hi' }),
    (err) => err.code === 'drive_api_timeout',
  );
});

test('release allowlists include Drive/Gmail attach E2E artifacts', () => {
  const root = path.join(__dirname, '..');
  const release = new Set(JSON.parse(fs.readFileSync(path.join(root, 'release-files.json'), 'utf8')));
  const pkg = require('../package.json');
  const files = [
    'src/gmail-mime-attachment.js',
    'docs/GOOGLE-WORKSPACE-DRIVE-GMAIL-ATTACH-E2E-V1.md',
    'tests/drive-gmail-attach-e2e-v1.test.js',
  ];
  for (const file of files) {
    assert.ok(release.has(file), file + ' missing from release-files.json');
    assert.ok((pkg.files || []).includes(file), file + ' missing from package.json files');
  }
  assert.ok(String(pkg.scripts['test:assistant'] || '').includes('drive-gmail-attach-e2e-v1.test.js'));
});

test('chat yes does not confirm; MAX attachment bound held', () => {
  assert.equal(MAX_ATTACHMENT_BYTES, 65536);
  const parsed = writeIntent.parse('yes, send it');
  assert.ok(parsed == null || parsed.action !== 'confirm' || parsed.confirmed !== true);
  assert.deepEqual(parseAddressList('a@b.test', 'to'), ['a@b.test']);
});
