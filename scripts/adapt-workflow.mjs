import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cloud = process.argv.includes('--cloud');
const wf = JSON.parse(readFileSync(join(root, 'integration/source/formial-ad-creative.n8n.json'), 'utf8'));
wf.name = 'Formial | Dashboard API | Gemini + Nano Banana';
if (cloud) wf.name += ' | Cloud';
wf.active = false; delete wf.id; delete wf.versionId;
wf.nodes = wf.nodes.filter(n => !['Upload Creative Brief', 'Download Creative', 'Create ZIP'].includes(n.name));
delete wf.connections['Upload Creative Brief']; delete wf.connections['Create ZIP']; delete wf.connections['Package Creative'];
const edge = name => ({ node: name, type: 'main', index: 0 });
const connect = (from, to) => { wf.connections[from] = { main: [[edge(to)]] }; };
function node(name, type, parameters, position, typeVersion = 2) {
  const n = { id: randomUUID(), name, type: `n8n-nodes-base.${type}`, typeVersion, parameters, position }; wf.nodes.push(n); return n;
}
node('Dashboard Webhook', 'webhook', { httpMethod: 'POST', path: 'formial-dashboard', authentication: 'headerAuth', responseMode: 'onReceived', options: { responseCode: 202 } }, [0, 320], 2.1).webhookId = randomUUID();
node('Normalize Dashboard Submission', 'code', { jsCode: String.raw`
const body = $input.first().json.body;
if (!body || body.version !== 1 || !/^[a-f0-9-]{36}$/.test(body.jobId || '') || !/^[a-f0-9]{64}$/.test(body.callbackToken || '')) throw new Error('Invalid dashboard envelope.');
if (typeof body.callbackUrl !== 'string' || !/^https?:\/\/[^\s/@?#]+\/api\/n8n\/callback\/[a-f0-9-]{36}$/.test(body.callbackUrl) || !body.callbackUrl.endsWith('/' + body.jobId)) throw new Error('Invalid callback URL.');
if (!body.fields || typeof body.fields !== 'object' || Array.isArray(body.fields) || !Array.isArray(body.files) || body.files.length > 8) throw new Error('Invalid fields/files.');
const limits = { reference_image: 1, product_images: 3, item_images: 3, logo: 1 };
const counts = { reference_image: 0, product_images: 0, item_images: 0, logo: 0 };
const validated = []; let total = 0;
for (const file of body.files) {
  if (!Object.hasOwn(limits, file.field) || ++counts[file.field] > limits[file.field] || typeof file.fileName !== 'string' || typeof file.data !== 'string' || file.data.length > 7000000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(file.data)) throw new Error('Invalid file field, count or base64 data.');
  const bytes = Buffer.from(file.data, 'base64'); total += bytes.length;
  if (!bytes.length || bytes.length > 5 * 1024 * 1024 || total > 8 * 1024 * 1024) throw new Error('Upload limits exceeded.');
  let mime;
  if (bytes.subarray(0, 8).toString('hex') === '89504e470d0a1a0a') mime = 'image/png';
  else if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) mime = 'image/jpeg';
  else if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') mime = 'image/webp';
  else throw new Error('Invalid image signature.');
  if (file.mimeType !== mime) throw new Error('File MIME does not match bytes.');
  validated.push({ key: file.field + (counts[file.field] === 1 ? '' : '_' + counts[file.field]), bytes, fileName: file.fileName.slice(0, 150), mime });
}
if (counts.reference_image !== 1) throw new Error('Exactly one reference required.');
const binary = {};
for (const file of validated) binary[file.key] = await this.helpers.prepareBinaryData(file.bytes, file.fileName, file.mime);
return [{ json: { ...body.fields }, binary }];
` }, [260, 320]);
connect('Dashboard Webhook', 'Normalize Dashboard Submission'); connect('Normalize Dashboard Submission', 'Brand Settings');

const callbackUrl = "={{ $('Dashboard Webhook').first().json.body.callbackUrl }}";
const callbackHeaders = { parameters: [{ name: 'Authorization', value: "={{ 'Bearer ' + $('Dashboard Webhook').first().json.body.callbackToken }}" }] };
function notify(name, body, position) {
  return node(name, 'httpRequest', { method: 'POST', url: callbackUrl, sendHeaders: true, headerParameters: callbackHeaders, sendBody: true, contentType: 'json', specifyBody: 'json', jsonBody: body, options: { timeout: 30000, response: { response: { responseFormat: 'json' } } } }, position, 4.2);
}
// Keep the original generation nodes and bounded repair graph. Progress requests run once,
// then restore every original item so both candidate generations/reviews remain separate.
for (const [source, target, stage, x] of [
  ['Prepare Brief', 'Creative Director', 'directing', 780],
  ['Build Image Request', 'Generate Candidates', 'generating', 1300],
  ['Build Quality Check', 'Inspect Candidates', 'reviewing', 1820],
  ['Build Repair', 'Repair Candidate', 'repairing', 2860],
]) {
  const event = `Start ${stage}`, send = `Progress ${stage}`, restore = `Restore ${stage} items`;
  node(event, 'code', { jsCode: "return [{ json: {} }];" }, [x, 650]);
  notify(send, `={{ { version: 1, jobId: $('Dashboard Webhook').first().json.body.jobId, event: 'progress', stage: '${stage}' } }}`, [x + 100, 650]);
  node(restore, 'code', { jsCode: `return $('${source}').all();` }, [x + 200, 650]);
  connect(source, event); connect(event, send); connect(send, restore); connect(restore, target);
}

node('Build Dashboard Result', 'code', { jsCode: `
const packaged = $input.first();
const report = JSON.parse((await this.helpers.getBinaryDataBuffer(0, 'report')).toString('utf8'));
const candidates = [];
for (const candidate of report.candidates) {
  const data = await this.helpers.getBinaryDataBuffer(0, 'candidate_' + candidate.id);
  candidates.push({ ...candidate, data: data.toString('base64'), review: report.reviews.find(r => r.id === candidate.id) });
}
return [{ json: { version: 1, jobId: $('Dashboard Webhook').first().json.body.jobId, event: 'complete', status: report.status, selectedId: report.selected_candidate, report, candidates } }];
` }, [4160, 320]);
notify('Deliver Dashboard Result', '={{ $json }}', [4420, 320]);
connect('Package Creative', 'Build Dashboard Result'); connect('Build Dashboard Result', 'Deliver Dashboard Result');

node('Build Failure Callback', 'code', { jsCode: "const body = $('Dashboard Webhook').first().json.body; return [{ json: { version: 1, jobId: body.jobId, event: 'failed' } }];" }, [3900, 950]);
notify('Deliver Failure Callback', '={{ $json }}', [4160, 950]); connect('Build Failure Callback', 'Deliver Failure Callback');
for (const n of wf.nodes) {
  if (['code','httpRequest'].some(t => n.type === `n8n-nodes-base.${t}`) && !['Build Failure Callback','Deliver Failure Callback','Deliver Dashboard Result'].includes(n.name)) {
    n.onError = 'continueErrorOutput'; n.retryOnFail = false;
    if (!wf.connections[n.name]) wf.connections[n.name] = { main: [[]] };
    wf.connections[n.name].main[1] = [edge('Build Failure Callback')];
  }
}
const start = wf.nodes.find(n => n.name === 'Start Here');
start.parameters.content = '## FORMIAL DASHBOARD API\nImport inactive. Webhook Header Auth: x-formial-secret = dashboard N8N_WEBHOOK_SECRET.\nSelect Google Header Auth (x-goog-api-key) in all five Google HTTP nodes.\nProgress/results return to the server-issued callback URL using its per-job bearer token.\nActivate, then set N8N_WEBHOOK_URL to the Production Webhook URL.\nDo not enable automatic retries. No browser sees provider credentials.\nSee dashboard/INTEGRATION.md.';
// ImageResponseFormat uses REST enum names, unlike the legacy ImageConfig strings.
// Preserve returned PNG/JPEG bytes without forcing an output MIME type.
for (const n of wf.nodes.filter(n => n.type === 'n8n-nodes-base.code')) {
  n.parameters.jsCode = n.parameters.jsCode
    .replace("mimeType: 'IMAGE_JPEG', delivery: 'INLINE',", '');
}
if (cloud) {
  const settings = wf.nodes.find(n => n.name === 'Brand Settings');
  for (const [from, to] of [
    ['"imageSize": "4K"', '"imageSize": "2K"'],
    ['"candidates": 2', '"candidates": 1'],
    ['"allowOneRepair": true', '"allowOneRepair": false'],
  ]) {
    if (!settings.parameters.jsCode.includes(from)) throw new Error('Cloud configuration source changed: ' + from);
    settings.parameters.jsCode = settings.parameters.jsCode.replace(from, to);
  }
  wf.settings.saveDataSuccessExecution = 'none';
  wf.settings.saveExecutionProgress = false;
  start.parameters.content += '\nCloud first-test profile: one 2K candidate, no repair, full accuracy review. Successful execution data is not saved. Increase quality settings only after a successful live test.';
}
const output = cloud ? 'formial-dashboard-cloud.n8n.json' : 'formial-dashboard.n8n.json';
mkdirSync(join(root, 'integration'), { recursive: true });
writeFileSync(join(root, 'integration', output), JSON.stringify(wf, null, 2));
console.log(`Adapted inactive workflow: ${wf.nodes.length} nodes; ${output}; original preserved.`);
