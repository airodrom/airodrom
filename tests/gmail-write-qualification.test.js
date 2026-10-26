'use strict';
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const qual = require('../src/gmail-write-qualification');

function memDb() {
  const db = new DatabaseSync(':memory:');
  return db;
}

test('write_qualified starts false without evidence', () => {
  const db = memDb();
  assert.equal(qual.isWriteQualified(db), false);
  assert.equal(qual.readQualification(db).reason, 'not_qualified');
});

test('read/status path does not CREATE TABLE (avoids unclassified store)', () => {
  const db = memDb();
  assert.equal(qual.isWriteQualified(db), false);
  const row = db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='gmail_write_qualification'").get();
  assert.equal(row, undefined);
});

test('synthetic receipts never qualify', () => {
  const db = memDb();
  const r = qual.recordSendQualification(db, {
    operation_id: 'op1',
    preview_id: 'prev1',
    provider_message_id: 'msg1',
    synthetic: true,
  });
  assert.equal(r.recorded, false);
  assert.equal(qual.isWriteQualified(db), false);
});

test('provider-confirmed send evidence sets write_qualified and survives re-read', () => {
  const db = memDb();
  const r = qual.recordSendQualification(db, {
    operation_id: 'op-live',
    preview_id: 'prev-live',
    provider_message_id: 'gmail-msgid-abc',
    account_email: 'owner@example.com',
  });
  assert.equal(r.recorded, true);
  assert.equal(r.write_qualified, true);
  assert.equal(qual.isWriteQualified(db), true);
  const again = qual.readQualification(db);
  assert.equal(again.write_qualified, true);
  assert.equal(again.provider_message_id, 'gmail-msgid-abc');
  assert.equal(again.operation_id, 'op-live');
});

test('missing provider message id refuses qualification', () => {
  const db = memDb();
  const r = qual.recordSendQualification(db, {
    operation_id: 'op2',
    preview_id: 'prev2',
    provider_message_id: '',
  });
  assert.equal(r.recorded, false);
  assert.equal(qual.isWriteQualified(db), false);
});

test('null db fails closed', () => {
  assert.equal(qual.isWriteQualified(null), false);
  assert.equal(qual.recordSendQualification(null, {
    operation_id: 'x', preview_id: 'y', provider_message_id: 'z',
  }).recorded, false);
});
