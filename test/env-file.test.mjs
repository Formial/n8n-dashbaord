import test from 'node:test';
import assert from 'node:assert/strict';
import { parseEnv, updateRuntimeEnv } from '../scripts/env-file.mjs';

test('Tunnel environment parsing preserves quoted passwords, secrets and comments', () => {
  const source = '# Private settings\r\nDASHBOARD_PASSWORD="sample # password"\r\nN8N_WEBHOOK_SECRET=example-secret\r\nMONGODB_URI="mongodb+srv://test:private@example.invalid/formial"\r\nMONGODB_DATABASE=formial\r\nMONGODB_COLLECTION=creatives-n8n\r\nPORT=3002\r\nDASHBOARD_PUBLIC_URL=http://127.0.0.1:3002\r\n';
  const updated = updateRuntimeEnv(source, { PORT: '3003', DASHBOARD_PUBLIC_URL: 'https://example.trycloudflare.com', GENERATION_MODE: 'n8n' });
  const env = parseEnv(updated);
  assert.equal(env.DASHBOARD_PASSWORD, 'sample # password');
  assert.equal(env.N8N_WEBHOOK_SECRET, 'example-secret');
  assert.equal(env.MONGODB_URI, 'mongodb+srv://test:private@example.invalid/formial');
  assert.equal(env.MONGODB_COLLECTION, 'creatives-n8n');
  assert.equal(env.PORT, '3003');
  assert.equal(env.DASHBOARD_PUBLIC_URL, 'https://example.trycloudflare.com');
  assert.equal(env.GENERATION_MODE, 'n8n');
  assert(updated.includes('DASHBOARD_PASSWORD="sample # password"'));
  assert(updated.includes('# Private settings'));
  assert.throws(() => updateRuntimeEnv(source, { PORT: '3003\nOTHER=value' }));
});
