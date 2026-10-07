import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LocalStorage, mongoDnsServers } from '../storage.mjs';
import { beginUpload, writeUploadPart, finishUpload, CHUNK_BYTES } from '../transfers.mjs';
import { png } from './fixtures.mjs';

test('MongoDB DNS overrides accept only IP addresses and remain optional', () => {
  assert.deepEqual(mongoDnsServers(), []);
  assert.deepEqual(mongoDnsServers('1.1.1.1, 8.8.8.8'), ['1.1.1.1', '8.8.8.8']);
  assert.throws(() => mongoDnsServers('https://example.com'), /IP addresses/);
  assert.throws(() => mongoDnsServers('1.1.1.1,'), /IP addresses/);
});

test('Upload parts enforce size, signatures, completeness and idempotent byte equality', async () => {
  const store = new LocalStorage(mkdtempSync(join(tmpdir(), 'formial-transfer-'))), bytes = Buffer.concat([png(), Buffer.alloc(CHUNK_BYTES + 11)]);
  const transfer = await beginUpload(store, { name: 'reference.png', mimeType: 'image/png', size: bytes.length, owner: 'test-owner' });
  let upload = await store.get('uploads', transfer.uploadId);
  await assert.rejects(finishUpload(store, upload), /incomplete/);
  upload = await store.get('uploads', transfer.uploadId);
  await assert.rejects(writeUploadPart(store, upload, 0, Buffer.alloc(1)), /size/);
  await writeUploadPart(store, upload, 0, bytes.subarray(0, CHUNK_BYTES));
  await writeUploadPart(store, upload, 0, bytes.subarray(0, CHUNK_BYTES));
  await assert.rejects(writeUploadPart(store, upload, 0, Buffer.alloc(CHUNK_BYTES, 3)), /different/);
  await writeUploadPart(store, upload, 1, bytes.subarray(CHUNK_BYTES));
  const result = await finishUpload(store, upload); assert((await store.readFile(result.file)).equals(bytes));
  assert.deepEqual(await finishUpload(store, await store.get('uploads', transfer.uploadId)), result);
  await assert.rejects(beginUpload(store, { name: 'bad.svg', mimeType: 'image/svg+xml', size: 12, owner: 'test-owner' }), /type/);
});
