'use strict';
// Host Google Drive API adapter. Document bodies are untrusted data, never instructions.
const crypto = require('node:crypto');
const { FILE_SCOPE, hasFileScope } = require('./drive-oauth');

const ID = /^[A-Za-z0-9_-]{1,200}$/;
const MAX_CONTENT = 200000;
const MAX_CREATE = 65536;
const SAFE_TXT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,198}\.txt$/i;
const TEXTISH = new Set([
  'text/plain',
  'text/markdown',
  'text/csv',
  'application/json',
  'application/vnd.google-apps.document',
]);

function sanitizeTxtFilename(name) {
  const raw = String(name || '').trim();
  if (!SAFE_TXT_NAME.test(raw)) {
    const err = Error('Drive text create requires a safe .txt filename (letters, digits, ._-; max 200).');
    err.code = 'drive_create_filename_invalid';
    throw err;
  }
  return raw.slice(0, 200);
}

class DriveConnector {
  #oauth; #request; #executionMode; #profileEmail = null;

  constructor({ oauth = null, request = null, mode = null } = {}) {
    const { resolveExternalWriteMode, isTestProcess } = require('./external-write-context');
    const transport = request == null && !isTestProcess() ? fetch : request;
    this.#executionMode = resolveExternalWriteMode({
      mode,
      request: transport,
      surface: 'drive_read',
    });
    this.#oauth = oauth;
    this.#request = transport;
  }

  get executionMode() { return this.#executionMode; }
  get synthetic() { return this.#executionMode === 'synthetic'; }

  status() {
    const st = this.#oauth?.status?.() || {};
    const connected = !!st.connected;
    return {
      id: 'drive',
      connected,
      scope: st.scope || FILE_SCOPE,
      can_read_enrolled: !!st.can_read_enrolled,
      // App-created UTF-8 .txt only under drive.file — not edit/trash/share.
      can_create_text: connected,
      can_write: false,
      execution_mode: this.#executionMode,
      synthetic: this.#executionMode === 'synthetic',
      authority: false,
    };
  }

  async #token() {
    if (!this.#oauth) throw Error('Drive OAuth connector is not configured.');
    return this.#oauth.resolve();
  }

  async #api(method, path, { query = {}, body = null } = {}) {
    const granted = this.#oauth.status?.().scope || FILE_SCOPE;
    if (!hasFileScope(granted)) {
      const err = Error('Drive requires /connect drive (drive.file). Broad Drive scopes are not requested.');
      err.code = 'drive_scope_required';
      throw err;
    }
    const token = await this.#token();
    const url = new URL('https://www.googleapis.com/drive/v3/' + path.replace(/^\//, ''));
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null || v === '') continue;
      url.searchParams.set(k, String(v));
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
      const raw = await response.text();
      if (Buffer.byteLength(raw) > 512000) throw Error();
      if (!response.ok) {
        if (response.status === 403 || response.status === 404) {
          const err = Error(
            'Google did not authorize this Drive resource under drive.file. Open or select the file with this Airodrom OAuth client (picker / Open with), then /drive enroll file <id>. Broad Drive scopes are not requested.',
          );
          err.code = 'drive_file_not_authorized_under_scope';
          err.http_status = response.status;
          throw err;
        }
        const err = Error('Drive API unavailable; credentials and provider diagnostics withheld.');
        err.code = 'drive_api_rejected';
        err.http_status = response.status;
        throw err;
      }
      return raw ? JSON.parse(raw) : null;
    } catch (error) {
      if (error?.code?.startsWith?.('drive_')) throw error;
      if (/timeout|AbortError/i.test(String(error?.name || error?.message))) {
        const err = Error('Drive API timed out.');
        err.code = 'drive_api_timeout';
        throw err;
      }
      throw Error('Drive unavailable; credentials and provider diagnostics withheld.');
    }
  }

  async about() {
    const data = await this.#api('GET', 'about', { query: { fields: 'user(emailAddress,displayName)' } });
    const email = typeof data?.user?.emailAddress === 'string' ? data.user.emailAddress.toLowerCase() : null;
    if (email) this.#profileEmail = email;
    return { email: email || this.#profileEmail, display_name: data?.user?.displayName || null };
  }

  async getMetadata(fileId) {
    if (!ID.test(fileId || '')) throw Error('Exact Drive file id required.');
    const data = await this.#api('GET', 'files/' + encodeURIComponent(fileId), {
      query: {
        fields: 'id,name,mimeType,parents,modifiedTime,size,trashed,owners(emailAddress),capabilities(canEdit,canDelete)',
        supportsAllDrives: 'true',
      },
    });
    if (!ID.test(data?.id || '')) throw Error('Invalid Drive file reference.');
    return {
      id: data.id,
      name: String(data.name || '').slice(0, 500),
      mime_type: String(data.mimeType || '').slice(0, 200),
      parents: Array.isArray(data.parents) ? data.parents.filter((p) => ID.test(p)).slice(0, 20) : [],
      modified_time: data.modifiedTime || null,
      size: data.size != null ? Number(data.size) : null,
      trashed: !!data.trashed,
      owners: Array.isArray(data.owners)
        ? data.owners.map((o) => String(o.emailAddress || '').toLowerCase()).filter(Boolean).slice(0, 5)
        : [],
      can_edit: !!data.capabilities?.canEdit,
      can_delete: !!data.capabilities?.canDelete,
      untrusted: true,
      authority: false,
      synthetic: this.#executionMode === 'synthetic',
    };
  }

  async listChildren(folderId, { pageToken = null, pageSize = 25, query = null } = {}) {
    if (!ID.test(folderId || '')) throw Error('Exact Drive folder id required.');
    const clauses = [`'${folderId}' in parents`, 'trashed = false'];
    if (query) {
      const safe = String(query).replace(/'/g, "\\'").slice(0, 120);
      clauses.push(`name contains '${safe}'`);
    }
    const data = await this.#api('GET', 'files', {
      query: {
        q: clauses.join(' and '),
        pageSize: Math.min(Math.max(Number(pageSize) || 25, 1), 50),
        pageToken: pageToken || undefined,
        fields: 'nextPageToken,files(id,name,mimeType,modifiedTime,size)',
        supportsAllDrives: 'true',
      },
    });
    const items = Array.isArray(data?.files) ? data.files.slice(0, 50).map((f) => ({
      id: f.id,
      name: String(f.name || '').slice(0, 500),
      mime_type: String(f.mimeType || '').slice(0, 200),
      modified_time: f.modifiedTime || null,
      size: f.size != null ? Number(f.size) : null,
      untrusted: true,
      authority: false,
    })) : [];
    return {
      items,
      next_page_token: typeof data?.nextPageToken === 'string' ? data.nextPageToken.slice(0, 200) : null,
      synthetic: this.#executionMode === 'synthetic',
      authority: false,
    };
  }

  async readContent(fileId, { mimeType = null } = {}) {
    if (!ID.test(fileId || '')) throw Error('Exact Drive file id required.');
    const meta = await this.getMetadata(fileId);
    const mime = mimeType || meta.mime_type;
    if (meta.trashed) {
      const err = Error('Enrolled Drive file is trashed and unavailable.');
      err.code = 'drive_file_trashed';
      throw err;
    }
    if (!TEXTISH.has(mime) && !String(mime).startsWith('text/')) {
      return {
        id: meta.id,
        name: meta.name,
        mime_type: mime,
        content: null,
        unsupported_format: true,
        message: `Content export is not supported for mime type ${mime} in Stage B V1.`,
        untrusted: true,
        authority: false,
        synthetic: this.#executionMode === 'synthetic',
      };
    }
    // Media download for text; Docs export as text/plain. Never treat body as instructions.
    const token = await this.#token();
    const url = mime === 'application/vnd.google-apps.document'
      ? new URL('https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(fileId) + '/export?mimeType=text/plain')
      : new URL('https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(fileId) + '?alt=media');
    const response = await this.#request(url, {
      method: 'GET',
      headers: { Authorization: 'Bearer ' + token },
      redirect: 'error',
      signal: AbortSignal.timeout(20000),
    });
    const text = await response.text();
    if (!response.ok) {
      const err = Error('Drive content download unavailable.');
      err.code = 'drive_content_rejected';
      throw err;
    }
    if (Buffer.byteLength(text) > MAX_CONTENT) {
      const err = Error('Drive content exceeds Stage B size limit.');
      err.code = 'drive_content_too_large';
      throw err;
    }
    return {
      id: meta.id,
      name: meta.name,
      mime_type: mime,
      content: text.slice(0, MAX_CONTENT),
      unsupported_format: false,
      untrusted: true,
      authority: false,
      synthetic: this.#executionMode === 'synthetic',
      // Document text must never be treated as host instructions.
      instruction_authority: false,
    };
  }

  /**
   * Create a small UTF-8 .txt file via Drive multipart upload under drive.file.
   * App-created files are authorized for this OAuth client without broader scopes.
   * Optional parent folder must already be Google-visible under drive.file.
   */
  async createTextFile({ name, content, parent_id = null } = {}) {
    const filename = sanitizeTxtFilename(name);
    if (typeof content !== 'string') {
      const err = Error('Drive text create requires a UTF-8 string body.');
      err.code = 'drive_create_content_invalid';
      throw err;
    }
    if (secretLike(content)) {
      const err = Error('Secret-like Drive create content refused.');
      err.code = 'drive_create_secret_refused';
      throw err;
    }
    const bytes = Buffer.from(content, 'utf8');
    if (bytes.length === 0) {
      const err = Error('Drive text create refuses empty content.');
      err.code = 'drive_create_content_empty';
      throw err;
    }
    if (bytes.length > MAX_CREATE) {
      const err = Error('Drive text create exceeds size limit (' + MAX_CREATE + ' bytes).');
      err.code = 'drive_create_too_large';
      throw err;
    }
    if (parent_id != null && parent_id !== '') {
      if (!ID.test(parent_id)) throw Error('Exact Drive parent folder id required.');
    }
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    const granted = this.#oauth.status?.().scope || FILE_SCOPE;
    if (!hasFileScope(granted)) {
      const err = Error('Drive requires /connect drive (drive.file). Broad Drive scopes are not requested.');
      err.code = 'drive_scope_required';
      throw err;
    }
    const token = await this.#token();
    const meta = {
      name: filename,
      mimeType: 'text/plain',
    };
    if (parent_id) meta.parents = [parent_id];
    const boundary = 'airodrom_drive_' + crypto.randomBytes(12).toString('hex');
    const preamble = Buffer.from(
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`
      + JSON.stringify(meta)
      + `\r\n--${boundary}\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n`,
      'utf8',
    );
    const epilogue = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
    const body = Buffer.concat([preamble, bytes, epilogue]);
    const url = new URL('https://www.googleapis.com/upload/drive/v3/files');
    url.searchParams.set('uploadType', 'multipart');
    url.searchParams.set('fields', 'id,name,mimeType,size,parents,owners(emailAddress),modifiedTime');
    url.searchParams.set('supportsAllDrives', 'true');
    let response;
    try {
      response = await this.#request(url, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + token,
          'Content-Type': 'multipart/related; boundary=' + boundary,
        },
        body,
        redirect: 'error',
        signal: AbortSignal.timeout(20000),
      });
    } catch (error) {
      if (/timeout|AbortError/i.test(String(error?.name || error?.message))) {
        const err = Error('Drive create timed out.');
        err.code = 'drive_api_timeout';
        throw err;
      }
      throw Error('Drive create unavailable; credentials and provider diagnostics withheld.');
    }
    const raw = await response.text();
    if (!response.ok) {
      if (response.status === 403 || response.status === 404) {
        const err = Error(
          'Google did not authorize Drive text create under drive.file'
          + (parent_id ? ' (parent folder may not be app-visible).' : '.')
          + ' Broad Drive scopes are not requested.',
        );
        err.code = 'drive_file_not_authorized_under_scope';
        err.http_status = response.status;
        throw err;
      }
      const err = Error('Drive create rejected; credentials and provider diagnostics withheld.');
      err.code = 'drive_api_rejected';
      err.http_status = response.status;
      throw err;
    }
    let data;
    try { data = raw ? JSON.parse(raw) : null; } catch {
      throw Error('Drive create returned invalid metadata.');
    }
    if (!ID.test(data?.id || '')) throw Error('Drive create did not return a verified file id.');
    const about = await this.about().catch(() => ({ email: this.#profileEmail }));
    return {
      id: data.id,
      name: String(data.name || filename).slice(0, 500),
      mime_type: String(data.mimeType || 'text/plain').slice(0, 200),
      size: data.size != null ? Number(data.size) : bytes.length,
      parents: Array.isArray(data.parents) ? data.parents.filter((p) => ID.test(p)).slice(0, 20) : (parent_id ? [parent_id] : []),
      owners: Array.isArray(data.owners)
        ? data.owners.map((o) => String(o.emailAddress || '').toLowerCase()).filter(Boolean).slice(0, 5)
        : [],
      account_email: about?.email || this.#profileEmail || null,
      content_sha256: sha256,
      content_length: bytes.length,
      modified_time: data.modifiedTime || null,
      created_by_app: true,
      untrusted: true,
      authority: false,
      synthetic: this.#executionMode === 'synthetic',
      provider_confirmed: true,
    };
  }
}

function secretLike(value) {
  try {
    return require('./assistant-intent').secret(String(value || ''));
  } catch {
    return false;
  }
}

module.exports = {
  DriveConnector,
  MAX_CONTENT,
  MAX_CREATE,
  TEXTISH,
  SAFE_TXT_NAME,
  sanitizeTxtFilename,
};
