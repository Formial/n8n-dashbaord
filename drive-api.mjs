import { OAuth2Client } from 'google-auth-library';
import { Readable, Transform } from 'node:stream';
import { createHash } from 'node:crypto';
import { check } from './lib.mjs';

export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
export const DRIVE_APP = 'formial-creative-dashboard-v1';
const api = 'https://www.googleapis.com/drive/v3';
const fields = 'id,name,size,mimeType,parents,trashed,sha256Checksum,appProperties';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

export class DriveStorageError extends Error {
  constructor(code) { super('Google Drive is unavailable. Check its private connection settings and folder access.'); this.name = 'DriveStorageError'; this.code = code; }
}

export function driveOAuth(env = process.env) {
  check(env.GOOGLE_DRIVE_CLIENT_ID && env.GOOGLE_DRIVE_CLIENT_SECRET && env.GOOGLE_DRIVE_REFRESH_TOKEN, 'Configure Google Drive OAuth privately before enabling Drive image storage.');
  const auth = new OAuth2Client(env.GOOGLE_DRIVE_CLIENT_ID, env.GOOGLE_DRIVE_CLIENT_SECRET);
  auth.setCredentials({ refresh_token: env.GOOGLE_DRIVE_REFRESH_TOKEN });
  return auth;
}

export class DriveApi {
  constructor({ auth, folderId, fetchImpl = fetch }) {
    check(/^[A-Za-z0-9_-]{10,200}$/.test(folderId || ''), 'Set GOOGLE_DRIVE_FOLDER_ID to the dedicated app folder.');
    this.auth = auth; this.folderId = folderId; this.fetch = fetchImpl; this.folderCheck = null;
  }
  async request(url, options = {}) {
    let token;
    try { token = (await this.auth.getAccessToken()).token; } catch { throw new DriveStorageError('DRIVE_AUTH'); }
    if (!token) throw new DriveStorageError('DRIVE_AUTH');
    let response;
    try { response = await this.fetch(url, { ...options, headers: { ...options.headers, authorization: 'Bearer ' + token }, redirect: 'error', signal: AbortSignal.timeout(60000) }); }
    catch { throw new DriveStorageError('DRIVE_NETWORK'); }
    if (!response.ok) {
      let code = 'DRIVE_HTTP_' + response.status;
      try {
        const payload = await response.json();
        const reasons = [...(payload.error?.errors || []), ...(payload.error?.details || [])].map(entry => entry.reason);
        if (reasons.some(reason => ['accessNotConfigured', 'SERVICE_DISABLED'].includes(reason))) code = 'DRIVE_API_DISABLED';
        else if (reasons.includes('storageQuotaExceeded')) code = 'DRIVE_QUOTA';
      } catch { await response.body?.cancel().catch(() => {}); }
      throw new DriveStorageError(code);
    }
    return response;
  }
  async checkFolder() {
    this.folderCheck ||= (async () => {
      const url = new URL(api + '/files/' + this.folderId);
      url.searchParams.set('fields', 'id,mimeType,trashed,capabilities(canAddChildren),permissions(type)');
      const folder = await (await this.request(url)).json();
      check(folder.mimeType === 'application/vnd.google-apps.folder' && !folder.trashed && folder.capabilities?.canAddChildren, 'Google Drive folder is missing or not writable.');
      check(!folder.permissions?.some(permission => ['anyone', 'domain'].includes(permission.type)), 'Use a private Google Drive folder, not a publicly or domain-shared folder.');
      return folder;
    })();
    try { return await this.folderCheck; } catch (error) { this.folderCheck = null; throw error; }
  }
  async metadata(fileId) {
    check(/^[A-Za-z0-9_-]{1,200}$/.test(fileId || ''), 'Invalid Drive file ID.');
    const url = new URL(api + '/files/' + fileId); url.searchParams.set('fields', fields);
    return (await this.request(url)).json();
  }
  assertOwned(info, key, type) {
    check(!info.trashed && info.parents?.includes(this.folderId) && info.appProperties?.formialApp === DRIVE_APP && info.appProperties?.formialKey === key && info.appProperties?.formialType === type, 'Drive file is missing or does not belong to this workspace.');
  }
  async locate(key, type) {
    check(/^[a-f0-9-]{36}(?:\.(?:png|jpg|webp|svg)|\/\d+)$/.test(key), 'Invalid Drive file key.');
    check(['image', 'part'].includes(type), 'Invalid Drive file type.');
    const url = new URL(api + '/files');
    url.searchParams.set('q', `'${this.folderId}' in parents and trashed = false and appProperties has { key='formialApp' and value='${DRIVE_APP}' } and appProperties has { key='formialKey' and value='${key}' } and appProperties has { key='formialType' and value='${type}' }`);
    url.searchParams.set('fields', `files(${fields}),nextPageToken`); url.searchParams.set('pageSize', '2');
    const result = await (await this.request(url)).json();
    check(result.files.length <= 1 && !result.nextPageToken, 'Duplicate Drive files need manual review.');
    return result.files[0] || null;
  }
  async upload(bytes, name, mimeType, key, type) {
    await this.checkFolder();
    const hash = sha256(bytes), existing = await this.locate(key, type);
    if (existing) { this.assertOwned(existing, key, type); check(existing.sha256Checksum === hash && Number(existing.size) === bytes.length, 'Drive file already exists with different bytes.'); return existing; }
    const start = new URL('https://www.googleapis.com/upload/drive/v3/files');
    start.searchParams.set('uploadType', 'resumable'); start.searchParams.set('fields', fields);
    const response = await this.request(start, { method: 'POST', headers: { 'content-type': 'application/json', 'x-upload-content-type': mimeType, 'x-upload-content-length': String(bytes.length) }, body: JSON.stringify({ name, mimeType, parents: [this.folderId], appProperties: { formialApp: DRIVE_APP, formialKey: key, formialType: type } }) });
    const location = response.headers.get('location');
    let target; try { target = new URL(location); } catch { throw new DriveStorageError('DRIVE_UPLOAD_LOCATION'); }
    check(target.protocol === 'https:' && target.hostname === 'www.googleapis.com' && !target.username && !target.password && !target.port && target.pathname.startsWith('/upload/drive/'), 'Unexpected Drive upload endpoint.');
    const uploaded = await (await this.request(target, { method: 'PUT', headers: { 'content-type': mimeType, 'content-length': String(bytes.length) }, body: bytes })).json();
    const verified = await this.metadata(uploaded.id);
    this.assertOwned(verified, key, type);
    check(verified.sha256Checksum === hash && Number(verified.size) === bytes.length, 'Drive upload integrity check failed.');
    return verified;
  }
  async stream(info, key, type) {
    const verified = await this.metadata(info.id); this.assertOwned(verified, key, type);
    check(verified.sha256Checksum === info.sha256Checksum && Number(verified.size) === Number(info.size), 'Drive file changed after upload.');
    const url = new URL(api + '/files/' + info.id); url.searchParams.set('alt', 'media');
    const response = await this.request(url); check(response.body, 'Drive download is empty.');
    const source = Readable.fromWeb(response.body), hash = createHash('sha256'); let length = 0;
    const verifiedStream = new Transform({
      transform(chunk, encoding, callback) {
        length += chunk.length;
        if (length > Number(info.size)) { callback(new DriveStorageError('DRIVE_DOWNLOAD_SIZE')); return; }
        hash.update(chunk); callback(null, chunk);
      },
      flush(callback) {
        if (length !== Number(info.size) || hash.digest('hex') !== info.sha256Checksum) callback(new DriveStorageError('DRIVE_DOWNLOAD_INTEGRITY'));
        else callback();
      },
    });
    source.on('error', error => verifiedStream.destroy(error));
    verifiedStream.once('close', () => source.destroy());
    return source.pipe(verifiedStream);
  }
  async read(info, key, type) { const pieces = []; for await (const piece of await this.stream(info, key, type)) pieces.push(piece); const bytes = Buffer.concat(pieces); check(bytes.length === Number(info.size) && sha256(bytes) === info.sha256Checksum, 'Drive download integrity check failed.'); return bytes; }
  async trashPart(info, key) {
    const verified = await this.metadata(info.id); this.assertOwned({ ...verified, trashed: false }, key, 'part');
    if (verified.trashed) return;
    await this.request(api + '/files/' + info.id, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ trashed: true }) });
  }
}
