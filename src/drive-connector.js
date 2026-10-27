'use strict';
// Host Google Drive API adapter. Document bodies are untrusted data, never instructions.
const { FILE_SCOPE, hasFileScope } = require('./drive-oauth');

const ID = /^[A-Za-z0-9_-]{1,200}$/;
const MAX_CONTENT = 200000;
const TEXTISH = new Set([
  'text/plain',
  'text/markdown',
  'text/csv',
  'application/json',
  'application/vnd.google-apps.document',
]);

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
    return {
      id: 'drive',
      connected: !!st.connected,
      scope: st.scope || FILE_SCOPE,
      can_read_enrolled: !!st.can_read_enrolled,
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
}

module.exports = { DriveConnector, MAX_CONTENT, TEXTISH };
