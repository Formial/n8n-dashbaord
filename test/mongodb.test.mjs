import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { connectMongo, digest, APP_MARKER } from '../storage.mjs';
import { createApp } from '../dashboard-server.mjs';
import { CHUNK_BYTES } from '../transfers.mjs';
import { defaults } from '../lib.mjs';
import { Readable } from 'node:stream';
import { png, review } from './fixtures.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let mongo, firstStore, secondStore;
before(async () => {
  mongo = await MongoMemoryServer.create({ binary: { version: '8.0.17', downloadDir: resolve(root, '.runtime/mongodb-binaries') }, instance: { ip: '127.0.0.1' } });
  firstStore = await connectMongo(mongo.getUri(), 'formial_test');
  secondStore = await connectMongo(mongo.getUri(), 'formial_test');
});
after(async () => { await firstStore?.close(); await secondStore?.close(); await mongo?.stop(); });

test('Drive-backed MongoDB stores no new image or part bytes and preserves legacy GridFS images', async t => {
  const legacy = await connectMongo(mongo.getUri(), 'formial_drive_test', 'creatives-n8n', { imageBackend: 'gridfs' }); t.after(() => legacy.close());
  const original = png(), oldFile = await legacy.putFile(original, 'png');
  const initialChunks = await legacy.database.collection('creatives-n8n.chunks').countDocuments();
  const files = new Map(); let serial = 0;
  const client = {
    upload: async (bytes, name, mimeType, key, type) => {
      const info = { id: 'fake-drive-' + (++serial), size: String(bytes.length), sha256Checksum: digest(bytes), key, type };
      files.set(info.id, { ...info, bytes: Buffer.from(bytes), mimeType }); return info;
    },
    metadata: async key => files.get(key),
    assertOwned: (info, key, type) => { assert.equal(info.key, key); assert.equal(info.type, type); },
    stream: async info => Readable.from([files.get(info.id).bytes]),
    read: async info => Buffer.from(files.get(info.id).bytes),
    trashPart: async (info, key) => { assert.equal(files.get(info.id).key, key); files.get(info.id).trashed = true; },
  };
  const store = await connectMongo(mongo.getUri(), 'formial_drive_test', 'creatives-n8n', { imageBackend: 'drive', drive: { client } }); t.after(() => store.close());
  assert((await store.readFile(oldFile)).equals(original), 'Legacy image remains readable before migration');
  const bytes = Buffer.concat([png(), Buffer.alloc(CHUNK_BYTES + 17)]), file = await store.putFile(bytes, 'png');
  assert((await store.readFile(file)).equals(bytes));
  const uploadId = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
  await store.putPart(uploadId, 0, bytes.subarray(0, CHUNK_BYTES), new Date(Date.now() + 60000));
  const parts = await store.readParts(uploadId); assert(parts[0].bytes.equals(bytes.subarray(0, CHUNK_BYTES)));
  const metadata = await store.list('driveParts'); assert(metadata.every(value => !value.bytes && !value.data));
  assert.equal(await store.collection('uploads').countDocuments({ app: APP_MARKER, kind: 'uploadPart' }), 0);
  assert.equal(await store.database.collection('creatives-n8n.chunks').countDocuments(), initialChunks);
  await store.putFile(original, 'png', oldFile); assert((await store.readFile(oldFile)).equals(original));
  assert.equal(await store.database.collection('creatives-n8n.chunks').countDocuments(), initialChunks);
  await store.clearParts(uploadId); assert.equal((await store.list('driveParts')).length, 0);
});

test('Real MongoDB keeps concurrent updates, GridFS image bytes, sessions and TTL indexes across instances', async () => {
  const legacy = { _id: 'existing-unrelated-creative', description: 'Existing record', expiresAt: new Date(0) };
  await firstStore.database.collection('creatives-n8n').insertOne(legacy);
  assert.equal((await firstStore.list('presets')).length, 0);
  await firstStore.insert('presets', { id: 'concurrent-counter', count: 0 });
  await Promise.all(Array.from({ length: 6 }, (_, index) => (async () => {
    const store = index % 2 ? firstStore : secondStore;
    for (let iteration = 0; iteration < 10; iteration++) await store.mutate('presets', 'concurrent-counter', value => { value.count++; });
  })()));
  assert.equal((await secondStore.get('presets', 'concurrent-counter')).count, 60);
  const bytes = Buffer.concat([png(), Buffer.alloc(CHUNK_BYTES + 19, 12)]);
  const file = await firstStore.putFile(bytes, 'png');
  assert((await secondStore.readFile(file)).equals(bytes));
  assert.equal((await secondStore.fileInfo(file)).metadata.sha256, digest(bytes));
  const indexes = await secondStore.collection('sessions').indexes();
  assert(indexes.some(index => index.key.expiresAt === 1 && index.expireAfterSeconds === 0 && index.partialFilterExpression.app === APP_MARKER));
  assert.deepEqual(await secondStore.database.collection('creatives-n8n').findOne({ _id: legacy._id }), legacy);
  const names = (await secondStore.database.listCollections({}, { nameOnly: true }).toArray()).map(value => value.name).sort();
  assert.deepEqual(names, ['creatives-n8n', 'creatives-n8n.chunks', 'creatives-n8n.files']);
});

test('MongoDB/version 2 API handles chunked references and >4.5 MB results without image data in callbacks', async t => {
  let envelope;
  const receiver = http.createServer(async (req, res) => { let data = ''; for await (const chunk of req) data += chunk; envelope = JSON.parse(data); res.writeHead(202); res.end('{}'); });
  receiver.listen(0, '127.0.0.1'); await once(receiver, 'listening'); t.after(() => new Promise(resolve => receiver.close(resolve)));
  const apps = [firstStore, secondStore].map(storage => createApp({ storage, backend: 'mongodb', mode: 'n8n', password: 'test-only-private-password', payloadVersion: 2, n8nUrl: `http://127.0.0.1:${receiver.address().port}`, n8nSecret: 'test-only-webhook-secret', publicUrl: 'http://127.0.0.1:3000' }));
  for (const app of apps) { app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening'); t.after(async () => { app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve)); }); }
  let cookie = '';
  async function request(index, path, body, method = 'GET', headers = {}) {
    return fetch(`http://127.0.0.1:${apps[index].server.address().port}` + path, { method, headers: { cookie, ...(body && !Buffer.isBuffer(body) ? { 'content-type': 'application/json' } : {}), ...headers }, body: body ? Buffer.isBuffer(body) ? body : JSON.stringify(body) : undefined });
  }
  const login = await request(0, '/api/session', { password: 'test-only-private-password' }, 'POST'); assert.equal(login.status, 200); cookie = login.headers.get('set-cookie').split(';')[0];
  assert.equal((await request(1, '/api/jobs')).status, 200, 'Session works on another instance');
  assert.equal((await (await request(1, '/api/config')).json()).uploadProtocol, 'chunked');
  async function transfer(bytes, route, headers = {}) {
    const started = await request(0, route, { version: 2, candidateId: 1, name: 'image.png', size: bytes.length, mimeType: 'image/png' }, 'POST', headers); assert.equal(started.status, 201); const upload = await started.json();
    for (let part = 0; part < upload.parts; part++) {
      const response = await request(part % 2, `/api/uploads/${upload.uploadId}/parts/${part}`, bytes.subarray(part * CHUNK_BYTES, (part + 1) * CHUNK_BYTES), 'PUT', { 'content-type': 'application/octet-stream', ...headers }); assert.equal(response.status, 200);
    }
    const finished = await request(1, `/api/uploads/${upload.uploadId}/finalize`, {}, 'POST', headers); assert.equal(finished.status, 200); return finished.json();
  }
  const referenceBytes = Buffer.concat([png(), Buffer.alloc(CHUNK_BYTES + 13)]), reference = await transfer(referenceBytes, '/api/uploads');
  const asset = await (await request(0, '/api/assets', { role: 'logo', uploadId: reference.uploadId }, 'POST')).json(); assert.equal(asset.mimeType, 'image/png');
  const created = await request(1, '/api/jobs', { brief: defaults, savedAssets: [{ id: asset.id, field: 'logo' }], uploads: [{ uploadId: reference.uploadId, field: 'reference_image' }] }, 'POST'); assert.equal(created.status, 202);
  const job = await created.json(); assert.equal(envelope.version, 2); assert.equal(envelope.files.length, 2); assert(envelope.files.every(file => file.url && !file.data)); assert(JSON.stringify(envelope).length < 10000); assert(!('callbackToken' in job));
  const headers = { authorization: 'Bearer ' + envelope.callbackToken }, referenceRoute = new URL(envelope.files[0].url).pathname;
  assert.equal((await request(0, referenceRoute)).status, 401);
  const downloaded = await request(0, referenceRoute, null, 'GET', headers); assert.equal(downloaded.status, 200); assert.equal(downloaded.headers.get('content-length'), null); assert(Buffer.from(await downloaded.arrayBuffer()).equals(referenceBytes));
  const callback = '/api/n8n/callback/' + job.id;
  assert.equal((await request(0, callback, { version: 2, jobId: job.id, event: 'progress', stage: 'generating' }, 'POST', headers)).status, 200);
  await request(1, callback, { version: 2, jobId: job.id, event: 'progress', stage: 'directing' }, 'POST', headers); assert.equal((await secondStore.get('jobs', job.id)).status, 'generating');
  const generated = Buffer.concat([png(1856, 2304), Buffer.alloc(5 * CHUNK_BYTES + 7)]), uploaded = await transfer(generated, callback + '/uploads', headers);
  const payload = { version: 2, jobId: job.id, event: 'complete', status: 'qa_pass', selectedId: 1, report: { model_assessment_only: true, selected_candidate: 1, status: 'qa_pass', requested_size: '1856x2304', image_resolution: '2K', repair_attempted: false }, candidates: [{ id: 1, file: uploaded.file, uploadId: uploaded.uploadId, mimeType: 'image/png', review: review() }] };
  assert(JSON.stringify(payload).length < 10000);
  assert.equal((await request(0, callback, { ...payload, candidates: [{ ...payload.candidates[0], file: reference.file }] }, 'POST', headers)).status, 400);
  const completed = await request(1, callback, payload, 'POST', headers); assert.equal(completed.status, 200);
  const result = await (await request(0, '/api/jobs/' + job.id)).json(); assert.equal(result.status, 'complete'); assert.equal(result.candidates[0].width, 1856); assert(!JSON.stringify(result).includes(envelope.callbackToken));
  const image = await request(0, '/api/files/' + uploaded.file); assert.equal(image.headers.get('content-length'), null); assert(Buffer.from(await image.arrayBuffer()).equals(generated));
  const archive = await request(1, '/api/jobs/' + job.id + '/archive'); assert.equal(archive.status, 200); assert.equal(archive.headers.get('content-length'), null); assert.equal(Buffer.from(await archive.arrayBuffer()).readUInt32LE(0), 0x04034b50);
  const replay = await (await request(0, callback, { version: 2, jobId: job.id, event: 'failed' }, 'POST', headers)).json(); assert.equal(replay.ignored, true); assert.equal((await secondStore.get('jobs', job.id)).status, 'complete');
  await request(1, '/api/logout', {}, 'POST'); assert.equal((await request(0, '/api/jobs')).status, 401);
});
