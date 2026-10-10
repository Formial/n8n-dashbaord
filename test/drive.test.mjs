import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DriveApi, DRIVE_APP } from '../drive-api.mjs';
import { DriveImages } from '../drive-images.mjs';
import { LocalStorage, digest } from '../storage.mjs';
import { beginUpload, writeUploadPart, finishUpload, CHUNK_BYTES } from '../transfers.mjs';
import { updateDriveSecrets, parseEnv } from '../scripts/env-file.mjs';
import { png } from './fixtures.mjs';

export function fakeDrive() {
  const folderId = 'private-folder-12345', objects = new Map(), uploads = new Map(), calls = []; let counter = 0;
  const json = body => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  const metadata = object => ({ id: object.id, name: object.name, mimeType: object.mimeType, parents: [folderId], size: String(object.bytes.length), sha256Checksum: digest(object.bytes), appProperties: object.appProperties, trashed: object.trashed || false });
  const fetchImpl = async (input, options = {}) => {
    const url = new URL(input); assert.equal(url.hostname, 'www.googleapis.com'); assert.equal(options.headers.authorization, 'Bearer test-access'); assert.equal(options.redirect, 'error'); calls.push({ url, method: options.method || 'GET' });
    if (url.pathname === '/drive/v3/files/' + folderId) return json({ id: folderId, mimeType: 'application/vnd.google-apps.folder', capabilities: { canAddChildren: true }, permissions: [{ type: 'user' }] });
    if (url.pathname === '/drive/v3/files') {
      const query = url.searchParams.get('q'), key = query.match(/key='formialKey' and value='([^']+)'/)[1], type = query.match(/key='formialType' and value='([^']+)'/)[1];
      return json({ files: [...objects.values()].filter(object => !object.trashed && object.appProperties.formialKey === key && object.appProperties.formialType === type).map(metadata) });
    }
    if (url.pathname.startsWith('/upload/drive/')) {
      if (options.method === 'POST') { const uploadId = String(++counter); uploads.set(uploadId, JSON.parse(options.body)); return new Response(null, { headers: { location: 'https://www.googleapis.com/upload/drive/v3/files?upload_id=' + uploadId } }); }
      const body = uploads.get(url.searchParams.get('upload_id')), id = 'drive-' + counter; objects.set(id, { ...body, id, bytes: Buffer.from(options.body) }); return json({ id });
    }
    const object = objects.get(url.pathname.split('/').at(-1));
    if (!object) return new Response('{}', { status: 404 });
    if (options.method === 'PATCH') { assert.deepEqual(JSON.parse(options.body), { trashed: true }); object.trashed = true; return json(metadata(object)); }
    if (url.searchParams.get('alt') === 'media') return new Response(object.downloadBytes || object.bytes);
    return json(metadata(object));
  };
  return { client: new DriveApi({ auth: { getAccessToken: async () => ({ token: 'test-access' }) }, folderId, fetchImpl }), objects, calls };
}

test('Drive preserves private image bytes and rejects altered content and foreign folders', async () => {
  const fake = fakeDrive(), store = new LocalStorage(mkdtempSync(join(tmpdir(), 'formial-drive-'))), images = new DriveImages(store, fake.client), bytes = png();
  const file = await images.putFile(bytes, 'png'); assert((await images.readFile(file)).equals(bytes));
  assert.equal((await store.get('driveFiles', file)).hash, digest(bytes));
  assert(!JSON.stringify(await store.get('driveFiles', file)).includes(bytes.toString('base64')));
  await images.putFile(bytes, 'png', file); assert.equal(fake.objects.size, 1);
  await assert.rejects(images.putFile(Buffer.concat([bytes, Buffer.from('different')]), 'png', file), /different/);
  const object = [...fake.objects.values()][0]; object.downloadBytes = Buffer.alloc(bytes.length, 4);
  await assert.rejects(images.readFile(file), /Drive/); delete object.downloadBytes;
  object.appProperties.formialApp = 'another-app'; await assert.rejects(images.readFile(file), /workspace/);
  assert(!fake.calls.some(call => call.url.pathname.includes('/permissions')));
});

test('Drive uses recoverable trash only for its own temporary parts and Mongo metadata has no part bytes', async () => {
  const fake = fakeDrive(), metadata = new LocalStorage(mkdtempSync(join(tmpdir(), 'formial-drive-part-'))), images = new DriveImages(metadata, fake.client);
  const store = { get: metadata.get.bind(metadata), list: metadata.list.bind(metadata), insert: metadata.insert.bind(metadata), mutate: metadata.mutate.bind(metadata), putPart: images.putPart.bind(images), readParts: images.readParts.bind(images), clearParts: images.clearParts.bind(images), putFile: images.putFile.bind(images) };
  const bytes = Buffer.concat([png(), Buffer.alloc(CHUNK_BYTES + 11)]), transfer = await beginUpload(store, { name: 'reference.png', mimeType: 'image/png', size: bytes.length, owner: 'owner' });
  let upload = await store.get('uploads', transfer.uploadId);
  for (let index = 0; index < transfer.parts; index++) await writeUploadPart(store, upload, index, bytes.subarray(index * CHUNK_BYTES, (index + 1) * CHUNK_BYTES));
  const parts = await store.list('driveParts'); assert.equal(parts.length, 2); assert(parts.every(part => !part.bytes && !part.data && part.state === 'ready'));
  await writeUploadPart(store, upload, 0, bytes.subarray(0, CHUNK_BYTES));
  const completed = await finishUpload(store, upload); assert((await images.readFile(completed.file)).equals(bytes));
  assert.equal((await store.list('driveParts')).length, 0);
  assert.equal([...fake.objects.values()].filter(object => object.trashed).length, 2);
  assert.equal([...fake.objects.values()].filter(object => !object.trashed && object.appProperties.formialType === 'image').length, 1);
  assert(!fake.calls.some(call => call.method === 'DELETE'));
});

test('A failed Drive upload can recover without changing verified originals', async () => {
  const fake = fakeDrive(), store = new LocalStorage(mkdtempSync(join(tmpdir(), 'formial-drive-retry-'))), images = new DriveImages(store, fake.client);
  const original = fake.client.upload.bind(fake.client); let fail = true;
  fake.client.upload = async (...args) => { const result = await original(...args); if (fail) { fail = false; throw new Error('Lost acknowledgement'); } return result; };
  const filename = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.png';
  await assert.rejects(images.putFile(png(), 'png', filename), /acknowledgement/);
  assert.equal((await store.get('driveFiles', filename)).state, 'pending');
  await images.putFile(png(), 'png', filename); assert.equal(fake.objects.size, 1);
});

test('OAuth secret updates preserve unrelated private settings and cannot inject env lines', () => {
  const source = 'MONGODB_URI="mongodb+srv://example.invalid/formial"\nDASHBOARD_PASSWORD="private # value"\nIMAGE_STORAGE_BACKEND=gridfs\n';
  const output = updateDriveSecrets(source, { GOOGLE_DRIVE_REFRESH_TOKEN: 'test/refresh-token', GOOGLE_DRIVE_FOLDER_ID: 'folder-12345' }), env = parseEnv(output);
  assert.equal(env.DASHBOARD_PASSWORD, 'private # value'); assert.equal(env.IMAGE_STORAGE_BACKEND, 'gridfs'); assert.equal(env.GOOGLE_DRIVE_REFRESH_TOKEN, 'test/refresh-token');
  assert.throws(() => updateDriveSecrets(source, { GOOGLE_DRIVE_REFRESH_TOKEN: 'secret\nEXTRA=1' }));
  assert.throws(() => updateDriveSecrets(source, { MONGODB_URI: 'changed' }));
});

test('Drive rejects public folders and unsafe upload locations without exposing access tokens', async () => {
  const publicDrive = new DriveApi({ auth: { getAccessToken: async () => ({ token: 'private-token' }) }, folderId: 'folder-12345', fetchImpl: async () => new Response(JSON.stringify({ mimeType: 'application/vnd.google-apps.folder', capabilities: { canAddChildren: true }, permissions: [{ type: 'anyone' }] })) });
  await assert.rejects(publicDrive.checkFolder(), /private/);
  const failed = new DriveApi({ auth: { getAccessToken: async () => { throw new Error('private-token'); } }, folderId: 'folder-12345' });
  await assert.rejects(failed.checkFolder(), error => error.code === 'DRIVE_AUTH' && !error.message.includes('private-token'));
  const fake = fakeDrive(), originalFetch = fake.client.fetch;
  fake.client.fetch = async (url, options) => options.method === 'POST'
    ? new Response(null, { headers: { location: 'https://untrusted.example/upload/drive/v3/files' } })
    : originalFetch(url, options);
  await assert.rejects(fake.client.upload(png(), 'creative.png', 'image/png', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.png', 'image'), /Unexpected Drive upload endpoint/);
  await assert.rejects(fake.client.metadata('../permissions'), /Invalid Drive file ID/);
  await assert.rejects(fake.client.locate('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.png', "image'"), /Invalid Drive file type/);
  assert(!fake.calls.some(call => call.method === 'PUT'));
  assert.equal(DRIVE_APP, 'formial-creative-dashboard-v1');
});

test('Drive disabled-API diagnostics inspect only whitelisted error reasons', async () => {
  const client = new DriveApi({ auth: { getAccessToken: async () => ({ token: 'private-token' }) }, folderId: 'folder-12345', fetchImpl: async () => new Response(JSON.stringify({ error: { message: 'private-token', details: [{ reason: 'SERVICE_DISABLED' }] } }), { status: 403 }) });
  await assert.rejects(client.checkFolder(), error => error.code === 'DRIVE_API_DISABLED' && !error.message.includes('private-token'));
});
