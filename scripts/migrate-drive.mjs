import { connectMongo, digest } from '../storage.mjs';
import { configureDriveImages } from '../drive-images.mjs';

let store;
try {
  store = await connectMongo(process.env.MONGODB_URI, process.env.MONGODB_DATABASE || 'formial', process.env.MONGODB_COLLECTION || 'creatives-n8n', { imageBackend: 'gridfs' });
  const jobs = await store.list('jobs'), assets = await store.list('assets');
  if (jobs.some(job => !['complete', 'failed'].includes(job.status))) throw new Error('Wait for active jobs to finish before migrating images.');
  const files = new Set(assets.map(asset => asset.file));
  for (const job of jobs) for (const image of [...job.references, ...job.candidates]) files.add(image.file);
  if (!process.argv.includes('--apply')) console.log(`Dry run: ${files.size} referenced images would be copied to Drive. No images were uploaded or deleted. Add --apply only when ready.`);
  else {
    configureDriveImages(store); const images = store.images; store.images = null;
    await images.client.checkFolder(); let copied = 0;
    for (const file of files) {
      const mapping = await store.get('driveFiles', file);
      if (mapping?.state === 'ready') { await images.readFile(file); continue; }
      const bytes = await store.readFile(file);
      await images.putFile(bytes, file.split('.').at(-1), file);
      if (digest(await images.readFile(file)) !== digest(bytes)) throw new Error('Drive image verification failed.');
      copied++;
    }
    console.log(`Drive migration verified for ${files.size} images; ${copied} newly copied. GridFS originals and existing job records were preserved. Storage was not automatically switched.`);
  }
} catch (error) { console.error('Image migration stopped. Existing images were preserved. ' + (error.code || error.name)); process.exitCode = 1; }
finally { await store?.close(); }
