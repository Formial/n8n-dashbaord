import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, createReadStream } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createHash } from 'node:crypto';
import dns from 'node:dns';
import { isIP } from 'node:net';
import { MongoClient, GridFSBucket } from 'mongodb';
import { check, id } from './lib.mjs';

export const digest = value => createHash('sha256').update(value).digest('hex');
const collections = ['assets', 'presets', 'jobs', 'sessions', 'loginWindows', 'uploads'];
const copy = value => value == null ? value : structuredClone(value);
const filePattern = /^[a-f0-9-]{36}\.(png|jpg|webp|svg)$/;
export const APP_MARKER = 'formial-creative-dashboard-v1';

export function mongoDnsServers(value = '') {
  if (!value) return [];
  const servers = value.split(',').map(server => server.trim());
  check(servers.length <= 3 && servers.every(server => isIP(server)), 'MONGODB_DNS_SERVERS must contain DNS server IP addresses.');
  return servers;
}

export class LocalStorage {
  constructor(dataDir) {
    this.kind = 'local'; this.dataDir = dataDir;
    mkdirSync(join(dataDir, 'files'), { recursive: true });
    this.path = join(dataDir, 'store.json');
    this.db = existsSync(this.path) ? JSON.parse(readFileSync(this.path, 'utf8')) : {};
    for (const name of collections) this.db[name] ||= [];
    this.parts = new Map();
  }
  save() { writeFileSync(this.path + '.tmp', JSON.stringify(this.db, null, 2)); renameSync(this.path + '.tmp', this.path); }
  async list(name) { return copy(this.db[name]); }
  async get(name, key) { return copy(this.db[name].find(value => value.id === key) || null); }
  async insert(name, value) {
    check(!this.db[name].some(item => item.id === value.id), 'Record already exists.', 409);
    this.db[name].unshift(copy(value)); this.save(); return copy(value);
  }
  async mutate(name, key, change) {
    const index = this.db[name].findIndex(value => value.id === key);
    if (index < 0) return null;
    const value = copy(this.db[name][index]);
    if (change(value) !== false) { this.db[name][index] = value; this.save(); }
    return copy(this.db[name][index]);
  }
  async remove(name, key) { const index = this.db[name].findIndex(value => value.id === key); if (index < 0) return false; this.db[name].splice(index, 1); this.save(); return true; }
  async consumeLogin(key, expiresAt) {
    let entry = this.db.loginWindows.find(value => value.id === key);
    if (!entry) { entry = { id: key, count: 0, expiresAt }; this.db.loginWindows.push(entry); }
    entry.count++; this.save(); return entry.count;
  }
  async releaseLogin(key) { await this.mutate('loginWindows', key, value => { value.count = Math.max(0, value.count - 1); }); }
  async putFile(bytes, extension, filename = `${id()}.${extension}`) {
    check(filePattern.test(filename), 'Invalid file name.'); writeFileSync(join(this.dataDir, 'files', filename), bytes); return filename;
  }
  async fileInfo(file) { if (!filePattern.test(file) || !existsSync(join(this.dataDir, 'files', file))) return null; return { size: readFileSync(join(this.dataDir, 'files', file)).length }; }
  async readFile(file) { check(await this.fileInfo(file), 'File not found.', 404); return readFileSync(join(this.dataDir, 'files', file)); }
  async fileStream(file) { check(await this.fileInfo(file), 'File not found.', 404); return createReadStream(join(this.dataDir, 'files', file)); }
  async knownFile(file) { return this.db.assets.some(a => a.file === file) || this.db.jobs.some(j => [...j.references, ...j.candidates].some(value => value.file === file)); }
  async putPart(uploadId, index, bytes, expiresAt) {
    const key = uploadId + '/' + index, hash = digest(bytes), previous = this.parts.get(key);
    check(!previous || previous.hash === hash, 'A different upload part already exists.', 409);
    this.parts.set(key, { index, hash, bytes: Buffer.from(bytes), expiresAt });
  }
  async readParts(uploadId) { return [...this.parts].filter(([key]) => key.startsWith(uploadId + '/')).map(([, value]) => value).sort((a, b) => a.index - b.index); }
  async clearParts(uploadId) { for (const key of this.parts.keys()) if (key.startsWith(uploadId + '/')) this.parts.delete(key); }
  async close() {}
}

export class MongoStorage {
  constructor(client, db, namespace = 'creatives-n8n') {
    this.kind = 'mongodb'; this.client = client; this.database = db; this.namespace = namespace;
    this.bucket = new GridFSBucket(db, { bucketName: namespace });
  }
  collection(name) { check(collections.includes(name), 'Invalid collection.'); return this.database.collection(this.namespace); }
  scope(name, key) { return { app: APP_MARKER, kind: name, ...(key === undefined ? {} : { _id: `${APP_MARKER}:${name}:${key}` }) }; }
  document(name, value, revision = 0) {
    return { ...this.scope(name, value.id), revision, data: copy(value), ...(value.expiresAt ? { expiresAt: new Date(value.expiresAt) } : {}) };
  }
  async initialize() {
    const collection = this.collection('jobs');
    await collection.createIndex({ app: 1, kind: 1, 'data.createdAt': -1 });
    await collection.createIndex({ expiresAt: 1 }, { name: 'formial_dashboard_expiry', expireAfterSeconds: 0, partialFilterExpression: { app: APP_MARKER } });
    await collection.createIndex({ app: 1, kind: 1, 'data.uploadId': 1, 'data.index': 1 });
    await this.database.collection(this.namespace + '.files').createIndex({ filename: 1 }, { unique: true });
  }
  async list(name) { return (await this.collection(name).find(this.scope(name)).sort({ 'data.createdAt': -1, _id: -1 }).toArray()).map(document => document.data); }
  async get(name, key) { return (await this.collection(name).findOne(this.scope(name, key)))?.data || null; }
  async insert(name, value) { await this.collection(name).insertOne(this.document(name, value)); return copy(value); }
  async mutate(name, key, change) {
    // Compare-and-swap prevents one callback or serverless instance overwriting another.
    for (let attempt = 0; attempt < 25; attempt++) {
      const current = await this.collection(name).findOne(this.scope(name, key));
      if (!current) return null;
      const value = current.data;
      if (change(value) === false) return value;
      const result = await this.collection(name).replaceOne({ ...this.scope(name, key), revision: current.revision }, this.document(name, value, current.revision + 1));
      if (result.modifiedCount === 1) return value;
      await new Promise(resolve => setTimeout(resolve, Math.min(2 ** attempt, 25) + Math.floor(Math.random() * 5)));
    }
    check(false, 'Record is busy. Refresh before trying again.', 409);
  }
  async remove(name, key) { return (await this.collection(name).deleteOne(this.scope(name, key))).deletedCount === 1; }
  async consumeLogin(key, expiresAt) {
    const value = await this.collection('loginWindows').findOneAndUpdate(this.scope('loginWindows', key), { $inc: { 'data.count': 1 }, $setOnInsert: { 'data.id': key, 'data.expiresAt': expiresAt, expiresAt, revision: 0 } }, { upsert: true, returnDocument: 'after' });
    return value.data.count;
  }
  async releaseLogin(key) { await this.collection('loginWindows').updateOne({ ...this.scope('loginWindows', key), 'data.count': { $gt: 0 } }, { $inc: { 'data.count': -1 } }); }
  async putFile(bytes, extension, filename = `${id()}.${extension}`) {
    check(filePattern.test(filename), 'Invalid file name.');
    const existing = await this.fileInfo(filename);
    if (existing) { check(existing.metadata?.sha256 === digest(bytes), 'File already exists with different bytes.', 409); return filename; }
    const stream = this.bucket.openUploadStream(filename, { metadata: { sha256: digest(bytes), extension } });
    try { await pipeline(Readable.from([bytes]), stream); }
    catch (error) { await stream.abort().catch(() => {}); throw error; }
    return filename;
  }
  async fileInfo(file) { if (!filePattern.test(file)) return null; const value = await this.bucket.find({ filename: file }).next(); return value && { ...value, size: value.length }; }
  async fileStream(file) { const info = await this.fileInfo(file); check(info, 'File not found.', 404); return this.bucket.openDownloadStream(info._id); }
  async readFile(file) { const stream = await this.fileStream(file), chunks = []; for await (const chunk of stream) chunks.push(chunk); return Buffer.concat(chunks); }
  async knownFile(file) {
    return Boolean(await this.collection('assets').findOne({ ...this.scope('assets'), 'data.file': file }, { projection: { _id: 1 } }) || await this.collection('jobs').findOne({ ...this.scope('jobs'), $or: [{ 'data.references.file': file }, { 'data.candidates.file': file }] }, { projection: { _id: 1 } }));
  }
  async putPart(uploadId, index, bytes, expiresAt) {
    const parts = this.database.collection(this.namespace), key = this.scope('uploadPart', uploadId + '/' + index);
    try { await parts.insertOne({ ...key, data: { uploadId, index, hash: digest(bytes), bytes }, expiresAt }); }
    catch (error) {
      if (error.code !== 11000) throw error;
      check((await parts.findOne(key)).data.hash === digest(bytes), 'A different upload part already exists.', 409);
    }
  }
  async readParts(uploadId) {
    return (await this.database.collection(this.namespace).find({ ...this.scope('uploadPart'), 'data.uploadId': uploadId }).sort({ 'data.index': 1 }).toArray()).map(value => ({ ...value.data, bytes: Buffer.from(value.data.bytes.buffer) }));
  }
  async clearParts(uploadId) { await this.database.collection(this.namespace).deleteMany({ ...this.scope('uploadPart'), 'data.uploadId': uploadId }); }
  async close() { await this.client.close(); }
}

export async function connectMongo(uri, databaseName = 'formial', namespace = 'creatives-n8n') {
  check(typeof uri === 'string' && /^mongodb(?:\+srv)?:\/\//.test(uri), 'Set a valid MONGODB_URI privately in .env.');
  check(/^[A-Za-z0-9_-]{1,63}$/.test(databaseName), 'Invalid MONGODB_DATABASE.');
  check(/^[A-Za-z0-9_-]{1,63}$/.test(namespace), 'Invalid MONGODB_COLLECTION.');
  const servers = mongoDnsServers(process.env.MONGODB_DNS_SERVERS);
  // This override is scoped to the Node.js process; Windows DNS stays unchanged.
  if (servers.length) dns.setServers(servers);
  const client = new MongoClient(uri, { maxPoolSize: 5, minPoolSize: 0, maxIdleTimeMS: 60000, serverSelectionTimeoutMS: 10000, waitQueueTimeoutMS: 10000, retryWrites: true });
  try { await client.connect(); const store = new MongoStorage(client, client.db(databaseName), namespace); await store.initialize(); return store; }
  catch (error) { await client.close(); throw new Error('MongoDB connection failed. Check the private URI, database user permissions and Atlas network access.'); }
}
