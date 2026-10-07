import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import net from 'node:net';
import { parseEnv, updateRuntimeEnv } from './env-file.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const envPath = join(root, '.env');
const client = join(root, '.tools', 'cloudflared.exe');
if (!existsSync(client)) throw new Error('Missing .tools/cloudflared.exe. Download it from the official Cloudflare downloads page.');
const source = readFileSync(envPath, 'utf8');
const values = parseEnv(source);
const hadPassword = Boolean(values.DASHBOARD_PASSWORD);
const mode = process.argv.includes('--live') ? 'n8n' : 'demo';
const port = Number(process.argv.find(arg => arg.startsWith('--port='))?.slice(7) || values.PORT || 3001);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Choose a port between 1024 and 65535.');
await new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.once('error', () => reject(new Error(`Port ${port} is occupied. Stop the previous dashboard or use --port=3002.`)));
  probe.listen(port, '127.0.0.1', () => probe.close(resolve));
});
const localUrl = `http://127.0.0.1:${port}`;
if (!values.N8N_WEBHOOK_SECRET || !values.N8N_WEBHOOK_URL) throw new Error('Configure the production webhook and secret first.');
values.HOST = '127.0.0.1';
values.PORT = String(port);
values.GENERATION_MODE = mode;
values.DASHBOARD_PASSWORD ||= randomBytes(24).toString('base64url');
values.DASHBOARD_PUBLIC_URL = localUrl;
const persist = () => {
  const updates = Object.fromEntries(['HOST', 'PORT', 'GENERATION_MODE', 'DASHBOARD_PUBLIC_URL'].map(key => [key, values[key]]));
  if (!hadPassword) updates.DASHBOARD_PASSWORD = values.DASHBOARD_PASSWORD;
  writeFileSync(envPath, updateRuntimeEnv(source, updates), { mode: 0o600 });
};
persist();
mkdirSync(join(root, '.runtime'), { recursive: true });
const logPath = join(root, '.runtime', 'tunnel.log');
writeFileSync(logPath, '');
let dashboard, tunnel, stopping = false, publicUrl;
const record = message => {
  console.log(message);
  writeFileSync(logPath, message + '\n', { flag: 'a' });
};
async function stopDashboard() {
  if (!dashboard || dashboard.exitCode !== null) return;
  const child = dashboard;
  await new Promise(resolve => { child.once('exit', resolve); child.kill(); });
}
async function startDashboard() {
  dashboard = spawn(process.execPath, ['dashboard-server.mjs'], { cwd: root, env: { ...process.env, ...values }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  dashboard.stdout.on('data', data => record(data.toString().trim()));
  dashboard.stderr.on('data', data => record(data.toString().trim()));
  dashboard.on('error', error => record('Dashboard startup error: ' + error.message));
  for (let attempt = 0; attempt < 40; attempt++) {
    if (dashboard.exitCode !== null) throw new Error(`Dashboard exited. Check whether port ${port} is already occupied.`);
    try {
      const response = await fetch(localUrl + '/api/config', { signal: AbortSignal.timeout(1000) });
      const config = await response.json();
      if (response.ok && config.loginRequired && config.mode === mode) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error('Password-protected dashboard did not become ready.');
}
async function shutdown() {
  if (stopping) return;
  stopping = true;
  tunnel?.kill();
  await stopDashboard();
}
process.on('SIGINT', () => shutdown().then(() => process.exit(0)));
process.on('SIGTERM', () => shutdown().then(() => process.exit(0)));
try {
  await startDashboard();
  tunnel = spawn(client, ['tunnel', '--no-autoupdate', '--protocol', 'http2', '--url', localUrl], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const url = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Cloudflare did not provide a URL within 90 seconds.')), 90000);
    let buffer = '';
    const consume = data => {
      const message = data.toString();
      writeFileSync(logPath, message, { flag: 'a' });
      buffer = (buffer + message).slice(-12000);
      const match = buffer.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (match) { clearTimeout(timeout); resolve(match[0]); }
    };
    tunnel.stdout.on('data', consume);
    tunnel.stderr.on('data', consume);
    tunnel.once('error', error => { clearTimeout(timeout); reject(error); });
    tunnel.once('exit', code => { clearTimeout(timeout); reject(new Error('Cloudflare exited: ' + code)); });
  });
  publicUrl = url;
  await stopDashboard();
  values.DASHBOARD_PUBLIC_URL = publicUrl;
  persist();
  await startDashboard();
  record('Dashboard HTTPS URL: ' + publicUrl);
  record('Mode: ' + mode + '. Login password is in .env under DASHBOARD_PASSWORD.');
  record('Keep this process running. The temporary URL changes on each restart.');
  tunnel.on('exit', code => {
    if (!stopping) { record('Tunnel stopped: ' + code); shutdown().then(() => process.exit(1)); }
  });
  dashboard.on('exit', code => {
    if (!stopping) { record('Dashboard stopped: ' + code); shutdown().then(() => process.exit(1)); }
  });
} catch (error) {
  record(error.message);
  await shutdown();
  process.exitCode = 1;
}
