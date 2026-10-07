import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { png } from './fixtures.mjs';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workflowPath = resolve(project,'integration/formial-dashboard.n8n.json');
const workflow = JSON.parse(readFileSync(workflowPath));
const nodes = new Map(workflow.nodes.map(n => [n.name,n]));
const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;

test('Cloud export starts with a bounded test profile and preserves the original workflow', async () => {
  const original = readFileSync(workflowPath, 'utf8');
  const result = spawnSync(process.execPath, ['scripts/adapt-workflow.mjs', '--cloud'], { cwd: project, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(readFileSync(workflowPath, 'utf8'), original);
  const cloud = JSON.parse(readFileSync(resolve(project, 'integration/formial-dashboard-cloud.n8n.json')));
  assert.equal(cloud.active, false);
  assert.equal(cloud.settings.saveDataSuccessExecution, 'none');
  assert.equal(cloud.settings.saveExecutionProgress, false);
  assert(!cloud.nodes.some(node => node.credentials));
  const settings = cloud.nodes.find(node => node.name === 'Brand Settings');
  const fn = new AsyncFunction('$input', settings.parameters.jsCode);
  const [{ json }] = await fn({ first: () => ({ json: {}, binary: {} }) });
  assert.equal(json.config.imageSize, '2K');
  assert.equal(json.config.candidates, 1);
  assert.equal(json.config.allowOneRepair, false);
  assert.equal(json.config.passScore, 90);
  assert.equal(cloud.nodes.length, workflow.nodes.length);
  assert.deepEqual(cloud.connections, workflow.connections);
});

test('Original and adapted generation/review pipeline retain all 16 behavioral verification groups', () => {
  for (const file of ['',workflowPath]) {
    const result = spawnSync(process.execPath,['scripts/verify-workflow.mjs'],{cwd:project,env:{...process.env,WORKFLOW_FILE:file},encoding:'utf8'});
    assert.equal(result.status,0,result.stdout + result.stderr); assert(result.stdout.includes('16 verification groups passed.'));
  }
});
test('Dashboard-specific graph has authenticated trigger, progress restoration, failure delivery and no form completion', () => {
  assert.equal(nodes.get('Dashboard Webhook').parameters.authentication,'headerAuth');
  assert.equal(nodes.get('Dashboard Webhook').parameters.responseMode,'onReceived');
  assert.equal(nodes.get('Dashboard Webhook').parameters.options.responseCode,202);
  assert(!nodes.has('Download Creative')); assert(!nodes.has('Upload Creative Brief'));
  for (const n of nodes.values()) if (n.type === 'n8n-nodes-base.code') new AsyncFunction('$input','$','$execution','Buffer',n.parameters.jsCode);
  for (const name of ['Creative Director','Generate Candidates','Inspect Candidates','Repair Candidate','Inspect Repair','Prepare Brief','Package Creative','Build Dashboard Result']) {
    assert.equal(nodes.get(name).onError,'continueErrorOutput'); assert.equal(workflow.connections[name].main[1][0].node,'Build Failure Callback');
  }
  assert.equal(nodes.get('Restore generating items').parameters.jsCode,"return $('Build Image Request').all();");
  assert.equal(nodes.get('Restore reviewing items').parameters.jsCode,"return $('Build Quality Check').all();");
});
test('Normalize dashboard envelope into original binary fields, preserve multi-image uploads and reject malformed input', async () => {
  const binary = new Map(); let counter = 0;
  const helpers = {prepareBinaryData:async (bytes,fileName,mimeType) => { const id = 'stored-'+counter++; binary.set(id,bytes); return {id,fileName,mimeType,data:'filesystem-v2'}; }};
  const fn = new AsyncFunction('$input','Buffer',nodes.get('Normalize Dashboard Submission').parameters.jsCode);
  const jobId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const body = {version:1,jobId,callbackUrl:'http://127.0.0.1:3000/api/n8n/callback/'+jobId,callbackToken:'b'.repeat(64),fields:{campaign:'Launch',reference_role:'Product photo'},files:['reference_image','product_images','product_images','logo'].map(field => ({field,fileName:field+'.png',mimeType:'image/png',data:png().toString('base64')}))};
  const run = b => fn.call({helpers},{first:() => ({json:{body:b}})},Buffer);
  const result = (await run(body))[0]; assert.deepEqual(Object.keys(result.binary),['reference_image','product_images','product_images_2','logo']); assert.equal(result.json.campaign,'Launch'); assert(!('callbackToken' in result.json));
  await assert.rejects(run({...body,version:2})); await assert.rejects(run({...body,callbackUrl:'file:///tmp/private'})); await assert.rejects(run({...body,files:[{...body.files[0],field:'unknown'}]})); await assert.rejects(run({...body,files:[{...body.files[0],mimeType:'image/jpeg'}]}));
});
test('Result adapter reads filesystem-backed binary files and emits the server callback contract', async () => {
  const report = {status:'needs_review',selected_candidate:1,model_assessment_only:true,candidates:[{id:1,mimeType:'image/png',width:32,height:32}],reviews:[{id:1,score:82,pass:false,issues:['Text drift']}]};
  const fn = new AsyncFunction('$input','$','Buffer',nodes.get('Build Dashboard Result').parameters.jsCode);
  const result = await fn.call({helpers:{getBinaryDataBuffer:async (_,field) => field === 'report' ? Buffer.from(JSON.stringify(report)) : png()}},{first:() => ({json:{},binary:{}})},() => ({first:() => ({json:{body:{jobId:'job-id'}}})}),Buffer);
  assert.equal(result[0].json.event,'complete'); assert.equal(result[0].json.jobId,'job-id'); assert.equal(result[0].json.candidates[0].data,png().toString('base64')); assert.equal(result[0].json.candidates[0].review.score,82);
});
