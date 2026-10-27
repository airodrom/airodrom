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
    || /^\/drive\s+read\s+([A-Za-z0-9_-]{1,200})$/i.exec(raw);
  if (read) {
    return {
      kind: 'drive',
      action: 'read',
      file_id: read[1] || null,
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
