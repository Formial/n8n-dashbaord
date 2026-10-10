import { DriveApi, driveOAuth } from './drive-api.mjs';
import { check, id } from './lib.mjs';
import { digest } from './storage.mjs';

const pattern = /^[a-f0-9-]{36}\.(png|jpg|webp|svg)$/;
const types = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', svg: 'image/svg+xml' };

export class DriveImages {
  constructor(store, client) { this.store = store; this.client = client; }
  async saveBytes(kind, key, bytes, name, mimeType, type, extra = {}) {
    const hash = digest(bytes), claim = id();
    try { await this.store.insert(kind, { id: key, hash, size: bytes.length, mimeType, state: 'pending', ...extra }); }
    catch (error) { if (error.code !== 11000 && error.status !== 409) throw error; }
    let record = await this.store.get(kind, key);
    check(record.hash === hash && record.size === bytes.length, 'A different Drive record already exists.', 409);
    if (record.state === 'ready') {
      const info = await this.client.metadata(record.driveId); this.client.assertOwned(info, key, type);
      check(info.sha256Checksum === hash && Number(info.size) === bytes.length, 'Stored Drive bytes changed.'); return record;
    }
    record = await this.store.mutate(kind, key, value => {
      check(value.state === 'pending' || value.state === 'uploading' && Date.parse(value.leaseUntil) < Date.now(), 'Drive upload is already in progress.', 409);
      value.state = 'uploading'; value.claim = claim; value.leaseUntil = new Date(Date.now() + 180000).toISOString();
    });
    try {
      const info = await this.client.upload(bytes, name, mimeType, key, type);
      return await this.store.mutate(kind, key, value => { check(value.claim === claim, 'Drive upload claim expired.', 409); value.state = 'ready'; value.driveId = info.id; value.createdAt ||= new Date().toISOString(); delete value.claim; delete value.leaseUntil; });
    } catch (error) {
      await this.store.mutate(kind, key, value => { if (value.claim !== claim) return false; value.state = 'pending'; delete value.claim; delete value.leaseUntil; });
      throw error;
    }
  }
  async putFile(bytes, extension, filename = `${id()}.${extension}`) {
    check(pattern.test(filename) && types[extension], 'Invalid image file name.');
    await this.saveBytes('driveFiles', filename, bytes, filename, types[extension], 'image');
    return filename;
  }
  async fileInfo(filename) {
    if (!pattern.test(filename)) return null;
    const record = await this.store.get('driveFiles', filename); if (!record) return null;
    check(record.state === 'ready', 'Drive image is not ready.', 409);
    const info = await this.client.metadata(record.driveId); this.client.assertOwned(info, filename, 'image');
    check(info.sha256Checksum === record.hash && Number(info.size) === record.size, 'Stored Drive image changed.');
    return { id: info.id, size: record.size, sha256Checksum: record.hash, metadata: { sha256: record.hash }, mimeType: record.mimeType };
  }
  async fileStream(filename) { const info = await this.fileInfo(filename); check(info, 'Drive image not found.', 404); return this.client.stream(info, filename, 'image'); }
  async readFile(filename) { const info = await this.fileInfo(filename); check(info, 'Drive image not found.', 404); return this.client.read(info, filename, 'image'); }
  async putPart(uploadId, index, bytes, expiresAt) {
    check(/^[a-f0-9-]{36}$/.test(uploadId) && Number.isInteger(index) && index >= 0, 'Invalid upload part.');
    const key = uploadId + '/' + index;
    await this.saveBytes('driveParts', key, bytes, uploadId + '-' + index + '.part', 'application/octet-stream', 'part', { uploadId, index, expiresAt });
  }
  async readParts(uploadId) {
    const records = (await this.store.list('driveParts')).filter(record => record.uploadId === uploadId && record.state === 'ready').sort((a, b) => a.index - b.index), parts = [];
    for (const record of records) parts.push({ index: record.index, hash: record.hash, bytes: await this.client.read({ id: record.driveId, size: record.size, sha256Checksum: record.hash }, record.id, 'part') });
    return parts;
  }
  async clearParts(uploadId) {
    for (const record of (await this.store.list('driveParts')).filter(value => value.uploadId === uploadId && value.state === 'ready')) { await this.client.trashPart({ id: record.driveId }, record.id); await this.store.remove('driveParts', record.id); }
  }
}

export function configureDriveImages(store, options = {}) {
  const client = options.client || new DriveApi({ auth: options.auth || driveOAuth(), folderId: options.folderId || process.env.GOOGLE_DRIVE_FOLDER_ID });
  store.images = new DriveImages(store, client); store.imageBackend = 'drive'; return store;
}
