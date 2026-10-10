import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import vm from 'node:vm';
import { createApp } from '../dashboard-server.mjs';
import { png } from './fixtures.mjs';
import { defaults, choices } from '../lib.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)),'..');
// Minimal document adapter executes the shipped client and its real API calls.
// This is not a browser renderer and does not claim to verify visual layout.
test('Shipped client loads all screens, submits a job, compares/selects candidates, persists a decision and renders revision/history with escaped text', async t => {
  const {server} = createApp({dataDir:mkdtempSync(join(tmpdir(),'formial-client-')),demoDelay:5,password:''});
  server.listen(0,'127.0.0.1'); await once(server,'listening'); t.after(async () => {server.closeAllConnections(); await new Promise(r => server.close(r));});
  const base = `http://127.0.0.1:${server.address().port}`; let cookie = ''; const requests = [];
  const elements = new Map();
  function element(key) {
    if (!elements.has(key)) elements.set(key,{innerHTML:'',textContent:'',hidden:false,disabled:false,isConnected:true,open:false,listeners:{},classList:{add(){},remove(){}},addEventListener(name,fn){this.listeners[name]=fn;},showModal(){this.open=true;},close(){this.open=false;},focus(){},setSelectionRange(){}});
    return elements.get(key);
  }
  const context = vm.createContext({console, FormData, Blob, File, URL, fixtureFile:new File([png()],'real-reference.png',{type:'image/png'}), setTimeout:()=>1,clearTimeout(){},document:{querySelector:element,querySelectorAll:()=>[],addEventListener(){}},fetch:async (path,options={}) => {
    requests.push({path,method:options.method,bytes:options.body?.size});
    const response = await fetch(base + path,{...options,headers:{cookie,...options.headers}}); const setCookie = response.headers.get('set-cookie'); if (setCookie) cookie = setCookie.split(';')[0]; return response;
  }});
  const run = code => vm.runInContext(code,context);
  await run(readFileSync(join(root,'public/dashboard.js'),'utf8'));
  assert(elements.get('#app').innerHTML.includes('<h1>Creative studio</h1>'));
  assert(elements.get('#app').innerHTML.includes('Copy & advanced settings'));
  assert(!elements.get('#app').innerHTML.includes('direction-card'));
  assert(!elements.get('#app').innerHTML.includes('Recent creatives'));
  assert(elements.get('#app').innerHTML.includes('Generate demo layouts'));
  await run("(async () => { const f = new FormData(); f.append('role','logo'); f.append('file',fixtureFile); const a = await api('assets',{method:'POST',body:f}); state.assets.unshift(a); studio(); })()");
  assert(elements.get('#app').innerHTML.includes('class="brand-logo"'));
  assert(elements.get('#preview').innerHTML.includes('class="brand-logo"'));
  for (const [page,expected] of [['assets','Your brand, saved.'],['presets','Briefs worth keeping.'],['history','Your creative history.']]) { run(`${page}()`); assert(elements.get('#app').innerHTML.includes(expected)); }
  run("studio(); draft.name = '<img src=x onerror=alert(1)>'; state.uploads.reference_image = [fixtureFile];");
  await run('submit({preventDefault(){}})'); const id = run('state.activeJob'); assert(id);
  for (let i=0;i<80;i++) { await run('pollJob()'); if (run("state.jobs.find(j => j.id === state.activeJob).status") === 'complete') break; await new Promise(r=>setTimeout(r,10)); }
  const html = elements.get('#app').innerHTML; assert(html.includes('Your candidates are ready to compare.')); assert(html.includes('candidate selected')); assert(html.includes('Download demo SVG')); assert(html.includes('&lt;img src=x onerror=alert(1)&gt;')); assert(!html.includes('<img src=x onerror'));
  await run("action('select:2')"); assert.equal(run('state.jobs[0].selectedId'),2); await run("action('approve')"); assert.equal(run('state.jobs[0].approval'),'approved');
  run('revision()'); assert(elements.get('#dialog-content').innerHTML.includes('keeps these candidates intact')); assert(elements.get('#dialog-content').innerHTML.includes('This revision will be a demo.'));
  await run("action('close'); action('reuse')"); await run("action('save-preset')"); await run("action('page:presets')"); assert(elements.get('#app').innerHTML.includes('Use this brief'));
  await run("action('page:history')"); assert(elements.get('#app').innerHTML.includes('approved')); assert(elements.get('#app').innerHTML.includes('history-card'));
  context.largeFixture = new File([png(),Buffer.alloc(1048576+17)],'large-reference.png',{type:'image/png'});
  run("config.uploadProtocol = 'chunked'; studio(); state.saved = {}; state.uploads.reference_image = [largeFixture]; draft.name = 'Chunked reference test';");
  await run('submit({preventDefault(){}})'); assert.equal(run('state.jobs[0].brief.name'),'Chunked reference test');
  const parts = requests.filter(request => request.method === 'PUT' && request.path.includes('/parts/'));
  assert.equal(parts.length,2); assert(parts.every(request => request.bytes <= 1048576));
  assert(requests.some(request => request.path.endsWith('/finalize')));
  let failedRequests = 0;
  context.fetch = async () => { failedRequests++; throw new TypeError('Failed to fetch'); };
  await assert.rejects(run("api('jobs',{method:'POST'})"), /Connection to the workspace was interrupted.*check Creative history/);
  assert.equal(failedRequests, 1, 'A failed generation submission must not be retried automatically.');
  context.fetch = async () => ({ json: async () => { throw new SyntaxError('Unexpected token <'); } });
  await assert.rejects(run("api('jobs')"), /workspace connection is temporarily unavailable/);
});

test('Login supports password visibility, clear errors, duplicate-submit protection and successful sign-in', async () => {
  const elements = new Map();
  function element(key) {
    if (!elements.has(key)) elements.set(key, { innerHTML: '', textContent: '', value: '', disabled: false, listeners: {}, attributes: {}, classList: { add() {}, remove() {} }, addEventListener(name, fn) { this.listeners[name] = fn; }, setAttribute(name, value) { this.attributes[name] = value; }, removeAttribute(name) { delete this.attributes[name]; }, focus() { this.focused = true; }, setSelectionRange() {} });
    return elements.get(key);
  }
  let authorized = false, submissions = 0, release;
  const context = vm.createContext({ console, FormData, Blob, File, URL, setTimeout: () => 1, clearTimeout() {}, document: { querySelector: element, querySelectorAll: () => [], addEventListener() {} }, fetch: async (path, options = {}) => {
    if (path === '/api/config') return { ok: true, json: async () => ({ loginRequired: true, mode: 'demo', defaults, choices }) };
    if (path === '/api/session') {
      submissions++;
      await new Promise(resolve => { release = resolve; });
      authorized = JSON.parse(options.body).password === 'test-password';
      return { ok: authorized, status: authorized ? 200 : 401, json: async () => authorized ? { ok: true } : { error: 'Incorrect workspace password.' } };
    }
    return { ok: authorized, status: authorized ? 200 : 401, json: async () => authorized ? [] : { error: 'Sign in to your workspace.' } };
  } });
  const run = code => vm.runInContext(code, context);
  await run(readFileSync(join(root, 'public/dashboard.js'), 'utf8'));
  assert(elements.get('#app').innerHTML.includes('login-workspace'));
  assert(!elements.get('#app').innerHTML.includes('Formial#123'));
  const field = element('#password'), form = element('#login-form'), submit = element('#login-submit'), error = element('#login-error');
  element('#show-password').listeners.change({ target: { checked: true } }); assert.equal(field.type, 'text');
  element('#show-password').listeners.change({ target: { checked: false } }); assert.equal(field.type, 'password');
  field.value = 'wrong';
  const failed = form.listeners.submit({ preventDefault() {} });
  assert.equal(submit.disabled, true); assert.equal(form.attributes['aria-busy'], 'true');
  await form.listeners.submit({ preventDefault() {} }); assert.equal(submissions, 1);
  release(); await failed;
  assert.equal(error.textContent, 'Incorrect workspace password.'); assert.equal(field.attributes['aria-invalid'], 'true'); assert.equal(submit.disabled, false);
  field.listeners.input(); assert.equal(error.textContent, ''); assert.equal(field.attributes['aria-invalid'], undefined);
  field.value = 'test-password'; const success = form.listeners.submit({ preventDefault() {} }); release(); await success;
  assert.equal(run('state.page'), 'studio'); assert(elements.get('#app').innerHTML.includes('<h1>Creative studio</h1>'));
});
