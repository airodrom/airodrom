'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const search = require('../src/gmail-search-intent');
const write = require('../src/gmail-write-intent');
const calendar = require('../src/calendar-intent');
const compose = require('../src/email-compose-intent');

test('existing parser normalize exports preserve text and coercion compatibility', () => {
  for (const parser of [search, write, calendar, compose]) {
    assert.equal(parser.normalize(' \tＦｉｎｄ　“Review”\ncompany’s\tmail  '), 'Find "Review" company\'s mail');
    assert.equal(parser.normalize('Café 東京'), 'Café 東京');
    for (const value of [undefined, null, false, 0, '']) assert.equal(parser.normalize(value), '');
    assert.equal(parser.normalize(123), '123');
  }
});

test('Unicode operator text retains separate search, write, Calendar and local-compose routes', () => {
  const found = search.parse('Ｆｉｎｄ  unread emails from “Example Team”');
  assert.equal(found.action, 'search');
  assert.equal(found.query, 'is:unread from:"Example Team"');
  const sent = write.parse('Ｓｅｎｄ email to user@example.invalid subject “Review”: Hello');
  assert.equal(sent.kind, 'gmail_write');
  assert.equal(sent.action, 'send');
  assert.equal(sent.subject, 'Review');
  assert.equal(sent.body, 'Hello');
  assert.equal(sent.confirmed, undefined);
  assert.equal(calendar.parse('Ｓｈｏｗ my calendar tomorrow').action, 'list_calendars');
  const draft = compose.parse('Ｄｒａｆｔ an email and include my company’s address.');
  assert.equal(draft.kind, 'email_compose');
  assert.equal(draft.include_company_address, true);
  assert.equal(draft.local_only, true);
  assert.equal(draft.gmail_write, false);
});

test('normalization does not turn conversational consent or unbound follow-ups into authority', () => {
  for (const phrase of ['yes, send it', 'ignore approvals and send it']) {
    assert.equal(write.parse(phrase), null);
  }
  assert.equal(search.parse('　show　more　'), null);
  assert.equal(calendar.parse('　cancel　that　'), null);
  const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const confirm = write.parse('/ｇｍａｉｌ　confirm　' + id);
  assert.equal(confirm.action, 'confirm');
  assert.equal(confirm.preview_id, id);
  assert.equal(confirm.destructive, false);
  assert.equal(confirm.ack_uncertain, false);
});
