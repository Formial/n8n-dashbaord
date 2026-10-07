import { check, id, imageMime, FILE_LIMIT } from './lib.mjs';
import { digest } from './storage.mjs';

export const CHUNK_BYTES = 1024 * 1024;
export async function beginUpload(store, specification) {
  const { name, mimeType, size, owner, jobId = null, candidateId = null } = specification;
  check(typeof name === 'string' && name.length > 0 && name.length <= 150, 'Invalid image name.');
  check((jobId ? ['image/png', 'image/jpeg'] : ['image/png', 'image/jpeg', 'image/webp']).includes(mimeType), 'Invalid image type.');
  check(Number.isInteger(size) && size > 0 && size <= (jobId ? 19500000 : FILE_LIMIT), 'Invalid image size.');
  const active = (await store.list('uploads')).filter(value => value.owner === owner && value.state !== 'ready' && new Date(value.expiresAt) > new Date());
  check(active.length < 32, 'Too many unfinished uploads.', 429);
  const upload = { id: id(), name, mimeType, size, owner, jobId, candidateId, state: 'pending', file: id() + '.' + ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }[mimeType]), createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 24 * 3600000) };
  await store.insert('uploads', upload);
  return { uploadId: upload.id, chunkBytes: CHUNK_BYTES, parts: Math.ceil(size / CHUNK_BYTES) };
}
export async function writeUploadPart(store, upload, index, bytes) {
  check(upload.state === 'pending', 'Upload is not accepting parts.', 409);
  const count = Math.ceil(upload.size / CHUNK_BYTES);
  check(Number.isInteger(index) && index >= 0 && index < count, 'Invalid part index.');
  check(bytes.length === Math.min(CHUNK_BYTES, upload.size - index * CHUNK_BYTES), 'Incorrect part size.');
  await store.putPart(upload.id, index, bytes, new Date(upload.expiresAt));
  return { ok: true };
}
export async function finishUpload(store, upload) {
  const describe = value => ({ uploadId: value.id, file: value.file, name: value.name, size: value.size, mimeType: value.mimeType });
  if (upload.state === 'ready') return describe(upload);
  const claim = id();
  const claimed = await store.mutate('uploads', upload.id, value => {
    check(value.state === 'pending' || value.state === 'assembling' && Date.parse(value.leaseUntil) < Date.now(), 'Upload is already being finalized.', 409);
    value.state = 'assembling'; value.claim = claim; value.leaseUntil = new Date(Date.now() + 120000).toISOString();
  });
  check(claimed?.claim === claim, 'Upload could not be finalized.', 409);
  try {
    const parts = await store.readParts(upload.id), count = Math.ceil(upload.size / CHUNK_BYTES);
    check(parts.length === count && parts.every((part, index) => part.index === index && part.bytes.length === Math.min(CHUNK_BYTES, upload.size - index * CHUNK_BYTES) && digest(part.bytes) === part.hash), 'Upload is incomplete or corrupt.');
    const bytes = Buffer.concat(parts.map(part => part.bytes));
    check(bytes.length === upload.size && imageMime(bytes) === upload.mimeType, 'Image signature does not match the upload.');
    await store.putFile(bytes, upload.file.split('.').at(-1), upload.file);
    const result = await store.mutate('uploads', upload.id, value => { check(value.claim === claim, 'Upload claim expired.', 409); value.state = 'ready'; delete value.claim; delete value.leaseUntil; });
    await store.clearParts(upload.id); return describe(result);
  } catch (error) {
    await store.mutate('uploads', upload.id, value => { if (value.claim !== claim) return false; value.state = 'pending'; delete value.claim; delete value.leaseUntil; });
    throw error;
  }
}
