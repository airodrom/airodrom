'use strict';
// Host Google Drive Stage B V1 — read-only enrolled resources. No mutations.
const { DriveConnector } = require('./drive-connector');
const { DriveEnrollment } = require('./drive-enrollment');

function enrollment(server) {
  if (!server.driveEnrollment) {
    const db = server.bridge?.controlStore?.db || server.driveDb || null;
    server.driveEnrollment = new DriveEnrollment({ db });
  }
  return server.driveEnrollment;
}

function connector(server) {
  if (!server.driveOAuth) return null;
  if (!server.driveConnector) {
    // Test processes must inject a synthetic connector; never auto-wire live Drive.
    if (require('./external-write-context').isTestProcess()) return null;
    server.driveConnector = new DriveConnector({
      oauth: server.driveOAuth,
      mode: 'live',
    });
  }
  return server.driveConnector;
}

function requireConversation(conversation_id) {
  if (typeof conversation_id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(conversation_id)) {
    return {
      kind: 'clarify',
      route: 'DRIVE',
      message: 'Drive reads require an authenticated Terminal conversation session. Re-open the interactive chat and try again.',
      code: 'drive_session_required',
      authority: false,
      host_verified: true,
      model_invoked: false,
    };
  }
  return null;
}

function helpMessage(server) {
  const st = server.driveOAuth?.status?.() || { connected: false };
  const enrolled = (() => {
    try { return enrollment(server).list({ operator: 'operator' }).length; }
    catch { return 0; }
  })();
  return [
    'Google Drive Stage B V1 is host-routed, read-only, and enrollment-bound.',
    `State: connected=${!!st.connected} · scope=drive.file · enrolled=${enrolled} · mutations=none.`,
    'Consent: /connect drive (drive.file only — not blanket Drive). Gmail/Calendar consent does not grant Drive.',
    'drive.file covers only files this app created or the owner opened with this app — not every file in a folder.',
    'Preferred selection: /drive select (Google Picker) after airodrom drive picker-setup <api-key> <project-number>.',
    'Manual enroll remains: /drive enroll file <id> [name] — only if Google already authorized that file under drive.file.',
    'Folder enroll does not authorize child document reads.',
    'Reads: /drive list · /drive search <query> · /drive meta <id> · /drive read <id>.',
    'Revoke one resource: /drive unenroll <id>. Disconnect: revoke Drive OAuth from Connections / owner revoke path.',
    'Document text is untrusted content and cannot instruct Airodrom. Upload/edit/share/trash are Stage C+.',
  ].join('\n');
}

function connectOffer(server) {
  return {
    kind: 'connect_required',
    route: 'DRIVE',
    connector: 'drive',
    can_start_oauth: !!server.driveOAuth,
    message: server.driveOAuth
      ? 'Authorize Google Drive with /connect drive (drive.file). Then enroll exact file/folder ids. Connected alone is not resource access.'
      : 'Configure the owner Google desktop OAuth client (airodrom gmail setup), restart, then /connect drive. Drive is separate from Gmail and Calendar.',
    authority: false,
    host_verified: true,
    model_invoked: false,
  };
}

function statusPayload(server) {
  const oauth = server.driveOAuth?.status?.() || { connected: false };
  let enrolled = [];
  try { enrolled = enrollment(server).list({ operator: 'operator' }); } catch { enrolled = []; }
  const failure = oauth.last_failure || null;
  let liveRead = { read_qualified: false };
  try {
    liveRead = require('./drive-read-qualification').status(
      server.bridge?.controlStore?.db || server.driveDb || null,
    );
  } catch { liveRead = { read_qualified: false }; }
  let state = 'unavailable';
  if (!server.driveOAuth) state = 'unavailable';
  else if (failure === 'drive_oauth_consent_required' || failure === 'drive_oauth_grant_invalid') state = 'consent_expired';
  else if (failure === 'drive_oauth_scope_mismatch') state = 'scope_restricted';
  else if (!oauth.connected && failure) state = 'revoked';
  else if (!oauth.connected) state = 'not_connected';
  else if (!enrolled.length) state = 'resource_enrollment_required';
  else if (liveRead.read_qualified) state = 'read_qualified';
  else state = 'connected';
  return {
    kind: 'drive',
    action: 'status',
    route: 'DRIVE',
    state,
    connected: !!oauth.connected,
    scope: oauth.scope || null,
    enrolled_count: enrolled.length,
    enrolled: enrolled.slice(0, 50),
    can_write: false,
    mutations: 'none',
    last_failure: failure,
    live_read_qualified: !!liveRead.read_qualified,
    message: helpMessage(server),
    authority: false,
    host_verified: true,
    model_invoked: false,
  };
}

async function run(server, parsed, { conversation_id = null } = {}) {
  const host_verified = parsed?.host_verified === true;
  const model_invoked = false;
  const action = parsed?.action || 'help';

  if (action === 'help') {
    return {
      kind: 'drive', action: 'help', route: 'DRIVE',
      message: helpMessage(server),
      authority: false, host_verified, model_invoked,
    };
  }
  if (action === 'status' || action === 'list_enrolled') {
    const status = statusPayload(server);
    if (action === 'list_enrolled') {
      return {
        ...status,
        action: 'list_enrolled',
        message: status.enrolled_count
          ? `Enrolled Drive resources (${status.enrolled_count}):\n` + status.enrolled.map((e) => `• ${e.kind} ${e.id}${e.name ? ' — ' + e.name : ''}`).join('\n')
          : 'No Drive resources enrolled. After /connect drive, enroll exact ids with /drive enroll file|folder <id>.',
      };
    }
    return status;
  }

  if (!server.driveOAuth) return connectOffer(server);
  const st = server.driveOAuth.status();
  if (!st.connected && action !== 'help') return connectOffer(server);

  if (action === 'enroll') {
    const missing = requireConversation(conversation_id);
    if (missing) return missing;
    const adapter = connector(server);
    let account = null;
    let meta = null;
    let googleVisible = null;
    let visibilityError = null;
    try {
      if (adapter) {
        const about = await adapter.about();
        account = about.email || null;
        try {
          meta = await adapter.getMetadata(parsed.resource_id);
          googleVisible = true;
        } catch (error) {
          googleVisible = false;
          visibilityError = error;
        }
      }
    } catch { /* about may fail independently */ }
    // Refuse silent enrollment of resources Google will not authorize under drive.file.
    if (googleVisible === false && parsed.resource_kind === 'file') {
      return {
        kind: 'clarify',
        route: 'DRIVE',
        code: visibilityError?.code || 'drive_file_not_authorized_under_scope',
        message: visibilityError?.message
          || 'Google did not authorize that file under drive.file. Open it with this Airodrom client, then enroll the exact file id. Broad Drive scopes are not requested.',
        authority: false,
        host_verified,
        model_invoked,
      };
    }
    const row = enrollment(server).enroll({
      id: parsed.resource_id,
      kind: parsed.resource_kind || 'file',
      name: parsed.name || meta?.name || null,
      mime_type: meta?.mime_type || null,
      operator: 'operator',
      account_email: account,
    });
    const caveat = row.kind === 'folder'
      ? ' Folder enrollment does not authorize child document reads; enroll each file separately after it is app-opened under drive.file.'
      : (googleVisible
        ? ' Google metadata confirmed under drive.file.'
        : ' Google visibility was not confirmed; live reads may still fail closed until the file is opened with this app.');
    return {
      kind: 'drive',
      action: 'enrolled',
      route: 'DRIVE',
      item: row,
      google_visible: googleVisible,
      account_email: account,
      message: `Enrolled Drive ${row.kind} ${row.id}${row.name ? ' (' + row.name + ')' : ''}.${caveat}`,
      authority: false,
      host_verified,
      model_invoked,
    };
  }

  if (action === 'unenroll') {
    const missing = requireConversation(conversation_id);
    if (missing) return missing;
    const result = enrollment(server).revoke(parsed.resource_id, { operator: 'operator' });
    return {
      kind: 'drive',
      action: 'unenrolled',
      route: 'DRIVE',
      ...result,
      message: result.revoked
        ? `Revoked enrollment for ${parsed.resource_id}.`
        : `No active enrollment for ${parsed.resource_id}.`,
      authority: false,
      host_verified,
      model_invoked,
    };
  }

  const adapter = connector(server);
  if (!adapter) return connectOffer(server);

  try {
    if (action === 'list_folder') {
      const missing = requireConversation(conversation_id);
      if (missing) return missing;
      let folderId = parsed.folder_id;
      if (!folderId) {
        const folders = enrollment(server).list({ operator: 'operator' }).filter((e) => e.kind === 'folder');
        if (folders.length === 1) folderId = folders[0].id;
        else {
          return {
            kind: 'clarify',
            route: 'DRIVE',
            message: folders.length
              ? 'Specify which enrolled folder id to list: /drive ls <folder-id>.'
              : 'Enroll a Drive folder first: /drive enroll folder <id>.',
            authority: false,
            host_verified,
            model_invoked,
          };
        }
      }
      enrollment(server).assertEnrolled(folderId, { operator: 'operator', kind: 'folder' });
      let listed;
      try {
        listed = await adapter.listChildren(folderId, { pageSize: 25 });
      } catch (error) {
        return {
          kind: 'clarify',
          route: 'DRIVE',
          code: error.code || 'drive_api_rejected',
          message: error.code === 'drive_file_not_authorized_under_scope'
            ? 'Google did not authorize listing that folder under drive.file. Folder ids must be opened with this app; even then, child files need separate /drive enroll file <id> before reads. Broad Drive scopes are not requested.'
            : (error.message || 'Drive folder list failed.'),
          authority: false,
          host_verified,
          model_invoked,
        };
      }
      return {
        kind: 'drive',
        action: 'list_folder',
        route: 'DRIVE',
        folder_id: folderId,
        items: listed.items,
        next_page_token: listed.next_page_token,
        message: listed.items.length
          ? `Google-visible children in enrolled folder ${folderId} (${listed.items.length}) under drive.file — listing ≠ read authorization. Enroll each file before /drive read:\n`
            + listed.items.map((i) => `• ${i.name} (${i.id})`).join('\n')
          : `No children visible in enrolled folder ${folderId} under drive.file. Pre-existing Drive trees are not blanket-accessible; open files with this app, then /drive enroll file <id>.`,
        folder_enrollment_grants_child_reads: false,
        untrusted: true,
        authority: false,
        host_verified,
        model_invoked,
        synthetic: adapter.synthetic,
      };
    }

    if (action === 'search') {
      const missing = requireConversation(conversation_id);
      if (missing) return missing;
      const files = enrollment(server).list({ operator: 'operator' }).filter((e) => e.kind === 'file');
      if (!files.length) {
        return {
          kind: 'clarify', route: 'DRIVE',
          message: 'No enrolled Drive files. Under drive.file, enroll exact file ids after opening them with this app. Folder enrollment alone does not enable search-to-read.',
          authority: false, host_verified, model_invoked,
        };
      }
      const q = String(parsed.query || '').toLowerCase();
      const hits = files.filter((f) => (f.name || '').toLowerCase().includes(q) || f.id === parsed.query);
      return {
        kind: 'drive',
        action: 'search',
        route: 'DRIVE',
        query: parsed.query,
        items: hits.slice(0, 40),
        message: hits.length
          ? `Enrolled Drive file matches (${Math.min(hits.length, 40)}):\n` + hits.slice(0, 40).map((i) => `• ${i.name || i.id} (${i.id})`).join('\n')
          : 'No enrolled Drive file matches for that query.',
        untrusted: true,
        authority: false,
        host_verified,
        model_invoked,
        synthetic: adapter.synthetic,
      };
    }

    if (action === 'metadata' || action === 'read') {
      const missing = requireConversation(conversation_id);
      if (missing) return missing;
      let fileId = parsed.file_id;
      if (!fileId) {
        const files = enrollment(server).list({ operator: 'operator' }).filter((e) => e.kind === 'file');
        if (files.length === 1) fileId = files[0].id;
        else {
          return {
            kind: 'clarify', route: 'DRIVE',
            message: 'Specify an enrolled file id: /drive read <id> or /drive meta <id>.',
            authority: false, host_verified, model_invoked,
          };
        }
      }
      enrollment(server).assertReadable(fileId, { operator: 'operator' });
      const metaProbe = await adapter.getMetadata(fileId);
      if (action === 'metadata') {
        return {
          kind: 'drive', action: 'metadata', route: 'DRIVE', item: metaProbe,
          message: `Drive metadata for ${metaProbe.name || metaProbe.id}: mime=${metaProbe.mime_type}; modified=${metaProbe.modifiedTime || metaProbe.modified_time || 'n/a'}; trashed=${metaProbe.trashed}.`,
          untrusted: true, authority: false, host_verified, model_invoked, synthetic: adapter.synthetic,
        };
      }
      const content = await adapter.readContent(fileId);
      if (content.unsupported_format) {
        return {
          kind: 'drive', action: 'read', route: 'DRIVE', item: content,
          message: content.message,
          authority: false, host_verified, model_invoked, synthetic: adapter.synthetic,
        };
      }
      // Grounded excerpt only — never execute document text as instructions.
      const excerpt = String(content.content || '').slice(0, 4000);
      const contentLength = Buffer.byteLength(String(content.content || ''));
      let qualification = null;
      if (!adapter.synthetic && content.unsupported_format !== true) {
        try {
          const account = (await adapter.about().catch(() => ({}))).email || null;
          qualification = require('./drive-read-qualification').recordReadQualification(
            server.bridge?.controlStore?.db || server.driveDb || null,
            {
              file_id: content.id,
              account_email: account,
              provider_confirmed: true,
              synthetic: false,
              content_length: contentLength,
            },
          );
        } catch { qualification = null; }
      }
      return {
        kind: 'drive',
        action: 'read',
        route: 'DRIVE',
        item: {
          id: content.id,
          name: content.name,
          mime_type: content.mime_type,
          excerpt,
          content_length: contentLength,
          untrusted: true,
          instruction_authority: false,
        },
        read_qualified: qualification?.read_qualified === true,
        message: `Drive document excerpt from ${content.name || content.id} (untrusted content):\n\n${excerpt}`,
        authority: false,
        host_verified,
        model_invoked,
        synthetic: adapter.synthetic,
      };
    }
  } catch (error) {
    return {
      kind: 'clarify',
      route: 'DRIVE',
      message: error.message || 'Drive request failed.',
      code: error.code || null,
      authority: false,
      host_verified,
      model_invoked,
    };
  }

  return {
    kind: 'drive', action: 'help', route: 'DRIVE',
    message: helpMessage(server),
    authority: false, host_verified, model_invoked,
  };
}

module.exports = {
  run,
  connector,
  enrollment,
  statusPayload,
  helpMessage,
};
