import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectMongo, digest } from '../storage.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const directory = resolve(process.env.DATA_DIR || join(root, 'data'));
let store;
try {
  const source = JSON.parse(readFileSync(join(directory, 'store.json'), 'utf8'));
  if (source.jobs.some(job => !['complete', 'failed'].includes(job.status))) throw new Error('Wait for active jobs to finish before migrating.');
  store = await connectMongo(process.env.MONGODB_URI, process.env.MONGODB_DATABASE || 'formial', process.env.MONGODB_COLLECTION || 'creatives-n8n');
  const references = new Map();
  for (const asset of source.assets) references.set(asset.file, asset);
  for (const job of source.jobs) for (const image of [...job.references, ...job.candidates]) references.set(image.file, image);
  for (const [filename] of references) {
    if (!/^[a-f0-9-]{36}\.(png|jpg|webp|svg)$/.test(filename)) throw new Error('Invalid source file name.');
    const bytes = readFileSync(join(directory, 'files', filename)), current = await store.fileInfo(filename);
    if (current && current.metadata?.sha256 !== digest(bytes)) throw new Error('A destination image differs from the local source.');
    await store.putFile(bytes, filename.split('.').at(-1), filename);
  }
  for (const name of ['assets', 'presets', 'jobs']) {
    for (const record of source[name]) {
      const current = await store.get(name, record.id);
      if (current && JSON.stringify(current) !== JSON.stringify(record)) throw new Error('A destination record differs. Existing MongoDB data was not overwritten.');
      if (!current) await store.insert(name, record);
    }
  }
  console.log(`Migration verified: ${source.jobs.length} jobs, ${source.assets.length} assets, ${source.presets.length} briefs and ${references.size} images. Local files were preserved.`);
} catch (error) { console.error(error.message?.startsWith('MongoDB') ? 'MongoDB connection failed. Check private settings.' : error.code ? 'Migration failed. Check source files and database permissions; credentials are not printed.' : error.message); process.exitCode = 1; }
finally { await store?.close(); }
