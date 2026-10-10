import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import http from 'node:http';
import { once } from 'node:events';
import { createApp } from '../dashboard-server.mjs';
import { LocalStorage } from '../storage.mjs';
import { defaults, crc32 } from '../lib.mjs';
import { png, review } from './fixtures.mjs';

async function harness(options = {}) {
  const app = createApp({ dataDir: mkdtempSync(join(tmpdir(),'formial-test-')), demoDelay: 5, ...options });
  app.server.listen(0,'127.0.0.1'); await once(app.server,'listening');
  const base = `http://127.0.0.1:${app.server.address().port}`; let cookie = '';
  async function request(path, body, method = 'GET', headers = {}) {
    const res = await fetch(base + path,{method,headers:{cookie,...(body && !(body instanceof FormData) ? {'content-type':'application/json'} : {}),...headers},body:body ? body instanceof FormData ? body : JSON.stringify(body) : undefined});
    return res;
  }
  async function login(password = 'Formial#123') { const res = await request('/api/session',{password},'POST'); cookie = res.headers.get('set-cookie')?.split(';')[0] || ''; return res; }
  async function close() { app.server.closeAllConnections(); await new Promise(r => app.server.close(r)); }
  return { ...app, base, request, login, close };
}
function submission(brief = defaults, files = [['reference_image',png()]], saved = []) {
  const f = new FormData(); f.append('brief',JSON.stringify(brief)); f.append('savedAssets',JSON.stringify(saved));
  for (const [field,bytes] of files) f.append(field,new Blob([bytes],{type:'image/png'}),field + '.png'); return f;
}
async function waitFor(h,id) {
  for (let i = 0; i < 80; i++) { const j = await (await h.request('/api/jobs/' + id)).json(); if (['complete','failed'].includes(j.status)) return j; await new Promise(r => setTimeout(r,10)); } throw new Error('Job did not finish');
}
function unzipStored(bytes) {
  const files = new Map(); let at = 0;
  while (bytes.readUInt32LE(at) === 0x04034b50) {
    const crc = bytes.readUInt32LE(at+14), length = bytes.readUInt32LE(at+18), nameLen = bytes.readUInt16LE(at+26), extraLen = bytes.readUInt16LE(at+28);
    const name = bytes.toString('utf8',at+30,at+30+nameLen), start = at+30+nameLen+extraLen, data = bytes.subarray(start,start+length);
    assert.equal(crc32(data),crc); files.set(name,data); at = start+length;
  }
  assert.equal(bytes.readUInt32LE(at),0x02014b50); return files;
}

test('Local primary flow: upload, saved assets, brief, progress, comparison, selection, decisions, ZIP, revisions and restart persistence', async t => {
  const h = await harness(); t.after(h.close);
  assert.equal((await h.request('/api/jobs')).status,401); await h.login();
  const assetForm = new FormData(); assetForm.append('role','logo'); assetForm.append('file',new Blob([png()]),'approved-logo.png');
  const asset = await (await h.request('/api/assets',assetForm,'POST')).json();
  assert.equal(asset.mimeType,'image/png');
  assert.equal((await h.request('/api/presets',{...defaults,name:'Launch brief'},'POST')).status,201);
  const res = await h.request('/api/jobs',submission({...defaults,name:'Personal care test'},undefined,[{id:asset.id,field:'logo'}]),'POST');
  assert.equal(res.status,202); const created = await res.json(); assert.equal(created.status,'queued'); assert(!('callbackToken' in created));
  const completed = await waitFor(h,created.id); assert.equal(completed.status,'complete'); assert.equal(completed.candidates.length,2); assert.equal(completed.qaStatus,'demo'); assert(completed.candidates.every(c => c.score === null));
  assert.deepEqual(completed.events.map(e => e.stage),['directing','generating','reviewing','packaging','complete']);
  assert.equal((await h.request('/api/jobs/' + created.id + '/decision',{approval:'approved'},'POST')).status,200);
  const selection = await (await h.request('/api/jobs/' + created.id + '/selection',{selectedId:2},'POST')).json(); assert.equal(selection.approval,'pending');
  const archive = await h.request('/api/jobs/' + created.id + '/archive'); assert.equal(archive.headers.get('content-type'),'application/zip');
  const files = unzipStored(Buffer.from(await archive.arrayBuffer())); assert(files.has('selected.svg') && files.has('candidate-2.svg') && files.has('creative-report.json')); assert(files.get('selected.svg').equals(files.get('candidate-2.svg')));
  const report = JSON.parse(files.get('creative-report.json')); assert.equal(report.dashboard_selection,2); assert.equal(report.mode,'demo');
  const revision = await (await h.request('/api/jobs/' + created.id + '/revision',{changes:'Use a more open composition.'},'POST')).json(); assert.equal(revision.parentId,created.id); assert.notEqual(revision.id,created.id); await waitFor(h,revision.id);
  assert.equal((await h.request('/api/assets/' + asset.id,null,'DELETE')).status,200);
  assert.equal((await h.request('/api/files/' + asset.file)).status,200); // Earlier jobs keep references.
  const disk = JSON.parse(readFileSync(join(h.dataDir,'store.json'))); assert.equal(disk.jobs.length,2); assert.equal(disk.presets.length,1); assert.equal(disk.assets.length,0);
  const restored = await harness({dataDir:h.dataDir}); t.after(restored.close); await restored.login(); const history = await (await restored.request('/api/jobs')).json(); assert.equal(history.length,2); assert.equal(history.find(j => j.id === created.id).selectedId,2);
});

test('Reject invalid roles, file signatures, excessive counts/sizes, missing references, unsafe origins, path traversal and unauthenticated files', async t => {
  const h = await harness(); t.after(h.close); await h.login();
  assert.equal((await h.request('/api/jobs',submission(defaults,[]),'POST')).status,400);
  assert.equal((await h.request('/api/jobs',submission(defaults,[['reference_image',Buffer.from('<svg/>')]]),'POST')).status,400);
  assert.equal((await h.request('/api/jobs',submission(defaults,[['reference_image',png()],['reference_image',png()]]),'POST')).status,400);
  assert.equal((await h.request('/api/jobs',submission({...defaults,theme:'Made up'}),'POST')).status,400);
  assert.equal((await h.request('/api/jobs',submission(defaults,[['unexpected',png()]]),'POST')).status,400);
  assert.equal((await h.request('/api/jobs',submission(defaults,[['reference_image',Buffer.alloc(5*1024*1024+1)]]),'POST')).status,400);
  assert.equal((await h.request('/api/presets',{...defaults,campaign:'x'.repeat(40000)},'POST')).status,413);
  assert.equal((await h.request('/api/presets',[],'POST')).status,400);
  assert.equal((await h.request('/api/presets',defaults,'POST',{origin:'https://malicious.example'})).status,403);
  assert.equal((await h.request('/api/files/../../.env')).status,404);
  assert.equal((await h.request('/api/jobs/' + 'a'.repeat(36))).status,404);
  assert.equal(h.db.jobs.length,0);
});

test('Workspace password, rate-limited sign-in, Unicode credentials, cookie attributes and logout', async t => {
  const h = await harness({password:'workspace-安全-password'}); t.after(h.close);
  assert.equal((await h.login('wrong')).status,401); const res = await h.login('workspace-安全-password'); assert.equal(res.status,200); assert(res.headers.get('set-cookie').includes('HttpOnly')); assert(res.headers.get('set-cookie').includes('SameSite=Strict'));
  assert.equal((await h.request('/api/jobs')).status,200); await h.request('/api/logout',{},'POST'); assert.equal((await h.request('/api/jobs')).status,401);
  for (let i = 0; i < 9; i++) assert.equal((await h.login('wrong')).status,401); assert.equal((await h.login('wrong')).status,429);
});

test('Fixed server-side password ignores the old environment variable and stays out of public responses', async t => {
  const previous = process.env.DASHBOARD_PASSWORD;
  process.env.DASHBOARD_PASSWORD = 'ignored-environment-password';
  t.after(() => { if (previous === undefined) delete process.env.DASHBOARD_PASSWORD; else process.env.DASHBOARD_PASSWORD = previous; });
  const h = await harness(); t.after(h.close);
  assert.equal((await h.login('')).status, 401);
  assert.equal((await h.login('ignored-environment-password')).status, 401);
  assert.equal((await h.login('Formial#123')).status, 200);
  assert.equal((await h.request('/api/jobs')).status, 200);
  for (const route of ['/api/config', '/dashboard.js', '/']) {
    const text = await (await h.request(route)).text();
    assert(!text.includes('Formial#123'));
    assert(!text.includes('ignored-environment-password'));
  }
  assert.equal((await h.request('/api/logout', {}, 'POST')).status, 200);
  assert.equal((await h.request('/api/jobs')).status, 401);
});

test('Vercel uses the fixed password without an environment variable but refuses disabled authentication', async () => {
  const options = { storage: new LocalStorage(mkdtempSync(join(tmpdir(), 'formial-vercel-login-'))), backend: 'mongodb', mode: 'n8n', payloadVersion: 2, serverless: true, n8nUrl: 'https://example.invalid/webhook', n8nSecret: 'test-only-secret', publicUrl: 'https://example.invalid' };
  const app = createApp(options); await app.ready; await app.closeStorage();
  assert.throws(() => createApp({ ...options, password: '' }), /authentication is required/);
});

test('Live integration contract: authenticated asynchronous dispatch, callbacks, dimension checks, failure, replay and secret isolation', async t => {
  let envelope;
  const receiver = http.createServer(async (req,res) => { assert.equal(req.headers['x-formial-secret'],'server-secret'); let raw = ''; for await (const b of req) raw += b; envelope = JSON.parse(raw); res.writeHead(202,{'content-type':'application/json'}); res.end('{}'); });
  receiver.listen(0,'127.0.0.1'); await once(receiver,'listening'); t.after(() => new Promise(r => receiver.close(r)));
  const h = await harness({mode:'n8n',n8nUrl:`http://127.0.0.1:${receiver.address().port}`,n8nSecret:'server-secret',publicUrl:'http://127.0.0.1:3000'}); t.after(h.close); await h.login();
  const created = await (await h.request('/api/jobs',submission(),'POST')).json();
  for (let i=0; i<100 && !envelope; i++) await new Promise(r => setTimeout(r,5));
  assert.equal(envelope.jobId,created.id); assert.equal(envelope.files[0].field,'reference_image'); assert(envelope.files[0].data); assert.equal(envelope.callbackToken.length,64);
  const route = '/api/n8n/callback/' + created.id;
  const progress = {version:1,jobId:created.id,event:'progress',stage:'generating'};
  assert.equal((await h.request(route,progress,'POST')).status,401);
  const headers = {authorization:'Bearer ' + envelope.callbackToken}; assert.equal((await h.request(route,progress,'POST',headers)).status,200);
  assert.equal((await h.request(route,{...progress,stage:'directing'},'POST',headers)).status,200); assert.equal(h.db.jobs[0].status,'generating');
  const report = {model_assessment_only:true,selected_candidate:1,status:'qa_pass',requested_size:'3712x4608',image_resolution:'4K',repair_attempted:false};
  const candidate = {id:1,mimeType:'image/png',data:png().toString('base64'),review:review(),dimensionsMatch:true};
  const payload = {version:1,jobId:created.id,event:'complete',status:'qa_pass',selectedId:1,report,candidates:[candidate]};
  assert.equal((await h.request(route,payload,'POST',headers)).status,400); // Cannot spoof dimensionsMatch.
  payload.candidates[0].data = png(3712,4608).toString('base64'); assert.equal((await h.request(route,payload,'POST',headers)).status,200);
  assert.equal(h.db.jobs[0].status,'complete'); assert.equal(h.db.jobs[0].candidates[0].width,3712);
  const replay = await (await h.request(route,{version:1,jobId:created.id,event:'failed'},'POST',headers)).json(); assert.equal(replay.ignored,true); assert.equal(h.db.jobs[0].status,'complete');
  for (const endpoint of ['/api/config','/api/jobs','/api/jobs/' + created.id,'/api/jobs/' + created.id + '/report']) { const text = await (await h.request(endpoint)).text(); assert(!text.includes(envelope.callbackToken)); assert(!text.includes('server-secret')); }
  const failureJob = await (await h.request('/api/jobs',submission(),'POST')).json(); for (let i=0;i<100 && envelope.jobId !== failureJob.id;i++) await new Promise(r => setTimeout(r,5));
  assert.equal((await h.request('/api/n8n/callback/' + failureJob.id,{version:1,jobId:failureJob.id,event:'failed'},'POST',{authorization:'Bearer ' + envelope.callbackToken})).status,200); assert.equal(h.db.jobs[0].status,'failed');
});
