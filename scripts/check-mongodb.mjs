import { connectMongo } from '../storage.mjs';

let store;
try {
  store = await connectMongo(process.env.MONGODB_URI, process.env.MONGODB_DATABASE || 'formial', process.env.MONGODB_COLLECTION || 'creatives-n8n');
  await store.database.command({ ping: 1 });
  console.log('MongoDB connected. Formial collections, GridFS and indexes are ready. No credentials are printed.');
} catch { console.error('MongoDB is not connected. Set MONGODB_URI privately in .env and check Atlas database-user and network permissions.'); process.exitCode = 1; }
finally { await store?.close(); }
