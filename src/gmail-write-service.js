'use strict';
// Host Gmail write execution. Preview + confirm; never silent send.
const { GmailWriteConnector, parseAddressList, MAX_RECIPIENTS } = require('./gmail-write-connector');
const { GmailWriteSessions } = require('./gmail-write-session');

function sessions(server) {
  if (!server.gmailWriteSessions) {
    const db = server.bridge?.controlStore?.db || server.gmailWriteDb || null;
    server.gmailWriteSessions = new GmailWriteSessions({ db });
  }
  return server.gmailWriteSessions;
}

function oauthBinding(server) {
  const st = server.gmailOAuth?.status?.() || {};
  return {
    oauth_mode: st.mode || null,
    oauth_scope: st.scope || null,
  };
}

function stageOpts(server, conversation_id) {
  return { conversation_id, operator: 'operator', ...oauthBinding(server) };
}

function writeConnector(server) {
  if (!server.gmailOAuth) return null;
  if (!server.gmailWriteConnector) {
    const writeQual = require('./gmail-write-qualification');
    server.gmailWriteConnector = new GmailWriteConnector({
      oauth: server.gmailOAuth,
      writeQualified: () => writeQual.isWriteQualified(server.bridge?.controlStore?.db || server.gmailWriteDb || null),
    });
  }
  return server.gmailWriteConnector;
}

function requireConversation(conversation_id) {
  if (typeof conversation_id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(conversation_id)) {
    return {
      kind: 'clarify',
      route: 'GMAIL_WRITE',
      message: 'Gmail writes require an authenticated Terminal conversation session. Re-open the interactive chat and try again.',
      authority: false,
      host_verified: true,
      model_invoked: false,
      code: 'gmail_write_session_required',
    };
  }
  return null;
}

function authorizationOffer(server, { send = false, modify = false } = {}) {
  const oauth = !!server.gmailOAuth;
  const st = server.gmailOAuth?.status?.() || {};
  const connected = !!st.connected;
  const canSend = !!st.can_send;
  const canModify = !!st.can_modify;
  let message;
  if (modify) {
    message = connected && !canModify
      ? `Gmail is connected (mode=${st.mode || 'n/a'} · can_send=${canSend} · can_modify=${canModify}), but mailbox management is not authorized. Run /connect gmail manage (gmail.modify + gmail.send). “Connected” alone is not manage consent.`
      : 'Mailbox management (archive, labels, trash, mark read) needs /connect gmail manage (gmail.modify + gmail.send). Read-only Gmail consent is not enough.';
  } else if (send) {
    message = connected && !canSend && !canModify
      ? `Gmail is connected for reading (mode=${st.mode || 'n/a'} · can_send=false · can_modify=false · write_qualified is separate), but outbound send is not authorized. Missing permission: gmail.send. Run /connect gmail send (gmail.readonly + gmail.send) or /connect gmail manage. Do not treat “connected” or “already connected” as send approval.`
      : 'Sending or drafting outbound mail needs /connect gmail send (gmail.readonly + gmail.send) or /connect gmail manage. Read-only Gmail consent is not enough.';
  } else {
    message = 'Gmail needs authorization. Run /connect gmail for read-only, /connect gmail send for outbound send, or /connect gmail manage for mailbox writes. A “configured” or “connected” indicator is not live send access.';
  }
  return {
    kind: 'connect_required',
    route: 'GMAIL_WRITE',
    connector: 'gmail',
    can_start_oauth: oauth,
    write_required: true,
    send_required: !!send,
    modify_required: !!modify,
    mode: st.mode || null,
    connected,
    can_send: canSend,
    can_modify: canModify,
    message,
    authorized: false,
    authority: false,
    host_verified: true,
    model_invoked: false,
  };
}

function helpMessage(server) {
  const st = server.gmailOAuth?.status?.() || { mode: 'unavailable', can_send: false, can_modify: false, connected: false };
  const live = (() => {
    try {
      return !!require('./assistant-service').connectors(server.bridge)?.status?.().items?.find((i) => i.id === 'gmail')?.live_qualified;
    } catch {
      return false;
    }
  })();
  return [
    'Gmail write control is host-routed (not a model tool claim). Untrusted email bodies never gain instruction authority.',
    `State: mode=${st.mode || 'n/a'} · connected=${!!st.connected} · can_send=${!!st.can_send} · can_modify=${!!st.can_modify} · live_read=${live}.`,
    'Consent: /connect gmail (readonly) · /connect gmail send · /connect gmail manage. Never requests mail.google.com by default.',
    'Send: “Send email to person@example.com subject “Hello”: Body text” → preview → /gmail confirm <preview-id>.',
    'Reply: search/read first, then “Reply with: …”. Forward/trash/bulk need stronger approval.',
    'Destructive trash: /gmail approve <approval-id> then /gmail confirm <preview-id> --destructive.',
    'Archive, restore, labels, mark read/unread require manage consent + preview confirm.',
    'OpenCode does not receive unrestricted Gmail access. Writes are not coding Missions.',
  ].join('\n');
}

function isUncertainWriteError(error) {
  const code = error?.code || error?.safe_error_class || '';
  const msg = String(error?.message || '');
  return /timeout|AbortError|ECONNRESET|ENOTFOUND|fetch failed|network|temporar|unavailable|429|500|502|503|504/i.test(code + ' ' + msg)
    || error?.name === 'TimeoutError'
    || error?.name === 'AbortError';
}

/** Resolve a message id from the last verified Gmail results in this conversation. */
function selectedMessageId(server, conversation_id) {
  try {
    if (!server.gmailSearchSessions) {
      server.gmailSearchSessions = new (require('./gmail-search-session').GmailSearchSessions)();
    }
    const last = server.gmailSearchSessions.lastResults({ conversation_id, operator: 'operator' });
    if (last?.selected_id) return last.selected_id;
    if (last?.items?.length === 1) return last.items[0].id;
    if (last?.items?.length > 1) {
      return { error: 'Multiple verified Gmail results. Read one message (or narrow the search to a single match) before writing.' };
    }
  } catch { /* no search session */ }
  return { error: 'No verified Gmail message selected in this conversation. Search or read a message first.' };
}

function resolveMessageId(server, conversation_id, explicitId) {
  if (explicitId && typeof explicitId === 'string') return { id: explicitId };
  const sel = selectedMessageId(server, conversation_id);
  if (typeof sel === 'string') return { id: sel };
  return sel;
}

async function run(server, parsed, {
  conversation_id = null,
  confirm_id = null,
  confirmed = false,
  destructive = false,
} = {}) {
  const model_invoked = false;
  const host_verified = true;

  if (parsed.action === 'help' || parsed.message && parsed.action === 'help') {
    return {
      kind: 'gmail_write',
      action: 'help',
      route: 'GMAIL_WRITE',
      message: parsed.message || helpMessage(server),
      status: server.gmailOAuth?.status?.() || null,
      host_verified,
      model_invoked,
      authority: false,
    };
  }

  if (parsed.action === 'approve') {
    const missing = requireConversation(conversation_id);
    if (missing) return missing;
    try {
      const approved = sessions(server).approveWrite(parsed.approval_id || confirm_id, {
        conversation_id,
        operator: 'operator',
      });
      return {
        kind: 'gmail_write',
        action: 'approval_recorded',
        route: 'GMAIL_WRITE',
        ...approved,
        message: `Independent Gmail approval recorded for preview ${approved.preview_id}. Confirm with /gmail confirm ${approved.preview_id}${parsed.destructive || destructive ? ' --destructive' : ''}.`,
        host_verified,
        model_invoked,
        authority: false,
      };
    } catch (error) {
      return {
        kind: 'clarify',
        route: 'GMAIL_WRITE',
        message: error.message,
        code: error.code,
        host_verified,
        model_invoked,
        authority: false,
      };
    }
  }

  if (parsed.clarify && parsed.message) {
    return {
      kind: 'clarify',
      route: 'GMAIL_WRITE',
      message: parsed.message,
      host_verified,
      model_invoked,
      authority: false,
    };
  }

  const adapter = writeConnector(server);
  if (!adapter) return authorizationOffer(server, { send: true });

  const oauth = server.gmailOAuth;
  const st = oauth.status();
  if (!st.connected) return authorizationOffer(server);

  try {
    if (parsed.action === 'send') {
      const missing = requireConversation(conversation_id);
      if (missing) return missing;
      if (!oauth.canSend() && !oauth.canModify()) return authorizationOffer(server, { send: true });
      let toRaw = parsed.to;
      if (toRaw === 'myself' || toRaw === 'me') {
        if (!adapter?.profile) {
          return {
            kind: 'clarify',
            route: 'GMAIL_WRITE',
            message: 'Cannot resolve “myself” to the authorized mailbox profile. Provide an exact recipient email, or reconnect Gmail and retry.',
            host_verified,
            model_invoked,
            authority: false,
          };
        }
        const profile = await adapter.profile();
        toRaw = profile?.email || null;
        if (!toRaw) {
          return {
            kind: 'clarify',
            route: 'GMAIL_WRITE',
            message: 'Authorized Gmail profile email is unavailable. Provide an exact recipient address.',
            host_verified,
            model_invoked,
            authority: false,
          };
        }
      }
      if (!toRaw || !parsed.subject || parsed.body == null || parsed.body === '') {
        return {
          kind: 'clarify',
          route: 'GMAIL_WRITE',
          message: parsed.message
            || 'To stage a Gmail send preview, provide exact recipient, subject, and body. Example: Send email to person@example.com subject “Hello”: Your message here. Only /gmail confirm <preview-id> sends.',
          host_verified,
          model_invoked,
          authority: false,
        };
      }
      const to = parseAddressList(toRaw, 'to');
      const cc = parseAddressList(parsed.cc, 'cc');
      const bcc = parseAddressList(parsed.bcc, 'bcc');
      const recipientCount = to.length + cc.length + bcc.length;
      const bulk = recipientCount > 5;
      const proposal = {
        op: 'send',
        to, cc, bcc,
        subject: parsed.subject || '',
        body: parsed.body || '',
        thread_id: parsed.thread_id || null,
        in_reply_to: parsed.in_reply_to || null,
        references: parsed.references || null,
        bulk_recipients: bulk,
        account_hint: 'authorized Gmail account',
      };
      const staged = sessions(server).stageWrite(proposal, stageOpts(server, conversation_id));
      let message = `Gmail send preview (not delivered)\n`
        + `Preview ID: ${staged.preview_id}\n`
        + `• To: ${to.join(', ')}`
        + (cc.length ? `\n• Cc: ${cc.join(', ')}` : '')
        + (bcc.length ? `\n• Bcc: ${bcc.join(', ')}` : '')
        + `\n• Subject: ${proposal.subject}\n• Body:\n${String(proposal.body).slice(0, 2000)}\n\n`
        + `Nothing has been sent.\n`
        + `Confirm delivery only with: /gmail confirm ${staged.preview_id}`;
      if (bulk) {
        message += `\nBulk recipients require independent approval first: /gmail approve ${staged.approval_id}`;
      }
      return {
        kind: 'gmail_write',
        action: 'preview',
        route: 'GMAIL_WRITE',
        preview_id: staged.preview_id,
        approval_id: staged.approval_id,
        operation_id: staged.operation_id,
        proposal: { ...proposal, body: String(proposal.body).slice(0, 500) },
        message,
        requires_confirmation: true,
        requires_independent_approval: bulk,
        host_verified,
        model_invoked,
        authority: false,
      };
    }

    if (parsed.action === 'reply') {
      const missing = requireConversation(conversation_id);
      if (missing) return missing;
      if (!oauth.canSend() && !oauth.canModify()) return authorizationOffer(server, { send: true });
      const resolved = resolveMessageId(server, conversation_id, parsed.message_id);
      if (resolved.error) {
        return { kind: 'clarify', route: 'GMAIL_WRITE', message: resolved.error, host_verified, model_invoked, authority: false };
      }
      if (!parsed.body) {
        return {
          kind: 'clarify',
          route: 'GMAIL_WRITE',
          message: 'Provide the exact reply body. Example: Reply with: Thanks, confirmed.',
          host_verified,
          model_invoked,
          authority: false,
        };
      }
      const meta = await adapter.getMessageMeta(resolved.id);
      const to = parseAddressList(meta.from, 'to');
      if (!to.length) {
        return { kind: 'clarify', route: 'GMAIL_WRITE', message: 'Could not resolve a reply recipient from the verified message From header.', host_verified, model_invoked, authority: false };
      }
      let cc = [];
      if (parsed.reply_all) {
        cc = [...parseAddressList(meta.to, 'cc'), ...parseAddressList(meta.cc, 'cc')]
          .filter((e, i, a) => a.indexOf(e) === i);
        try {
          const profile = await adapter.profile();
          cc = cc.filter((e) => e !== profile.email && !to.includes(e));
        } catch { /* keep cc */ }
      }
      const subject = meta.subject && !/^re:/i.test(meta.subject) ? 'Re: ' + meta.subject : (meta.subject || 'Re:');
      const proposal = {
        op: 'send',
        to, cc, bcc: [],
        subject,
        body: parsed.body,
        thread_id: meta.thread_id,
        in_reply_to: meta.message_id_header,
        references: [meta.references, meta.message_id_header].filter(Boolean).join(' ').trim() || null,
        source_message_id: meta.id,
        reply_all: !!parsed.reply_all,
        bulk_recipients: (to.length + cc.length) > 5,
      };
      const staged = sessions(server).stageWrite(proposal, stageOpts(server, conversation_id));
      return {
        kind: 'gmail_write',
        action: 'preview',
        route: 'GMAIL_WRITE',
        preview_id: staged.preview_id,
        approval_id: staged.approval_id,
        operation_id: staged.operation_id,
        proposal: { ...proposal, body: String(proposal.body).slice(0, 500) },
        message: `Preview reply${proposal.reply_all ? '-all' : ''} to ${to.join(', ')} re “${subject}” (source ${meta.id}).\nConfirm with /gmail confirm ${staged.preview_id}.`
          + (staged.approval_id ? `\nIndependent approval required: /gmail approve ${staged.approval_id}` : ''),
        requires_confirmation: true,
        host_verified,
        model_invoked,
        authority: false,
      };
    }

    if (parsed.action === 'forward') {
      const missing = requireConversation(conversation_id);
      if (missing) return missing;
      if (!oauth.canSend() && !oauth.canModify()) return authorizationOffer(server, { send: true });
      const resolved = resolveMessageId(server, conversation_id, parsed.message_id);
      if (resolved.error) {
        return { kind: 'clarify', route: 'GMAIL_WRITE', message: resolved.error, host_verified, model_invoked, authority: false };
      }
      const to = parseAddressList(parsed.to, 'to');
      if (!to.length) {
        return { kind: 'clarify', route: 'GMAIL_WRITE', message: 'Exact forward recipient required.', host_verified, model_invoked, authority: false };
      }
      const meta = await adapter.getMessageMeta(resolved.id);
      const proposal = {
        op: 'send',
        to, cc: [], bcc: [],
        subject: meta.subject && !/^fwd:/i.test(meta.subject) ? 'Fwd: ' + meta.subject : (meta.subject || 'Fwd:'),
        body: parsed.body || `(Forwarded message ${meta.id} from ${meta.from || 'unknown'} — open the original in Gmail for full content.)`,
        source_message_id: meta.id,
        sensitive_forward: true,
      };
      const staged = sessions(server).stageWrite(proposal, stageOpts(server, conversation_id));
      return {
        kind: 'gmail_write',
        action: 'preview',
        route: 'GMAIL_WRITE',
        preview_id: staged.preview_id,
        approval_id: staged.approval_id,
        operation_id: staged.operation_id,
        proposal: { ...proposal, body: String(proposal.body).slice(0, 500) },
        message: `Sensitive forward preview to ${to.join(', ')} of message ${meta.id}.\n1) /gmail approve ${staged.approval_id}\n2) /gmail confirm ${staged.preview_id}`,
        requires_confirmation: true,
        requires_independent_approval: true,
        host_verified,
        model_invoked,
        authority: false,
      };
    }

    const mailboxOps = ['archive', 'restore', 'mark_read', 'mark_unread', 'trash', 'label'];
    if (mailboxOps.includes(parsed.action)) {
      const missing = requireConversation(conversation_id);
      if (missing) return missing;
      if (!oauth.canModify()) return authorizationOffer(server, { modify: true });
      const resolved = resolveMessageId(server, conversation_id, parsed.message_id);
      if (resolved.error) {
        return { kind: 'clarify', route: 'GMAIL_WRITE', message: resolved.error, host_verified, model_invoked, authority: false };
      }
      const proposal = {
        op: parsed.action,
        message_id: resolved.id,
        label: parsed.label || null,
        label_op: parsed.label_op || null,
        destructive: parsed.action === 'trash',
      };
      const staged = sessions(server).stageWrite(proposal, stageOpts(server, conversation_id));
      let message = `Preview ${parsed.action} on message ${resolved.id}. Confirm with /gmail confirm ${staged.preview_id}.`;
      if (proposal.destructive) {
        message = `Destructive preview — move message ${resolved.id} to trash.\n1) /gmail approve ${staged.approval_id}\n2) /gmail confirm ${staged.preview_id} --destructive`;
      }
      return {
        kind: 'gmail_write',
        action: 'preview',
        route: 'GMAIL_WRITE',
        preview_id: staged.preview_id,
        approval_id: staged.approval_id,
        operation_id: staged.operation_id,
        proposal,
        message,
        requires_confirmation: true,
        requires_independent_approval: !!proposal.destructive,
        destructive: !!proposal.destructive,
        host_verified,
        model_invoked,
        authority: false,
      };
    }

    if (parsed.action === 'confirm' || confirm_id) {
      const missing = requireConversation(conversation_id);
      if (missing) return missing;
      const id = confirm_id || parsed.preview_id;
      const prior = sessions(server).getCompleted(id, { conversation_id, operator: 'operator' });
      if (prior) {
        return { ...prior, host_verified, model_invoked, live_qualified: true, authority: false };
      }

      const ownerConfirmed = confirmed === true || parsed.confirmed === true;
      const destructiveOk = destructive === true || parsed.destructive === true;
      const ackUncertain = parsed.ack_uncertain === true;
      if (!ownerConfirmed) {
        return {
          kind: 'clarify',
          route: 'GMAIL_WRITE',
          message: 'Confirm the preview with /gmail confirm <preview-id>.',
          host_verified,
          model_invoked,
          authority: false,
        };
      }

      let peeked;
      try {
        peeked = sessions(server).peekWrite(id, { conversation_id, operator: 'operator' });
      } catch (error) {
        return { kind: 'clarify', route: 'GMAIL_WRITE', message: error.message, code: error.code, host_verified, model_invoked, authority: false };
      }
      if (peeked.destructive && !destructiveOk) {
        return {
          kind: 'clarify',
          route: 'GMAIL_WRITE',
          message: 'Destructive Gmail trash requires /gmail confirm <id> --destructive after independent approval.',
          host_verified,
          model_invoked,
          authority: false,
        };
      }
      if (peeked.op === 'send' && !oauth.canSend() && !oauth.canModify()) {
        return authorizationOffer(server, { send: true });
      }
      if (peeked.op !== 'send' && !oauth.canModify()) {
        return authorizationOffer(server, { modify: true });
      }

      // Resolve Google account before claim so the operation binds to the live identity.
      let account_email = null;
      try {
        if (adapter?.profile) {
          const profile = await adapter.profile();
          account_email = profile?.email || null;
        }
      } catch { /* claim still proceeds; account bound when available */ }

      let claimed;
      try {
        claimed = sessions(server).claimWrite(id, {
          conversation_id,
          operator: 'operator',
          account_email,
          ...oauthBinding(server),
          ack_uncertain: ackUncertain,
        });
      } catch (error) {
        return {
          kind: 'clarify',
          route: 'GMAIL_WRITE',
          message: error.message,
          code: error.code,
          approval_id: error.approval_id || null,
          preview_id: id,
          host_verified,
          model_invoked,
          authority: false,
        };
      }
      if (claimed.kind === 'completed') {
        return { ...claimed.receipt, host_verified, model_invoked, live_qualified: true, authority: false };
      }

      const row = claimed.row;
      const claim_token = claimed.claim_token;

      async function finishSuccess(receipt) {
        // Persist a replay-annotated copy; return the fresh provider receipt unmarked.
        sessions(server).markCompleted(id, receipt, {
          conversation_id,
          operator: 'operator',
          claim_token,
        });
        // Durable write qualification: only provider-confirmed send with message id.
        if (receipt?.action === 'sent' && receipt?.provider_confirmed === true) {
          const messageId = receipt?.item?.message_id || receipt?.item?.id || null;
          const account = receipt?.item?.account || null;
          if (messageId) {
            try {
              require('./gmail-write-qualification').recordSendQualification(
                server.bridge?.controlStore?.db || server.gmailWriteDb || null,
                {
                  operation_id: receipt.operation_id || id,
                  preview_id: id,
                  provider_message_id: String(messageId),
                  account_email: account,
                  synthetic: receipt.synthetic === true || receipt.fixture === true,
                },
              );
            } catch { /* qualification store optional in fixtures */ }
          }
        }
        return receipt;
      }

      async function finishUncertain(message, code = 'gmail_write_uncertain') {
        sessions(server).markUncertain(id, claim_token, { conversation_id, operator: 'operator' });
        return {
          kind: 'clarify',
          route: 'GMAIL_WRITE',
          action: 'uncertain',
          message,
          operation_id: row.operation_id || id,
          preview_id: id,
          code,
          host_verified,
          model_invoked,
          authority: false,
        };
      }

      if (row.op === 'send') {
        try {
          const sent = await adapter.sendMessage(row);
          const receipt = {
            kind: 'gmail_write',
            action: 'sent',
            route: 'GMAIL_WRITE',
            operation_id: row.operation_id || id,
            item: sent,
            message: `Sent host-verified message ${sent.message_id} from ${sent.account} to ${sent.to.join(', ')}.`,
            google_idempotent: false,
            provider_confirmed: true,
            host_verified,
            model_invoked,
            live_qualified: true,
            authority: false,
          };
          return await finishSuccess(receipt);
        } catch (error) {
          if (isUncertainWriteError(error)) {
            return finishUncertain(
              'Send outcome is uncertain (network/timeout). Operation marked uncertain — do not retry blindly. Check Gmail Sent, then /gmail confirm '
                + id + ' --ack-uncertain only if nothing was delivered. Operation id: ' + (row.operation_id || id),
            );
          }
          // Definite provider rejection: release claim back to pending by marking uncertain
          // is wrong; rethrow for outer handler. Drop claim to uncertain so restart is safe.
          try { sessions(server).markUncertain(id, claim_token, { conversation_id, operator: 'operator' }); } catch { /* */ }
          throw error;
        }
      }

      try {
        let result;
        if (row.op === 'archive') result = await adapter.archive(row.message_id);
        else if (row.op === 'restore') result = await adapter.restore(row.message_id);
        else if (row.op === 'mark_read') result = await adapter.markRead(row.message_id);
        else if (row.op === 'mark_unread') result = await adapter.markUnread(row.message_id);
        else if (row.op === 'trash') result = await adapter.trash(row.message_id);
        else if (row.op === 'label') {
          const add = row.label_op === 'add' ? [row.label] : [];
          const remove = row.label_op === 'remove' ? [row.label] : [];
          result = await adapter.modifyLabels(row.message_id, { add, remove });
        } else {
          sessions(server).markUncertain(id, claim_token, { conversation_id, operator: 'operator' });
          return { kind: 'clarify', route: 'GMAIL_WRITE', message: 'Unknown Gmail write operation.', host_verified, model_invoked, authority: false };
        }
        const receipt = {
          kind: 'gmail_write',
          action: row.op,
          route: 'GMAIL_WRITE',
          operation_id: row.operation_id || id,
          item: result,
          message: `Gmail ${row.op} confirmed for message ${result.message_id}.`,
          provider_confirmed: true,
          host_verified,
          model_invoked,
          live_qualified: true,
          authority: false,
        };
        return await finishSuccess(receipt);
      } catch (error) {
        if (isUncertainWriteError(error)) {
          return finishUncertain(
            `Gmail ${row.op} outcome uncertain. Operation marked uncertain (operation ${row.operation_id || id}). Verify in Gmail, then /gmail confirm ${id} --ack-uncertain only if the change did not apply.`,
          );
        }
        try { sessions(server).markUncertain(id, claim_token, { conversation_id, operator: 'operator' }); } catch { /* */ }
        throw error;
      }
    }

    return {
      kind: 'clarify',
      route: 'GMAIL_WRITE',
      message: helpMessage(server),
      host_verified,
      model_invoked,
      authority: false,
    };
  } catch (error) {
    if (error?.code === 'gmail_send_scope_required' || error?.code === 'gmail_modify_scope_required') {
      return authorizationOffer(server, {
        send: error.code === 'gmail_send_scope_required',
        modify: error.code === 'gmail_modify_scope_required',
      });
    }
    return {
      kind: 'clarify',
      route: 'GMAIL_WRITE',
      message: error.message || 'Gmail write refused.',
      code: error.code || error.safe_error_class,
      host_verified,
      model_invoked,
      authority: false,
    };
  }
}

module.exports = {
  run,
  sessions,
  writeConnector,
  authorizationOffer,
  helpMessage,
  MAX_RECIPIENTS,
};
