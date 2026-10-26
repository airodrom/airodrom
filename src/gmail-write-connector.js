'use strict';
// Host Gmail write adapter. Message bodies are untrusted data, never instruction authority.
const { text } = require('./control-plane-store');
const { secret } = require('./assistant-intent');
const {
  hasSendScope, hasModifyScope, hasReadCapability, READ_SCOPE, SEND_SCOPE, MODIFY_SCOPE,
} = require('./gmail-oauth');

const ID = /^[A-Za-z0-9_.:-]{1,200}$/;
const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
const MAX_RECIPIENTS = 20;
const MAX_BODY = 20000;

const clean = (value) => {
  const raw = String(value || '');
  if (secret(raw)) return '[Sensitive content withheld]';
  return require('./secret-observation').redactText(
    require('node:util').stripVTControlCharacters(raw).slice(0, 4000),
  );
};

function parseAddressList(value, name) {
  if (value == null || value === '') return [];
  const list = Array.isArray(value)
    ? value
    : String(value).split(/[,;]/).map((s) => s.trim()).filter(Boolean);
  if (list.length > MAX_RECIPIENTS) {
    const err = Error(`At most ${MAX_RECIPIENTS} ${name} recipients per governed send.`);
    err.code = 'gmail_write_recipient_limit';
    throw err;
  }
  return list.map((addr) => {
    const m = /<([^>]+)>/.exec(addr);
    const email = (m ? m[1] : addr).trim().toLowerCase();
    if (!EMAIL.test(email) || email.length > 320) {
      const err = Error(`Exact ${name} recipient email required.`);
      err.code = 'gmail_write_recipient_invalid';
      throw err;
    }
    return email;
  });
}

function encodeRaw({
  to = [], cc = [], bcc = [], subject = '', body = '',
  inReplyTo = null, references = null, from = null,
}) {
  text(subject, 'subject', 998);
  text(body, 'body', MAX_BODY);
  if (secret(subject) || secret(body)) {
    const err = Error('Secret-like message content refused.');
    err.code = 'gmail_write_secret_refused';
    throw err;
  }
  const headers = [];
  if (from) headers.push('From: ' + from);
  headers.push('To: ' + to.join(', '));
  if (cc.length) headers.push('Cc: ' + cc.join(', '));
  if (bcc.length) headers.push('Bcc: ' + bcc.join(', '));
  headers.push('Subject: ' + subject.replace(/[\r\n]+/g, ' '));
  if (inReplyTo) headers.push('In-Reply-To: ' + String(inReplyTo).slice(0, 998));
  if (references) headers.push('References: ' + String(references).slice(0, 1998));
  headers.push('MIME-Version: 1.0');
  headers.push('Content-Type: text/plain; charset="UTF-8"');
  headers.push('');
  headers.push(body);
  return Buffer.from(headers.join('\r\n'), 'utf8').toString('base64url');
}

class GmailWriteConnector {
  #oauth; #request; #profileEmail = null;

  constructor({ oauth = null, request = fetch } = {}) {
    this.#oauth = oauth;
    this.#request = request;
  }

  status() {
    const st = this.#oauth?.status?.() || {};
    return {
      id: 'gmail_write',
      can_send: !!st.can_send,
      can_modify: !!st.can_modify,
      can_write: !!st.can_write,
      mode: st.mode || 'readonly',
      scope: st.scope || READ_SCOPE,
      read_only: st.read_only !== false && !st.can_write,
      write_qualified: false,
      authority: false,
    };
  }

  async #token() {
    if (!this.#oauth) throw Error('Gmail OAuth connector is not configured.');
    return this.#oauth.resolve();
  }

  async #api(method, path, { query = {}, body = null, needSend = false, needModify = false } = {}) {
    const granted = (this.#oauth.granted?.() || []).join(' ');
    if (needSend && !hasSendScope(granted) && !hasModifyScope(granted)) {
      const err = Error('Gmail send requires /connect gmail send or /connect gmail manage.');
      err.code = 'gmail_send_scope_required';
      err.safe_error_class = 'gmail_send_scope_required';
      throw err;
    }
    if (needModify && !hasModifyScope(granted)) {
      const err = Error('Gmail mailbox management requires /connect gmail manage (gmail.modify).');
      err.code = 'gmail_modify_scope_required';
      err.safe_error_class = 'gmail_modify_scope_required';
      throw err;
    }
    if (!hasReadCapability(granted) && !hasSendScope(granted)) {
      const err = Error('Gmail authorization required.');
      err.code = 'gmail_oauth_consent_required';
      throw err;
    }
    const token = await this.#token();
    const url = new URL('https://gmail.googleapis.com/gmail/v1/users/me/' + path.replace(/^\//, ''));
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null || v === '') continue;
      if (k === 'metadataHeaders' && Array.isArray(v)) {
        for (const header of v) url.searchParams.append(k, String(header));
      } else if (Array.isArray(v)) {
        for (const item of v) url.searchParams.append(k, String(item));
      } else url.searchParams.set(k, String(v));
    }
    try {
      const response = await this.#request(url, {
        method,
        headers: {
          Authorization: 'Bearer ' + token,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        redirect: 'error',
        signal: AbortSignal.timeout(20000),
      });
      if (response.status === 204) return null;
      const raw = await response.text();
      if (Buffer.byteLength(raw) > 512000) throw Error();
      if (!response.ok) {
        const err = Error('Gmail write API unavailable; credentials and provider diagnostics withheld.');
        err.code = 'gmail_write_api_rejected';
        err.safe_error_class = 'gmail_write_api_rejected';
        err.http_status = response.status;
        throw err;
      }
      return raw ? JSON.parse(raw) : null;
    } catch (error) {
      if (error?.safe_error_class || error?.code?.startsWith?.('gmail_')) throw error;
      throw Error('Gmail write unavailable; credentials and provider diagnostics withheld.');
    }
  }

  async profile() {
    if (this.#profileEmail) return { email: this.#profileEmail };
    const data = await this.#api('GET', 'profile');
    const email = typeof data?.emailAddress === 'string' && EMAIL.test(data.emailAddress)
      ? data.emailAddress.toLowerCase()
      : null;
    if (!email) throw Error('Gmail account identity unavailable.');
    this.#profileEmail = email;
    return { email };
  }

  async getMessageMeta(id) {
    if (!ID.test(id || '')) throw Error('Explicit Gmail message id required.');
    const m = await this.#api('GET', 'messages/' + encodeURIComponent(id), {
      query: {
        format: 'metadata',
        metadataHeaders: ['From', 'To', 'Cc', 'Subject', 'Date', 'Message-ID', 'References'],
      },
    });
    if (!ID.test(m?.id || '')) throw Error('Invalid Gmail message reference');
    const headers = m.payload?.headers || [];
    const get = (n) => headers.find((h) => h.name?.toLowerCase() === n.toLowerCase())?.value || null;
    return {
      id: m.id,
      thread_id: ID.test(m.threadId || '') ? m.threadId : null,
      label_ids: Array.isArray(m.labelIds) ? m.labelIds.filter((l) => typeof l === 'string').slice(0, 40) : [],
      from: clean(get('From')),
      to: clean(get('To')),
      cc: clean(get('Cc')),
      subject: clean(get('Subject')),
      date: clean(get('Date')),
      message_id_header: get('Message-ID'),
      references: get('References'),
      untrusted: true,
      authority: false,
    };
  }

  async createDraft(proposal) {
    const to = parseAddressList(proposal.to, 'to');
    if (!to.length) throw Error('Exact To recipient required.');
    const cc = parseAddressList(proposal.cc, 'cc');
    const bcc = parseAddressList(proposal.bcc, 'bcc');
    const profile = await this.profile();
    const raw = encodeRaw({
      from: profile.email,
      to, cc, bcc,
      subject: proposal.subject || '',
      body: proposal.body || '',
      inReplyTo: proposal.in_reply_to || null,
      references: proposal.references || null,
    });
    const data = await this.#api('POST', 'drafts', {
      body: { message: { raw, threadId: proposal.thread_id || undefined } },
      needSend: true,
    });
    return {
      draft_id: ID.test(data?.id || '') ? data.id : null,
      message_id: ID.test(data?.message?.id || '') ? data.message.id : null,
      account: profile.email,
      to, cc, bcc,
      subject: clean(proposal.subject),
      host_verified: true,
      authority: false,
    };
  }

  async sendMessage(proposal) {
    const to = parseAddressList(proposal.to, 'to');
    if (!to.length) throw Error('Exact To recipient required for send.');
    const cc = parseAddressList(proposal.cc, 'cc');
    const bcc = parseAddressList(proposal.bcc, 'bcc');
    const profile = await this.profile();
    const raw = encodeRaw({
      from: profile.email,
      to, cc, bcc,
      subject: proposal.subject || '',
      body: proposal.body || '',
      inReplyTo: proposal.in_reply_to || null,
      references: proposal.references || null,
    });
    const data = await this.#api('POST', 'messages/send', {
      body: { raw, threadId: proposal.thread_id || undefined },
      needSend: true,
    });
    if (!ID.test(data?.id || '')) throw Error('Gmail send did not return a verified message id.');
    return {
      message_id: data.id,
      thread_id: ID.test(data.threadId || '') ? data.threadId : null,
      account: profile.email,
      to, cc, bcc,
      subject: clean(proposal.subject),
      label_ids: Array.isArray(data.labelIds) ? data.labelIds.slice(0, 20) : [],
      host_verified: true,
      provider_confirmed: true,
      authority: false,
    };
  }

  async modifyLabels(messageId, { add = [], remove = [] } = {}) {
    if (!ID.test(messageId || '')) throw Error('Explicit Gmail message id required.');
    const addLabelIds = (add || []).filter((l) => typeof l === 'string' && l.length <= 100).slice(0, 20);
    const removeLabelIds = (remove || []).filter((l) => typeof l === 'string' && l.length <= 100).slice(0, 20);
    if (!addLabelIds.length && !removeLabelIds.length) throw Error('At least one label change required.');
    const data = await this.#api('POST', 'messages/' + encodeURIComponent(messageId) + '/modify', {
      body: { addLabelIds, removeLabelIds },
      needModify: true,
    });
    return {
      message_id: ID.test(data?.id || '') ? data.id : messageId,
      label_ids: Array.isArray(data?.labelIds) ? data.labelIds.slice(0, 40) : [],
      host_verified: true,
      provider_confirmed: true,
      authority: false,
    };
  }

  async archive(messageId) {
    return this.modifyLabels(messageId, { remove: ['INBOX'] });
  }

  async restore(messageId) {
    return this.modifyLabels(messageId, { add: ['INBOX'] });
  }

  async markRead(messageId) {
    return this.modifyLabels(messageId, { remove: ['UNREAD'] });
  }

  async markUnread(messageId) {
    return this.modifyLabels(messageId, { add: ['UNREAD'] });
  }

  async trash(messageId) {
    if (!ID.test(messageId || '')) throw Error('Explicit Gmail message id required.');
    const data = await this.#api('POST', 'messages/' + encodeURIComponent(messageId) + '/trash', {
      needModify: true,
    });
    return {
      message_id: ID.test(data?.id || '') ? data.id : messageId,
      label_ids: Array.isArray(data?.labelIds) ? data.labelIds.slice(0, 40) : [],
      trashed: true,
      host_verified: true,
      provider_confirmed: true,
      authority: false,
    };
  }
}

module.exports = {
  GmailWriteConnector,
  encodeRaw,
  parseAddressList,
  MAX_RECIPIENTS,
  SEND_SCOPE,
  MODIFY_SCOPE,
};
