import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { parseEnv, updateRuntimeEnv } from './env-file.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const envPath = join(root, '.env');
const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  if (!process.argv[i].startsWith('--') || !process.argv[i + 1]) throw new Error('Use --webhook, --location and optionally --public-url.');
  args.set(process.argv[i].slice(2), process.argv[i + 1]);
}

function validateWebhook(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('The n8n webhook URL is not a valid URL.'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('The n8n webhook URL must use HTTP or HTTPS.');
  if (url.pathname.includes('/webhook-test/')) throw new Error('Use the Production URL containing /webhook/, not the Test URL containing /webhook-test/.');
  if (!url.pathname.includes('/webhook/')) throw new Error('Copy the Production URL from the Dashboard Webhook node. It must contain /webhook/.');
  return url.toString().replace(/\/$/, '');
}

function validatePublicUrl(value, remote) {
  let url;
  try { url = new URL(value); } catch { throw new Error('The dashboard public URL is not a valid URL.'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('The dashboard URL must use HTTP or HTTPS.');
  if (remote && url.protocol !== 'https:') throw new Error('A remote n8n server needs an HTTPS dashboard URL.');
  if (url.pathname !== '/' || url.search || url.hash) throw new Error('The dashboard URL must be an origin only, such as https://creative.example.com.');
  return url.toString().replace(/\/$/, '');
}

const source = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '# Private Formial dashboard configuration.\n';
const existing = parseEnv(source);
const rl = createInterface({ input: stdin, output: stdout });
try {
  const webhook = validateWebhook(args.get('webhook') || await rl.question('Paste the n8n Production Webhook URL: '));
  let location = (args.get('location') || '').toLowerCase();
  if (!location) {
    stdout.write('\nWhere does n8n run?\n  1. Same Windows computer\n  2. Docker on this computer\n  3. Another computer/server\n');
    location = ({ '1': 'local', '2': 'docker', '3': 'remote' })[await rl.question('Choose 1, 2 or 3: ')];
  }
  if (!['local', 'docker', 'remote'].includes(location)) throw new Error('Location must be local, docker or remote.');

  const remote = location === 'remote';
  const host = location === 'local' ? '127.0.0.1' : '0.0.0.0';
  let publicUrl = location === 'docker' ? 'http://host.docker.internal:3001' : 'http://127.0.0.1:3001';
  if (remote) publicUrl = args.get('public-url') || await rl.question('Paste the public HTTPS URL that n8n can use to reach this dashboard: ');
  publicUrl = validatePublicUrl(publicUrl, remote);

  const webhookSecret = existing.N8N_WEBHOOK_SECRET && !existing.N8N_WEBHOOK_SECRET.startsWith('replace-')
    ? existing.N8N_WEBHOOK_SECRET
    : randomBytes(32).toString('hex');
  const updates = { GENERATION_MODE: 'n8n', HOST: host, PORT: existing.PORT || '3001', N8N_WEBHOOK_URL: webhook, DASHBOARD_PUBLIC_URL: publicUrl, JOB_TIMEOUT_MINUTES: existing.JOB_TIMEOUT_MINUTES || '65' };
  if (webhookSecret !== existing.N8N_WEBHOOK_SECRET) updates.N8N_WEBHOOK_SECRET = webhookSecret;
  const content = updateRuntimeEnv(source, updates);
  writeFileSync(envPath, content, { encoding: 'utf8', mode: 0o600 });

  stdout.write('\n.env is configured for live n8n generation.\n\n');
  stdout.write('ONE-TIME N8N SETUP\n');
  stdout.write('1. Dashboard Webhook node -> Header Auth credential\n');
  stdout.write('   Header name:  x-formial-secret\n');
  stdout.write(`   Header value: ${webhookSecret}\n\n`);
  stdout.write('2. Five Gemini HTTP nodes -> one shared Header Auth credential\n');
  stdout.write('   Header name:  x-goog-api-key\n');
  stdout.write('   Header value: your raw Google AI Studio API key\n');
  stdout.write('   Select it in Creative Director, Generate Candidates, Inspect Candidates, Repair Candidate and Inspect Repair.\n\n');
  stdout.write('3. Activate the workflow, then restart the dashboard with npm.cmd start.\n');
  stdout.write('\nDashboard login uses the fixed server-side workspace password.\n');
} finally {
  rl.close();
}
