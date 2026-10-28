'use strict';
// Deterministic Drive NL routing. Chat never grants enrollment or OAuth.

function parse(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const lower = raw.toLowerCase();

  if (/^\/drive\s+help$/i.test(raw) || /^help me (?:with |control )?google drive$/i.test(lower)) {
    return { kind: 'drive', action: 'help', host_verified: true };
  }
  if (/^\/drive\s+status$/i.test(raw) || /^(?:drive|google drive)\s+status$/i.test(lower)) {
    return { kind: 'drive', action: 'status', host_verified: true };
  }
  const enroll = /^\/drive\s+enroll\s+(file|folder)\s+([A-Za-z0-9_-]{1,200})(?:\s+(.+))?$/i.exec(raw);
  if (enroll) {
    return {
      kind: 'drive',
      action: 'enroll',
      resource_kind: enroll[1].toLowerCase(),
      resource_id: enroll[2],
      name: enroll[3] ? String(enroll[3]).trim().slice(0, 200) : null,
      host_verified: true,
    };
  }
  const unenroll = /^\/drive\s+(?:unenroll|revoke-resource)\s+([A-Za-z0-9_-]{1,200})$/i.exec(raw);
  if (unenroll) {
    return { kind: 'drive', action: 'unenroll', resource_id: unenroll[1], host_verified: true };
  }
  if (
    /^\/drive\s+list(?:\s+enrolled)?$/i.test(raw)
    || /^show (?:my )?(?:enrolled |authorized )?drive (?:files|folders|resources)$/i.test(lower)
    || /^show the files i(?:'|’)ve authorized in google drive\.?$/i.test(lower)
    || /^show (?:the )?files i(?:'|’)ve authorized in (?:my )?(?:google )?drive\.?$/i.test(lower)
  ) {
    return { kind: 'drive', action: 'list_enrolled', host_verified: true };
  }
  const listFolder = /^(?:show|list) (?:the )?files in (?:my )?(?:authorized |enrolled )?drive folder(?:\s+([A-Za-z0-9_-]{1,200}))?$/i.exec(raw)
    || /^\/drive\s+ls\s+([A-Za-z0-9_-]{1,200})$/i.exec(raw);
  if (listFolder) {
    return {
      kind: 'drive',
      action: 'list_folder',
      folder_id: listFolder[1] || null,
      host_verified: true,
    };
  }
  const find = /^(?:find|search) (?:the )?(.+?) in (?:my )?(?:selected |authorized |enrolled |connected )?drive(?: files)?$/i.exec(raw)
    || /^\/drive\s+search\s+(.+)$/i.exec(raw);
  if (find) {
    return {
      kind: 'drive',
      action: 'search',
      query: String(find[1]).trim().slice(0, 120),
      host_verified: true,
    };
  }
  const meta = /^(?:show|get) (?:drive )?(?:file )?metadata (?:for |of )?([A-Za-z0-9_-]{1,200})$/i.exec(raw)
    || /^\/drive\s+meta\s+([A-Za-z0-9_-]{1,200})$/i.exec(raw);
  if (meta) {
    return { kind: 'drive', action: 'metadata', file_id: meta[1], host_verified: true };
  }
  const read = /^(?:summarize|read|show) (?:this )?(?:document|file|doc) (?:from )?(?:my )?(?:authorized |enrolled )?drive(?:\s+folder)?(?:\s+([A-Za-z0-9_-]{1,200}))?$/i.exec(raw)
    || /^(?:summarize|read|show) (?:my |the )?(?:authorized |enrolled )?(?:google )?drive (?:document|file|doc)(?:\s+([A-Za-z0-9_-]{1,200}))?$/i.exec(raw)
    || /^read (?:my |the )?enrolled (?:google )?drive (?:document|file|doc)(?:\s+([A-Za-z0-9_-]{1,200}))?$/i.exec(raw)
    || /^\/drive\s+read(?:\s+([A-Za-z0-9_-]{1,200}))?$/i.exec(raw);
  if (read) {
    return {
      kind: 'drive',
      action: 'read',
      file_id: read[1] || null,
      host_verified: true,
    };
  }
  // Host-verified text create under drive.file (app-created). Slash only for content.
  // Parent form must precede the bare form so “in <folder-id>” is not treated as body text.
  const createParent = /^\/drive\s+create(?:\s+text)?\s+(\S+\.txt)\s+in\s+([A-Za-z0-9_-]{1,200})\s*(?:(?:::)\s*([\s\S]+))?$/i.exec(raw);
  if (createParent) {
    const content = createParent[3] != null ? String(createParent[3]).trim() : '';
    if (!content) {
      return {
        kind: 'drive',
        action: 'create_text',
        clarify: true,
        filename: createParent[1],
        parent_id: createParent[2],
        message: 'Provide UTF-8 text after :: . Example: /drive create text note.txt in <folder-id> :: Hello.',
        host_verified: true,
      };
    }
    return {
      kind: 'drive',
      action: 'create_text',
      filename: createParent[1],
      parent_id: createParent[2],
      content,
      host_verified: true,
    };
  }
  const createSlash = /^\/drive\s+create(?:\s+text)?\s+(\S+\.txt)\s*(?:(?:::)\s*([\s\S]+))?$/i.exec(raw);
  if (createSlash) {
    const content = createSlash[2] != null ? String(createSlash[2]).trim() : '';
    if (!content) {
      return {
        kind: 'drive',
        action: 'create_text',
        clarify: true,
        filename: createSlash[1],
        message: 'Provide UTF-8 text after the filename. Example: /drive create text airodrom-test.txt :: Airodrom integration test.',
        host_verified: true,
      };
    }
    return {
      kind: 'drive',
      action: 'create_text',
      filename: createSlash[1],
      content,
      parent_id: null,
      host_verified: true,
    };
  }
  if (
    /\b(?:create|save|upload)\b.+\b(?:text )?(?:file|document)\b.+\b(?:google )?drive\b/i.test(lower)
    || /\b(?:create|save)\b.+\bin (?:my )?(?:authorized )?google drive\b/i.test(lower)
  ) {
    return {
      kind: 'drive',
      action: 'create_text',
      clarify: true,
      message: 'Drive text create is host-routed under drive.file only. Use: /drive create text <name.txt> :: <utf8 content>. Optional parent: /drive create text <name.txt> in <enrolled-folder-id> :: <content>. Chat text alone does not create files. Broad Drive scopes are not requested.',
      host_verified: true,
    };
  }
  // Slash /drive … only. Bare “google drive” inside multi-connector personal-ops
  // phrases must not steal the host capability-plan rail.
  if (/^\/drive\b/i.test(raw)) {
    return { kind: 'drive', action: 'help', host_verified: true };
  }
  return null;
}

module.exports = { parse };
