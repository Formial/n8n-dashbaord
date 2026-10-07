import http from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { ZipArchive } from 'archiver';
import { LocalStorage, connectMongo, digest } from './storage.mjs';
import { beginUpload, writeUploadPart, finishUpload, CHUNK_BYTES } from './transfers.mjs';
import { check, HttpError, id, imageMime, imageDimensions, canvasSizes, validateBrief, validateReferences, defaults, choices, FILE_LIMIT, demoSvg, zip } from './lib.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const stages = ['queued', 'directing', 'generating', 'reviewing', 'repairing', 'packaging', 'complete'];
const terminal = new Set(['complete', 'failed']);
const qaKeys = ['product_fidelity', 'brand_consistency', 'text_accuracy', 'required_items_present', 'claims_accurate', 'composition_clean', 'no_visible_artifacts'];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const safeEqual = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const publicJob = job => { const { callbackToken, ...value } = job; return value; };

export function createApp(options = {}) {
  const dataDir = resolve(options.dataDir ?? process.env.DATA_DIR ?? join(root, 'data'));
  const mode = options.mode ?? process.env.GENERATION_MODE ?? 'demo';
  const password = options.password ?? process.env.DASHBOARD_PASSWORD ?? '';
  const n8nUrl = options.n8nUrl ?? process.env.N8N_WEBHOOK_URL;
  const n8nSecret = options.n8nSecret ?? process.env.N8N_WEBHOOK_SECRET;
  const publicUrl = options.publicUrl ?? process.env.DASHBOARD_PUBLIC_URL ?? 'http://127.0.0.1:3001';
  const payloadVersion = Number(options.payloadVersion ?? process.env.N8N_PAYLOAD_VERSION ?? 1);
  const serverless = options.serverless ?? Boolean(process.env.VERCEL);
  const backend = options.backend ?? process.env.STORAGE_BACKEND ?? (process.env.MONGODB_URI ? 'mongodb' : 'local');
  const timeout = Number(process.env.JOB_TIMEOUT_MINUTES || 65) * 60000;
  check(['demo', 'n8n'].includes(mode) && [1, 2].includes(payloadVersion), 'Invalid generation configuration.');
  check(['local', 'mongodb'].includes(backend), 'STORAGE_BACKEND must be local or mongodb.');
  if (mode === 'n8n') {
    check(n8nUrl && n8nSecret && !n8nSecret.startsWith('replace-'), 'Set N8N_WEBHOOK_URL and a real N8N_WEBHOOK_SECRET.');
    for (const value of [n8nUrl, publicUrl]) check(['http:', 'https:'].includes(new URL(value).protocol), 'Integration URLs must use HTTP or HTTPS.');
  }
  if (serverless) {
    check(backend === 'mongodb' && mode === 'n8n' && payloadVersion === 2, 'Vercel requires MongoDB, live n8n and the version 2 workflow.');
    check(password.length >= 16 && !/^(formial|password)/i.test(password), 'Set a strong DASHBOARD_PASSWORD of at least 16 characters before deploying.');
    check(new URL(publicUrl).protocol === 'https:', 'Vercel requires an HTTPS DASHBOARD_PUBLIC_URL.');
  }
  let store = options.storage || (backend === 'local' ? new LocalStorage(dataDir) : null), closed = false;
  const ready = (async () => {
    store ||= await connectMongo(options.mongoUri ?? process.env.MONGODB_URI, options.mongoDatabase ?? process.env.MONGODB_DATABASE ?? 'formial', options.mongoCollection ?? process.env.MONGODB_COLLECTION ?? 'creatives-n8n');
    if (store.kind === 'local') {
      for (const job of await store.list('jobs')) {
        if (job.mode === 'demo' && !terminal.has(job.status)) await store.mutate('jobs', job.id, value => { value.status = 'failed'; value.error = 'Demo interrupted by a server restart. Create a new revision to try again.'; });
        await expire(job.id);
      }
    }
    return store;
  })();
  ready.catch(() => {});
  async function expire(jobId) {
    return store.mutate('jobs', jobId, job => {
      if (terminal.has(job.status) || Date.now() - Date.parse(job.createdAt) <= timeout) return false;
      job.status = 'failed'; job.error = 'The generation timed out. Inspect the n8n execution before creating a new revision; Google may already have billed the request.'; job.updatedAt = new Date().toISOString();
    });
  }
  async function update(jobId, stage, fields = {}) {
    return store.mutate('jobs', jobId, job => {
      if (terminal.has(job.status) || closed || stages.indexOf(stage) < stages.indexOf(job.status)) return false;
      Object.assign(job, fields); job.status = stage; job.updatedAt = new Date().toISOString(); job.events.push({ stage, at: job.updatedAt });
    });
  }
  async function fail(jobId, error) {
    return store.mutate('jobs', jobId, job => { if (terminal.has(job.status)) return false; job.status = 'failed'; job.error = error; job.updatedAt = new Date().toISOString(); });
  }
  async function demo(job) {
    for (const stage of ['directing', 'generating', 'reviewing', 'packaging']) { await sleep(options.demoDelay ?? 1200); if (closed) return; await update(job.id, stage); }
    const main = job.references.find(value => value.field === 'reference_image');
    const data = `data:${main.mimeType};base64,${(await store.readFile(main.file)).toString('base64')}`;
    const candidates = [];
    for (const number of [1, 2]) candidates.push({ id: number, file: await store.putFile(Buffer.from(demoSvg(job.brief, data, number)), 'svg'), mimeType: 'image/svg+xml', score: null, pass: false, issues: ['Demo composition using the uploaded reference. No AI generation or visual QA has occurred.'], checks: {}, label: `Layout ${number}` });
    await update(job.id, 'complete', { candidates, selectedId: 1, qaStatus: 'demo', report: { model_assessment_only: true, demo: true, exact_copy: job.brief, reviews: candidates.map(({ file, ...value }) => value), status: 'demo', repair_attempted: false, note: 'Local demo only. No Gemini or Nano Banana generation.' } });
  }
  async function dispatch(job) {
    const files = [];
    for (const ref of job.references) files.push({ field: ref.field, fileName: ref.name, mimeType: ref.mimeType, size: ref.size, ...(payloadVersion === 2 ? { url: `${publicUrl.replace(/\/$/, '')}/api/n8n/reference/${job.id}/${ref.id}` } : { data: (await store.readFile(ref.file)).toString('base64') }) });
    const payload = { version: payloadVersion, jobId: job.id, callbackUrl: `${publicUrl.replace(/\/$/, '')}/api/n8n/callback/${job.id}`, callbackToken: job.callbackToken, fields: job.brief, files };
    try {
      const response = await fetch(n8nUrl, { method: 'POST', headers: { 'content-type': 'application/json', 'x-formial-secret': n8nSecret }, body: JSON.stringify(payload), signal: AbortSignal.timeout(30000), redirect: 'error' });
      if (!response.ok) throw new Error('Webhook rejected submission');
    } catch { await fail(job.id, 'n8n did not acknowledge this job. Inspect n8n executions before retrying; submission may have reached the provider.'); }
  }
  async function newJob(brief, references, parentId = null) {
    const job = { id: id(), brief, references, parentId, mode, status: 'queued', approval: 'pending', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), events: [], candidates: [], selectedId: null, callbackToken: randomBytes(32).toString('hex') };
    await store.insert('jobs', job);
    // Finish dispatch before ending a serverless invocation; never automatically resubmit a job.
    if (mode === 'n8n') await dispatch(job);
    else setImmediate(() => demo(job).catch(() => fail(job.id, 'Unable to process this demo. Check server storage.')));
    return store.get('jobs', job.id);
  }
  async function bytes(req, limit) {
    if (req.headers['content-length']) check(Number(req.headers['content-length']) <= limit, 'Request body is too large.', 413);
    const chunks = []; let count = 0;
    for await (const chunk of req) { count += chunk.length; check(count <= limit, 'Request body is too large.', 413); chunks.push(chunk); }
    return Buffer.concat(chunks);
  }
  async function json(req, limit = 32000) {
    try { const value = JSON.parse((await bytes(req, limit)).toString('utf8')); check(value && typeof value === 'object' && !Array.isArray(value), 'Provide a JSON object.'); return value; }
    catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(400, 'Invalid JSON body.'); }
  }
  async function form(req) {
    check(req.headers['content-type']?.startsWith('multipart/form-data'), 'Use multipart/form-data.'); check(!serverless, 'Use the chunked image upload API on Vercel.');
    try { return await new Request('http://localhost', { method: 'POST', headers: { 'content-type': req.headers['content-type'] }, body: await bytes(req, 9 * 1024 * 1024) }).formData(); }
    catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(400, 'Unable to read upload form.'); }
  }
  async function upload(value, field) {
    check(value && typeof value.arrayBuffer === 'function', 'Choose an image file.'); check(value.size > 0 && value.size <= FILE_LIMIT, 'Each image must be nonempty and at most 5 MiB.');
    const content = Buffer.from(await value.arrayBuffer()), mimeType = imageMime(content);
    return { id: id(), field, name: value.name.replace(/[\x00-\x1f]/g, '').slice(0, 150), size: content.length, mimeType, content, extension: { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }[mimeType] };
  }
  async function uploadedReference(uploadId, owner, field) {
    const value = await store.get('uploads', uploadId);
    check(value && value.state === 'ready' && value.owner === owner && !value.jobId && new Date(value.expiresAt) > new Date(), 'Upload is missing, expired or not yours.');
    return { id: value.id, field, name: value.name, size: value.size, mimeType: value.mimeType, file: value.file };
  }
  async function submit(req, owner) {
    let brief, refs = [], saved;
    if (req.headers['content-type']?.startsWith('application/json')) {
      const body = await json(req); brief = validateBrief(body.brief); saved = body.savedAssets || []; check(Array.isArray(body.uploads) && body.uploads.length <= 8, 'Invalid uploads.');
      for (const value of body.uploads) refs.push(await uploadedReference(value.uploadId, owner, value.field));
    } else {
      const value = await form(req);
      try { brief = validateBrief(JSON.parse(value.get('brief'))); saved = JSON.parse(value.get('savedAssets') || '[]'); }
      catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(400, 'Invalid campaign brief or saved assets.'); }
      for (const [field, file] of value.entries()) { if (['brief', 'savedAssets'].includes(field)) continue; check(['reference_image', 'product_images', 'item_images', 'logo'].includes(field), 'Unknown upload field.'); refs.push(await upload(file, field)); }
    }
    check(Array.isArray(saved) && saved.length <= 8, 'Invalid saved assets.');
    for (const value of saved) { check(value && typeof value.id === 'string', 'Invalid saved asset selection.'); const asset = await store.get('assets', value.id); check(asset, 'A saved asset is no longer available.'); refs.push({ ...asset, field: value.field }); }
    validateReferences(refs);
    const stored = [];
    for (const { content, extension, ...ref } of refs) stored.push({ ...ref, file: content ? await store.putFile(content, extension) : ref.file });
    return newJob(brief, stored);
  }
  async function callback(req, job) {
    check(safeEqual(req.headers.authorization, `Bearer ${job.callbackToken}`), 'Invalid callback token.', 401);
    const payload = await json(req, payloadVersion === 2 ? 1024 * 1024 : 72 * 1024 * 1024); check([1, 2].includes(payload.version) && payload.jobId === job.id, 'Invalid callback contract.');
    job = await expire(job.id); if (terminal.has(job.status)) return { ok: true, ignored: true };
    if (payload.event === 'progress') { check(stages.includes(payload.stage) && !['queued', 'complete'].includes(payload.stage), 'Invalid progress stage.'); await update(job.id, payload.stage); }
    else if (payload.event === 'failed') await fail(job.id, 'Generation stopped in n8n. Inspect the execution for provider, quota or validation errors. Create a revision only after checking whether a paid call occurred.');
    else {
      check(payload.event === 'complete' && payload.version === payloadVersion && ['qa_pass', 'needs_review'].includes(payload.status), 'Invalid completion status or workflow version.'); check(Array.isArray(payload.candidates) && payload.candidates.length >= 1 && payload.candidates.length <= 3, 'Return 1-3 candidates.');
      check(payload.report && typeof payload.report === 'object' && !Array.isArray(payload.report) && payload.report.model_assessment_only === true, 'A model review report is required.');
      const expected = canvasSizes[job.brief.format][payload.report.image_resolution]; check(expected && payload.report.requested_size === expected.join('x'), 'Invalid requested canvas.');
      const ids = new Set(), candidates = []; let total = 0;
      for (const candidate of payload.candidates) {
        check(candidate && Number.isInteger(candidate.id) && candidate.id >= 1 && candidate.id <= 3 && !ids.has(candidate.id), 'Invalid candidate IDs.'); ids.add(candidate.id); check(['image/png', 'image/jpeg'].includes(candidate.mimeType), 'Generated candidates must be PNG or JPEG.');
        let image, file;
        if (payload.version === 2) {
          const uploaded = await store.get('uploads', candidate.uploadId);
          check(uploaded?.state === 'ready' && uploaded.jobId === job.id && uploaded.candidateId === candidate.id && uploaded.owner === digest('job:' + job.callbackToken) && uploaded.file === candidate.file && uploaded.mimeType === candidate.mimeType, 'Candidate does not belong to this job.');
          file = uploaded.file; image = await store.readFile(file);
        } else {
          check(!serverless && typeof candidate.data === 'string' && candidate.data.length <= 26000000 && /^[A-Za-z0-9+/]+={0,2}$/.test(candidate.data), 'Invalid candidate image data. Use the version 2 workflow on Vercel.'); image = Buffer.from(candidate.data, 'base64'); check(image.toString('base64').replace(/=+$/, '') === candidate.data.replace(/=+$/, ''), 'Noncanonical candidate base64.');
        }
        check(imageMime(image) === candidate.mimeType, 'Candidate file type does not match.'); total += image.length; check(total <= 50 * 1024 * 1024, 'Combined candidates exceed 50 MiB.');
        const [width, height] = imageDimensions(image, candidate.mimeType), review = candidate.review;
        check(Number.isInteger(review?.score) && review.score >= 0 && review.score <= 100 && typeof review.pass === 'boolean' && Array.isArray(review.issues) && review.issues.every(value => typeof value === 'string' && value.length <= 6500) && qaKeys.every(key => typeof review[key] === 'boolean'), 'Invalid candidate review.');
        check(!review.pass || (review.score >= 90 && review.issues.length === 0 && qaKeys.every(key => review[key]) && width === expected[0] && height === expected[1]), 'Invalid passing candidate.');
        candidates.push({ id: candidate.id, file, image: file ? null : image, mimeType: candidate.mimeType, score: review.score, pass: review.pass, issues: review.issues, checks: Object.fromEntries(qaKeys.map(key => [key, review[key]])), width, height, label: `Candidate ${candidate.id}` });
      }
      check(ids.has(payload.selectedId) && payload.report.selected_candidate === payload.selectedId && payload.report.status === payload.status, 'Report selection does not match.'); check(payload.status !== 'qa_pass' || candidates.find(value => value.id === payload.selectedId).pass, 'A passing result must meet all quality checks.');
      for (const candidate of candidates) { candidate.file ||= await store.putFile(candidate.image, candidate.mimeType === 'image/png' ? 'png' : 'jpg'); delete candidate.image; }
      await update(job.id, 'complete', { candidates, selectedId: payload.selectedId, qaStatus: payload.status, report: payload.report });
    }
    return { ok: true };
  }

  async function handler(req, res) {
    const send = (value, status = 200) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)); };
    const serve = (buffer, mime, name) => { res.writeHead(200, { 'content-type': mime, 'content-length': buffer.length, 'cache-control': 'no-store', ...(name ? { 'content-disposition': `attachment; filename="${name}"` } : {}) }); res.end(buffer); };
    const serveFile = async (file, mime, name) => { const stream = await store.fileStream(file); res.writeHead(200, { 'content-type': mime, 'cache-control': 'no-store', ...(name ? { 'content-disposition': `attachment; filename="${name}"` } : {}) }); await pipeline(stream, res); };
    res.setHeader('x-content-type-options', 'nosniff'); res.setHeader('referrer-policy', 'same-origin'); res.setHeader('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      await ready;
      const url = new URL(req.url, 'http://localhost'), path = url.pathname, localHost = /^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(req.headers.host || ''); check(password || localHost, 'Local-only mode requires a localhost URL.', 403);
      const session = req.headers.cookie?.match(/(?:^|;\s*)formial_session=([a-f0-9]{64})(?:;|$)/)?.[1], owner = session ? digest('session:' + session) : '';
      const callbackMatch = path.match(/^\/api\/n8n\/callback\/([a-f0-9-]{36})(\/uploads)?$/);
      if (callbackMatch && req.method === 'POST') {
        const job = await store.get('jobs', callbackMatch[1]); check(job, 'Unknown job.', 404);
        if (!callbackMatch[2]) { send(await callback(req, job)); return; }
        check(safeEqual(req.headers.authorization, `Bearer ${job.callbackToken}`), 'Invalid callback token.', 401); check(!terminal.has((await expire(job.id)).status), 'Job is finished.', 409);
        const specification = await json(req); check(specification.version === 2 && Number.isInteger(specification.candidateId) && specification.candidateId >= 1 && specification.candidateId <= 3, 'Invalid candidate upload.'); send(await beginUpload(store, { ...specification, owner: digest('job:' + job.callbackToken), jobId: job.id }), 201); return;
      }
      const reference = path.match(/^\/api\/n8n\/reference\/([a-f0-9-]{36})\/([a-f0-9-]{36})$/);
      if (reference && req.method === 'GET') {
        const job = await store.get('jobs', reference[1]); check(job && safeEqual(req.headers.authorization, `Bearer ${job.callbackToken}`), 'Invalid reference access.', 401); check(!terminal.has((await expire(job.id)).status), 'Job is finished.', 409);
        const ref = job.references.find(value => value.id === reference[2]); check(ref, 'Reference not found.', 404); await serveFile(ref.file, ref.mimeType); return;
      }
      if (!['GET', 'HEAD'].includes(req.method) && req.headers.origin) check(req.headers.origin === `http://${req.headers.host}` || req.headers.origin === `https://${req.headers.host}`, 'Cross-origin requests are blocked.', 403);
      if (req.method === 'GET' && ['/', '/app.js', '/styles.css'].includes(path)) { const file = path === '/' ? 'index.html' : path.slice(1); serve(readFileSync(join(root, 'public', file)), { 'index.html': 'text/html; charset=utf-8', 'app.js': 'text/javascript; charset=utf-8', 'styles.css': 'text/css; charset=utf-8' }[file]); return; }
      if (path === '/api/session' && req.method === 'POST') {
        const body = await json(req), key = String(Math.floor(Date.now() / 60000)), expiresAt = new Date((Number(key) + 2) * 60000); check(await store.consumeLogin(key, expiresAt) <= 10, 'Too many login attempts. Wait one minute.', 429);
        check(!password || safeEqual(body.password, password), 'Incorrect workspace password.', 401); await store.releaseLogin(key);
        const token = randomBytes(32).toString('hex'); await store.insert('sessions', { id: digest('session:' + token), expiresAt: new Date(Date.now() + 12 * 3600000) }); res.setHeader('set-cookie', `formial_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${publicUrl.startsWith('https:') ? '; Secure' : ''}`); send({ ok: true }); return;
      }
      if (path === '/api/config' && req.method === 'GET') { send({ mode, loginRequired: Boolean(password), defaults, choices, imageModel: 'Nano Banana Pro', directorModel: 'Gemini 3.1 Pro', maxFileBytes: FILE_LIMIT, storageBackend: store.kind, uploadProtocol: store.kind === 'mongodb' || serverless ? 'chunked' : 'multipart' }); return; }
      const uploadMatch = path.match(/^\/api\/uploads\/([a-f0-9-]{36})\/(?:parts\/(\d+)|(finalize))$/);
      if (uploadMatch) {
        const value = await store.get('uploads', uploadMatch[1]); check(value && new Date(value.expiresAt) > new Date(), 'Upload missing or expired.', 404);
        if (value.jobId) { const job = await store.get('jobs', value.jobId); check(job && !terminal.has((await expire(job.id)).status) && safeEqual(req.headers.authorization, `Bearer ${job.callbackToken}`) && value.owner === digest('job:' + job.callbackToken), 'Invalid candidate upload access.', 401); }
        else { const login = owner && await store.get('sessions', owner); check(login && new Date(login.expiresAt) > new Date() && value.owner === owner, 'Invalid upload access.', 401); }
        if (uploadMatch[2] !== undefined && req.method === 'PUT') { send(await writeUploadPart(store, value, Number(uploadMatch[2]), await bytes(req, CHUNK_BYTES))); return; }
        if (uploadMatch[3] && req.method === 'POST') { await json(req); send(await finishUpload(store, value)); return; }
        throw new HttpError(405, 'Invalid upload method.');
      }
      const login = owner && await store.get('sessions', owner); check(login && new Date(login.expiresAt) > new Date(), 'Sign in to your workspace.', 401);
      if (path === '/api/logout' && req.method === 'POST') { await store.remove('sessions', owner); res.setHeader('set-cookie', 'formial_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'); send({ ok: true }); return; }
      if (path === '/api/uploads' && req.method === 'POST') { const value = await json(req); send(await beginUpload(store, { name: value.name, size: value.size, mimeType: value.mimeType, owner }), 201); return; }
      if (path === '/api/assets' && req.method === 'GET') { send(await store.list('assets')); return; }
      if (path === '/api/assets' && req.method === 'POST') {
        let role, asset;
        if (req.headers['content-type']?.startsWith('application/json')) { const value = await json(req); role = value.role; asset = await uploadedReference(value.uploadId, owner, role); }
        else { const value = await form(req); role = value.get('role'); const { content, extension, ...ref } = await upload(value.get('file'), role); asset = { ...ref, file: await store.putFile(content, extension) }; }
        check(['product_images', 'item_images', 'logo', 'reference_image'].includes(role), 'Invalid asset role.'); asset.createdAt = new Date().toISOString(); asset.id = id(); send(await store.insert('assets', asset), 201); return;
      }
      const assetDelete = path.match(/^\/api\/assets\/([a-f0-9-]{36})$/); if (assetDelete && req.method === 'DELETE') { check(await store.remove('assets', assetDelete[1]), 'Asset not found.', 404); send({ ok: true }); return; }
      if (path === '/api/presets' && req.method === 'GET') { send(await store.list('presets')); return; }
      if (path === '/api/presets' && req.method === 'POST') { send(await store.insert('presets', { id: id(), brief: validateBrief(await json(req)), createdAt: new Date().toISOString() }), 201); return; }
      if (path === '/api/jobs' && req.method === 'GET') { const jobs = []; for (const job of await store.list('jobs')) { const current = await expire(job.id), value = publicJob(current); if (store.kind === 'mongodb') value.report = current.report ? { repair_attempted: current.report.repair_attempted } : undefined; jobs.push(value); } send(jobs); return; }
      if (path === '/api/jobs' && req.method === 'POST') { send(publicJob(await submit(req, owner)), 202); return; }
      const jobMatch = path.match(/^\/api\/jobs\/([a-f0-9-]{36})(?:\/(revision|decision|selection|report|archive))?$/);
      if (jobMatch) {
        let job = await expire(jobMatch[1]); check(job, 'Job not found.', 404); const action = jobMatch[2];
        if (!action && req.method === 'GET') { send(publicJob(job)); return; }
        if (action === 'revision' && req.method === 'POST') {
          check(terminal.has(job.status), 'Wait for this job to finish before requesting changes.', 409); const body = await json(req); check(typeof body.changes === 'string' && body.changes.trim().length > 0 && body.changes.length <= 1000, 'Describe changes in 1-1000 characters.');
          const brief = validateBrief({ ...job.brief, ...(body.brief || {}), campaign: (body.brief?.campaign ?? job.brief.campaign) + '\nRevision request: ' + body.changes.trim() }); validateReferences(job.references); send(publicJob(await newJob(brief, job.references, job.id)), 202); return;
        }
        if (['selection', 'decision'].includes(action) && req.method === 'POST') {
          const body = await json(req); job = await store.mutate('jobs', job.id, value => {
            check(value.status === 'complete', 'Choose a completed candidate.');
            if (action === 'selection') { check(value.candidates.some(candidate => candidate.id === body.selectedId), 'Invalid selection.'); value.selectedId = body.selectedId; value.approval = 'pending'; }
            else { check(['approved', 'rejected', 'pending'].includes(body.approval), 'Invalid review decision.'); value.approval = body.approval; value.reviewedAt = new Date().toISOString(); }
          }); send(publicJob(job)); return;
        }
        const report = { ...job.report, job_id: job.id, parent_id: job.parentId, dashboard_selection: job.selectedId, human_decision: job.approval, mode: job.mode, campaign_brief: job.brief };
        if (action === 'report' && req.method === 'GET') { check(job.status === 'complete', 'Report is not ready.', 409); serve(Buffer.from(JSON.stringify(report, null, 2)), 'application/json', 'creative-report.json'); return; }
        if (action === 'archive' && req.method === 'GET') {
          check(job.status === 'complete', 'Download is not ready.', 409); const selected = job.candidates.find(candidate => candidate.id === job.selectedId), readme = Buffer.from(job.mode === 'demo' ? 'DEMO ONLY. No Google API calls or visual review occurred.' : `Formial Labs. Automated review: ${job.qaStatus}. Human decision: ${job.approval}. Inspect packaging, exact text and claims before publishing.`);
          if (store.kind === 'local') {
            const entries = [[`selected.${selected.file.split('.').at(-1)}`, await store.readFile(selected.file)]]; for (const candidate of job.candidates) entries.push([`candidate-${candidate.id}.${candidate.file.split('.').at(-1)}`, await store.readFile(candidate.file)]);
            entries.push(['creative-report.json', Buffer.from(JSON.stringify(report, null, 2))], ['READ-ME-FIRST.txt', readme]); serve(zip(entries), 'application/zip', `formial-${job.mode}-${job.id.slice(0, 8)}.zip`);
          } else {
            const archive = new ZipArchive({ store: true }); res.writeHead(200, { 'content-type': 'application/zip', 'content-disposition': `attachment; filename="formial-${job.id.slice(0, 8)}.zip"`, 'cache-control': 'no-store' }); const delivery = pipeline(archive, res); delivery.catch(() => archive.abort()); res.once('close', () => { if (!res.writableFinished) archive.abort(); });
            archive.append(await store.fileStream(selected.file), { name: `selected.${selected.file.split('.').at(-1)}` }); for (const candidate of job.candidates) archive.append(await store.fileStream(candidate.file), { name: `candidate-${candidate.id}.${candidate.file.split('.').at(-1)}` });
            archive.append(Buffer.from(JSON.stringify(report, null, 2)), { name: 'creative-report.json' }); archive.append(readme, { name: 'READ-ME-FIRST.txt' }); await archive.finalize(); await delivery;
          }
          return;
        }
      }
      const fileMatch = path.match(/^\/api\/files\/([a-f0-9-]{36}\.(png|jpg|webp|svg))$/);
      if (fileMatch && req.method === 'GET') { check(await store.knownFile(fileMatch[1]), 'File not found.', 404); await serveFile(fileMatch[1], { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', svg: 'image/svg+xml' }[fileMatch[2]], url.searchParams.has('download') ? `formial-creative.${fileMatch[2]}` : null); return; }
      throw new HttpError(404, 'Not found.');
    } catch (error) {
      if (!res.headersSent) send({ error: error instanceof HttpError ? error.message : 'Server storage is unavailable. Check the private connection configuration and server logs.' }, error.status || 500); else res.destroy();
      if (!(error instanceof HttpError)) console.error('Dashboard operation failed:', error.name || 'Error');
    }
  }
  const server = http.createServer(handler); server.on('close', () => { closed = true; });
  return { server, handler, ready, db: store?.db, dataDir, closeStorage: async () => { const storage = await ready; await storage.close(); } };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const host = process.env.HOST || '127.0.0.1', port = Number(process.env.PORT || 3001); check(['127.0.0.1', 'localhost', '::1'].includes(host) || process.env.DASHBOARD_PASSWORD, 'Set DASHBOARD_PASSWORD before binding beyond loopback.');
  const app = createApp(); try { await app.ready; app.server.listen(port, host, () => console.log(`Formial dashboard: http://${host}:${port} (${process.env.GENERATION_MODE || 'demo'} mode)`)); } catch { console.error('Dashboard storage could not start. Check MongoDB configuration privately.'); process.exitCode = 1; }
}
