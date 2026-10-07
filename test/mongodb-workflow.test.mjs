import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { png } from './fixtures.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const generated = spawnSync(process.execPath, ['scripts/adapt-mongodb-workflow.mjs'], { cwd: root, encoding: 'utf8' });
assert.equal(generated.status, 0, generated.stdout + generated.stderr);
const workflow = JSON.parse(readFileSync(resolve(root, 'integration/formial-dashboard-mongodb.n8n.json')));
const nodes = new Map(workflow.nodes.map(node => [node.name, node]));
const AsyncFunction = Object.getPrototypeOf(async function() {}).constructor;
const run = (name, input, lookup, helpers = {}) => new AsyncFunction('$input', '$', 'Buffer', nodes.get(name).parameters.jsCode).call({ helpers }, { first: () => input[0], all: () => input }, lookup, Buffer);

test('MongoDB workflow stays inactive, preserves five credential-based Google nodes, bounds uploads and routes errors', () => {
  assert.equal(workflow.active, false);
  assert.equal(nodes.get('Dashboard Webhook').parameters.path, 'formial-dashboard-mongodb');
  assert.equal(workflow.settings.saveDataSuccessExecution, 'none');
  assert(!workflow.nodes.some(node => node.credentials));
  const google = workflow.nodes.filter(node => node.type === 'n8n-nodes-base.httpRequest' && node.parameters.url.includes('generativelanguage.googleapis.com'));
  assert.equal(google.length, 5);
  for (const node of workflow.nodes) {
    if (node.type === 'n8n-nodes-base.code') new AsyncFunction('$input', '$', 'Buffer', node.parameters.jsCode);
    if (node.onError === 'continueErrorOutput' && !['Build Failure Callback', 'Deliver Failure Callback'].includes(node.name)) assert.equal(workflow.connections[node.name].main[1][0].node, 'Build Failure Callback');
    assert.notEqual(node.retryOnFail, true);
  }
  assert.equal(nodes.get('Fetch References').parameters.options.response.response.outputPropertyName, 'reference');
  assert.equal(nodes.get('Fetch References').parameters.options.redirect.redirect.followRedirects, false);
  assert.equal(nodes.get('Upload Result Parts').parameters.contentType, 'binaryData');
  assert.equal(nodes.get('Upload Result Parts').parameters.inputDataFieldName, 'part');
});

test('Reference URLs are restricted to their authenticated dashboard job and downloaded bytes are validated', async () => {
  const jobId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', refId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  const bytes = png(), body = { version: 2, jobId, callbackToken: 'c'.repeat(64), callbackUrl: 'https://example.com/api/n8n/callback/' + jobId, fields: { campaign: 'Test' }, files: [{ field: 'reference_image', fileName: 'reference.png', mimeType: 'image/png', size: bytes.length, url: 'https://example.com/api/n8n/reference/' + jobId + '/' + refId }] };
  const sources = await run('Prepare Reference Downloads', [{ json: { body } }]);
  assert.equal(sources[0].json.key, 'reference_image');
  await assert.rejects(run('Prepare Reference Downloads', [{ json: { body: { ...body, files: [{ ...body.files[0], url: 'https://another.example/private' }] } } }]), /URL/);
  const lookup = name => ({ all: () => sources, first: () => ({ json: { body } }) });
  const normalized = await run('Normalize Dashboard Submission', [{ binary: { reference: { data: 'filesystem', id: 'stored', fileName: 'download' } } }], lookup, { getBinaryDataBuffer: async () => bytes });
  assert.equal(normalized[0].binary.reference_image.fileName, 'reference.png');
  assert(!normalized[0].json.callbackToken);
  await assert.rejects(run('Normalize Dashboard Submission', [{ binary: { reference: {} } }], lookup, { getBinaryDataBuffer: async () => Buffer.from('bad') }), /size/);
});

test('Result part builder limits every body to 1 MiB and completion contains references, never image base64', async () => {
  const bytes = Buffer.concat([png(), Buffer.alloc(2 * 1048576 + 11)]);
  const transfer = { uploadId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', chunkBytes: 1048576, parts: Math.ceil(bytes.length / 1048576) };
  const pieces = [];
  const parts = await run('Build Result Parts', [{ json: transfer, binary: { image: {} } }], null, { getBinaryDataBuffer: async () => bytes, prepareBinaryData: async value => { pieces.push(Buffer.from(value)); return { id: String(pieces.length) }; } });
  assert.equal(parts.length, 3); assert(pieces.every(value => value.length <= 1048576)); assert(Buffer.concat(pieces).equals(bytes));
  const report = { candidates: [{ id: 1, mimeType: 'image/png', width: 1856, height: 2304 }], reviews: [{ id: 1, score: 96 }], status: 'qa_pass', selected_candidate: 1 };
  const sources = [{ json: { candidateId: 1, size: bytes.length, report } }], finalized = [{ json: { uploadId: transfer.uploadId, file: 'cccccccc-cccc-cccc-cccc-cccccccccccc.png', size: bytes.length, mimeType: 'image/png' } }];
  const lookup = name => name === 'Prepare Result Uploads' ? { all: () => sources } : { first: () => ({ json: { body: { jobId: 'test-job' } } }) };
  const result = (await run('Build Dashboard Result', finalized, lookup))[0].json;
  assert.equal(result.version, 2); assert.equal(result.candidates[0].uploadId, transfer.uploadId); assert(!result.candidates[0].data); assert(JSON.stringify(result).length < 10000);
});
