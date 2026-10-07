import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('..', import.meta.url));
const prepared = spawnSync(process.execPath, ['scripts/adapt-workflow.mjs', '--cloud'], { cwd: root, encoding: 'utf8' });
if (prepared.status !== 0) throw new Error('Cloud workflow could not be prepared.');
const workflow = JSON.parse(readFileSync(join(root, 'integration/formial-dashboard-cloud.n8n.json'), 'utf8'));
workflow.name = 'Formial | Dashboard API | Gemini + Nano Banana | MongoDB';
const find = name => workflow.nodes.find(node => node.name === name);
find('Dashboard Webhook').parameters.path = 'formial-dashboard-mongodb';
const edge = name => ({ node: name, type: 'main', index: 0 });
const connect = (from, to) => { workflow.connections[from] = { main: [[edge(to)]] }; };
function node(name, type, parameters, position) {
  const value = { id: randomUUID(), name, type: 'n8n-nodes-base.' + type, typeVersion: type === 'code' ? 2 : 4.2, parameters, position, retryOnFail: false, onError: 'continueErrorOutput' };
  workflow.nodes.push(value); return value;
}
const bearer = { parameters: [{ name: 'Authorization', value: "={{ 'Bearer ' + $('Dashboard Webhook').first().json.body.callbackToken }}" }] };
const callback = "$('Dashboard Webhook').first().json.body.callbackUrl";
const options = { timeout: 120000, redirect: { redirect: { followRedirects: false } }, batching: { batch: { batchSize: 1, batchInterval: 0 } }, response: { response: { responseFormat: 'json' } } };
function http(name, url, body, position) {
  return node(name, 'httpRequest', { method: 'POST', url, sendHeaders: true, headerParameters: bearer, sendBody: true, contentType: 'json', specifyBody: 'json', jsonBody: body, options }, position);
}
node('Prepare Reference Downloads', 'code', { jsCode: String.raw`
const body = $input.first().json.body;
if (!body || body.version !== 2 || !/^[a-f0-9-]{36}$/.test(body.jobId || '') || !/^[a-f0-9]{64}$/.test(body.callbackToken || '')) throw new Error('Invalid version 2 envelope.');
if (typeof body.callbackUrl !== 'string' || !/^https?:\/\/[^\s/@?#]+\/api\/n8n\/callback\/[a-f0-9-]{36}$/.test(body.callbackUrl) || !body.callbackUrl.endsWith('/' + body.jobId)) throw new Error('Invalid callback URL.');
if (!body.fields || typeof body.fields !== 'object' || Array.isArray(body.fields) || !Array.isArray(body.files) || body.files.length > 8) throw new Error('Invalid fields or references.');
const origin = body.callbackUrl.slice(0, body.callbackUrl.indexOf('/api/n8n/callback/'));
const limits = { reference_image: 1, product_images: 3, item_images: 3, logo: 1 };
const counts = { reference_image: 0, product_images: 0, item_images: 0, logo: 0 }; let total = 0;
const items = body.files.map(file => {
  if (!Object.hasOwn(limits, file.field) || ++counts[file.field] > limits[file.field] || typeof file.fileName !== 'string' || file.fileName.length > 150 || !['image/png','image/jpeg','image/webp'].includes(file.mimeType) || !Number.isInteger(file.size) || file.size < 1 || file.size > 5242880) throw new Error('Invalid reference metadata.');
  const prefix = origin + '/api/n8n/reference/' + body.jobId + '/';
  if (typeof file.url !== 'string' || !file.url.startsWith(prefix) || !/^[a-f0-9-]{36}$/.test(file.url.slice(prefix.length))) throw new Error('Reference URL must belong to this dashboard job.');
  total += file.size;
  return { json: { ...file, key: file.field + (counts[file.field] === 1 ? '' : '_' + counts[file.field]) } };
});
if (counts.reference_image !== 1 || total > 8388608) throw new Error('Invalid reference count or combined size.');
return items;
` }, [140, 320]);
node('Fetch References', 'httpRequest', { method: 'GET', url: '={{ $json.url }}', sendHeaders: true, headerParameters: bearer, options: { ...options, response: { response: { responseFormat: 'file', outputPropertyName: 'reference' } } } }, [300, 320]);
find('Normalize Dashboard Submission').parameters.jsCode = String.raw`
const sources = $('Prepare Reference Downloads').all(), incoming = $input.all(), binary = {};
if (incoming.length !== sources.length) throw new Error('Reference downloads are incomplete.');
for (let index = 0; index < incoming.length; index++) {
  const source = sources[index].json, bytes = await this.helpers.getBinaryDataBuffer(index, 'reference');
  if (bytes.length !== source.size) throw new Error('Reference download size differs.');
  let mime;
  if (bytes.subarray(0,8).toString('hex') === '89504e470d0a1a0a') mime = 'image/png';
  else if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) mime = 'image/jpeg';
  else if (bytes.toString('ascii',0,4) === 'RIFF' && bytes.toString('ascii',8,12) === 'WEBP') mime = 'image/webp';
  else throw new Error('Invalid reference image signature.');
  if (mime !== source.mimeType) throw new Error('Reference type differs from its bytes.');
  binary[source.key] = { ...incoming[index].binary.reference, fileName: source.fileName, mimeType: mime };
}
return [{ json: { ...$('Dashboard Webhook').first().json.body.fields }, binary }];
`;
find('Normalize Dashboard Submission').position = [460, 320];
connect('Dashboard Webhook', 'Prepare Reference Downloads'); connect('Prepare Reference Downloads', 'Fetch References'); connect('Fetch References', 'Normalize Dashboard Submission');

node('Prepare Result Uploads', 'code', { jsCode: String.raw`
const item = $input.first();
const report = JSON.parse((await this.helpers.getBinaryDataBuffer(0, 'report')).toString('utf8'));
const output = [];
for (const candidate of report.candidates) {
  const field = 'candidate_' + candidate.id, bytes = await this.helpers.getBinaryDataBuffer(0, field);
  output.push({ json: { candidateId: candidate.id, size: bytes.length, mimeType: candidate.mimeType, name: 'candidate-' + candidate.id + '.' + (candidate.mimeType === 'image/png' ? 'png' : 'jpg'), report }, binary: { image: item.binary[field] }, pairedItem: { item: 0 } });
}
return output;
` }, [4120, 320]);
http('Create Result Uploads', `={{ ${callback} + '/uploads' }}`, '={{ { version: 2, candidateId: $json.candidateId, name: $json.name, mimeType: $json.mimeType, size: $json.size } }}', [4300, 320]);
node('Restore Upload Files', 'code', { jsCode: String.raw`
const sources = $('Prepare Result Uploads').all(), responses = $input.all();
if (sources.length !== responses.length) throw new Error('Upload creation omitted an image.');
return responses.map((item, index) => {
  const transfer = item.json, source = sources[index];
  if (!/^[a-f0-9-]{36}$/.test(transfer.uploadId || '') || transfer.chunkBytes !== 1048576 || transfer.parts !== Math.ceil(source.json.size / 1048576)) throw new Error('Invalid upload transfer response.');
  return { json: { candidateId: source.json.candidateId, ...transfer }, binary: source.binary, pairedItem: { item: index } };
});
` }, [4480, 320]);
node('Build Result Parts', 'code', { jsCode: String.raw`
const input = $input.all(), output = [];
for (let index = 0; index < input.length; index++) {
  const transfer = input[index].json, bytes = await this.helpers.getBinaryDataBuffer(index, 'image');
  for (let part = 0; part < transfer.parts; part++) {
    const slice = bytes.subarray(part * transfer.chunkBytes, Math.min(bytes.length, (part + 1) * transfer.chunkBytes));
    output.push({ json: { uploadId: transfer.uploadId, index: part }, binary: { part: await this.helpers.prepareBinaryData(slice, 'part.bin', 'application/octet-stream') }, pairedItem: { item: index } });
  }
}
return output;
` }, [4660, 320]);
node('Upload Result Parts', 'httpRequest', { method: 'PUT', url: `={{ ${callback}.slice(0, ${callback}.indexOf('/api/n8n/callback/')) + '/api/uploads/' + $json.uploadId + '/parts/' + $json.index }}`, sendHeaders: true, headerParameters: { parameters: [...bearer.parameters, { name: 'Content-Type', value: 'application/octet-stream' }] }, sendBody: true, contentType: 'binaryData', inputDataFieldName: 'part', options }, [4840, 320]);
node('Prepare Finalize Uploads', 'code', { jsCode: "return $('Restore Upload Files').all().map((item, index) => ({ json: item.json, pairedItem: { item: 0 } }));" }, [5020, 320]);
http('Finalize Result Uploads', `={{ ${callback}.slice(0, ${callback}.indexOf('/api/n8n/callback/')) + '/api/uploads/' + $json.uploadId + '/finalize' }}`, '={{ {} }}', [5200, 320]);
find('Build Dashboard Result').parameters.jsCode = String.raw`
const sources = $('Prepare Result Uploads').all(), transfers = $input.all();
if (sources.length !== transfers.length) throw new Error('Finalized uploads are incomplete.');
const report = sources[0].json.report;
const candidates = transfers.map((item, index) => {
  const candidate = report.candidates.find(value => value.id === sources[index].json.candidateId), uploaded = item.json;
  if (!candidate || uploaded.mimeType !== candidate.mimeType || uploaded.size !== sources[index].json.size || !/^[a-f0-9-]{36}\.(png|jpg)$/.test(uploaded.file || '')) throw new Error('Invalid finalized candidate.');
  return { ...candidate, file: uploaded.file, uploadId: uploaded.uploadId, review: report.reviews.find(value => value.id === candidate.id) };
});
return [{ json: { version: 2, jobId: $('Dashboard Webhook').first().json.body.jobId, event: 'complete', status: report.status, selectedId: report.selected_candidate, report, candidates } }];
`;
find('Build Dashboard Result').position = [5380, 320]; find('Deliver Dashboard Result').position = [5560, 320];
const chain = ['Package Creative', 'Prepare Result Uploads', 'Create Result Uploads', 'Restore Upload Files', 'Build Result Parts', 'Upload Result Parts', 'Prepare Finalize Uploads', 'Finalize Result Uploads', 'Build Dashboard Result', 'Deliver Dashboard Result'];
for (let index = 0; index < chain.length - 1; index++) connect(chain[index], chain[index + 1]);
for (const value of workflow.nodes) {
  if (value.parameters.jsCode) value.parameters.jsCode = value.parameters.jsCode.replaceAll('version: 1', 'version: 2');
  if (typeof value.parameters.jsonBody === 'string') value.parameters.jsonBody = value.parameters.jsonBody.replaceAll('version: 1', 'version: 2');
  if (value.onError === 'continueErrorOutput' && !['Build Failure Callback', 'Deliver Failure Callback', 'Deliver Dashboard Result'].includes(value.name)) {
    workflow.connections[value.name] ||= { main: [[]] }; workflow.connections[value.name].main[1] = [edge('Build Failure Callback')];
  }
}
find('Start Here').parameters.content = '## FORMIAL MONGODB / VERCEL API\nVersion 2 only. Import as a new inactive workflow. Path: formial-dashboard-mongodb.\nUse existing x-formial-secret Header Auth on Dashboard Webhook and x-goog-api-key Header Auth on all five Google nodes.\nReferences are downloaded from job-scoped authenticated URLs. Results upload in 1 MiB parts; callbacks contain metadata, not base64 images.\nNo MongoDB credentials are needed in n8n. Keep retries disabled.\nStart with one 2K image and no repair; full visual review remains enabled. See MONGODB.md.';
writeFileSync(join(root, 'integration/formial-dashboard-mongodb.n8n.json'), JSON.stringify(workflow, null, 2));
console.log('Inactive MongoDB/version 2 workflow prepared. No provider calls or credentials included.');
