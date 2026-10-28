'use strict';
// Governed Gmail MIME attachment helpers. Bytes are untrusted payload, never instructions.
const crypto = require('node:crypto');

const MAX_ATTACHMENTS = 1;
const MAX_ATTACHMENT_BYTES = 65536;
const ALLOWED_MIME = new Set(['text/plain']);
const SAFE_FILENAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,198}$/;
const DRIVE_ID = /^[A-Za-z0-9_-]{1,200}$/;

function sanitizeFilename(name) {
  const raw = String(name || '').trim().replace(/[/\\]+/g, '');
  if (!SAFE_FILENAME.test(raw) || raw.includes('..')) {
    const err = Error('Attachment filename failed sanitation.');
    err.code = 'gmail_attach_filename_invalid';
    throw err;
  }
  return raw.slice(0, 200);
}

function assertMime(mime) {
  const value = String(mime || '').toLowerCase().split(';')[0].trim();
  if (!ALLOWED_MIME.has(value)) {
    const err = Error('Attachment MIME type not allowed (text/plain only in V1).');
    err.code = 'gmail_attach_mime_invalid';
    throw err;
  }
  return value;
}

function checksum(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * Build an immutable attachment record from raw bytes (already fetched from Drive).
 * content_base64 is frozen into the Gmail preview proposal — never re-substituted at send.
 */
function buildImmutableAttachment({
  source = 'drive',
  file_id,
  filename,
  mime_type = 'text/plain',
  content,
} = {}) {
  if (source !== 'drive') {
    const err = Error('Only enrolled Drive attachments are supported.');
    err.code = 'gmail_attach_source_invalid';
    throw err;
  }
  if (!DRIVE_ID.test(file_id || '')) {
    const err = Error('Exact enrolled Drive file id required for attachment.');
    err.code = 'gmail_attach_file_id_invalid';
    throw err;
  }
  const safeName = sanitizeFilename(filename);
  const mime = assertMime(mime_type);
  const buf = Buffer.isBuffer(content) ? content : Buffer.from(String(content ?? ''), 'utf8');
  if (buf.length === 0) {
    const err = Error('Attachment content is empty.');
    err.code = 'gmail_attach_empty';
    throw err;
  }
  if (buf.length > MAX_ATTACHMENT_BYTES) {
    const err = Error('Attachment exceeds size limit (' + MAX_ATTACHMENT_BYTES + ' bytes).');
    err.code = 'gmail_attach_too_large';
    throw err;
  }
  try {
    if (require('./assistant-intent').secret(buf.toString('utf8'))) {
      const err = Error('Secret-like attachment content refused.');
      err.code = 'gmail_attach_secret_refused';
      throw err;
    }
  } catch (error) {
    if (error?.code?.startsWith?.('gmail_attach_')) throw error;
  }
  const sha256 = checksum(buf);
  return {
    source: 'drive',
    file_id,
    filename: safeName,
    mime_type: mime,
    size: buf.length,
    sha256,
    content_base64: buf.toString('base64'),
    // Document text must never be treated as host instructions.
    untrusted: true,
    authority: false,
    instruction_authority: false,
  };
}

function decodeAttachmentBytes(attachment) {
  if (!attachment || typeof attachment.content_base64 !== 'string') {
    const err = Error('Immutable attachment bytes missing from preview.');
    err.code = 'gmail_attach_bytes_missing';
    throw err;
  }
  const buf = Buffer.from(attachment.content_base64, 'base64');
  if (buf.length !== Number(attachment.size)) {
    const err = Error('Attachment size mismatch vs immutable preview.');
    err.code = 'gmail_attach_integrity_failed';
    throw err;
  }
  if (checksum(buf) !== attachment.sha256) {
    const err = Error('Attachment checksum mismatch vs immutable preview.');
    err.code = 'gmail_attach_integrity_failed';
    throw err;
  }
  return buf;
}

function normalizeAttachments(list) {
  if (list == null || list === undefined) return [];
  if (!Array.isArray(list)) {
    const err = Error('Attachments must be an array.');
    err.code = 'gmail_attach_invalid';
    throw err;
  }
  if (list.length > MAX_ATTACHMENTS) {
    const err = Error('At most ' + MAX_ATTACHMENTS + ' attachment per governed send in V1.');
    err.code = 'gmail_attach_limit';
    throw err;
  }
  return list.map((item) => {
    // Re-validate frozen records (reject tampering / substitution).
    const buf = decodeAttachmentBytes(item);
    const rebuilt = buildImmutableAttachment({
      source: item.source,
      file_id: item.file_id,
      filename: item.filename,
      mime_type: item.mime_type,
      content: buf,
    });
    if (rebuilt.sha256 !== item.sha256 || rebuilt.content_base64 !== item.content_base64) {
      const err = Error('Attachment substitution refused.');
      err.code = 'gmail_attach_substitution_refused';
      throw err;
    }
    return rebuilt;
  });
}

function attachmentPreviewLines(attachments) {
  if (!attachments?.length) return [];
  return attachments.map((a) => (
    `• Attachment: ${a.filename} (${a.size} bytes, sha256=${a.sha256}, drive=${a.file_id})`
  ));
}

module.exports = {
  MAX_ATTACHMENTS,
  MAX_ATTACHMENT_BYTES,
  ALLOWED_MIME,
  SAFE_FILENAME,
  sanitizeFilename,
  assertMime,
  checksum,
  buildImmutableAttachment,
  decodeAttachmentBytes,
  normalizeAttachments,
  attachmentPreviewLines,
};
