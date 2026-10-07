import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const output = join(root, '.runtime', 'validation');
mkdirSync(output, { recursive: true });
const wf = JSON.parse(readFileSync(process.env.WORKFLOW_FILE || join(root, 'integration/source/formial-ad-creative.n8n.json'), 'utf8'));
const nodes = new Map(wf.nodes.map(node => [node.name, node]));
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const checks = [];
async function test(name, fn) {
  await fn(); checks.push(name); console.log('PASS ' + name);
}

// Generate a valid, lossless PNG fixture locally, without contacting any model.
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const b of bytes) {
    crc ^= b;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function png(width, height) {
  function chunk(name, data) {
    const type = Buffer.from(name);
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
    const checksum = Buffer.alloc(4); checksum.writeUInt32BE(crc32(Buffer.concat([type, data])));
    return Buffer.concat([length, type, data, checksum]);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  const scanlines = Buffer.alloc((width * 3 + 1) * height, 230);
  for (let y = 0; y < height; y++) scanlines[y * (width * 3 + 1)] = 0;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header),
    chunk('IDAT', deflateSync(scanlines)), chunk('IEND', Buffer.alloc(0))]);
}
const inputPng = png(32, 32);
const resultPng = png(3712, 4608);
function responseParts(parts, finishReason = 'STOP') {
  return { candidates: [{ finishReason, content: { role: 'model', parts } }], usageMetadata: { totalTokenCount: 100 } };
}
function response(value) {
  return responseParts([{ thought: true, text: 'Discarded reasoning, not JSON.' }, { text: JSON.stringify(value) }]);
}
const direction = {
  concept: 'Personal formula, precise care', composition: 'Product at right, clear copy at left',
  lighting: 'Soft studio key light', palette: 'White, cool blue and silver', typography: 'Clear sans serif',
  reference_inventory: ['Uploaded product'], product_invariants: ['Preserve the supplied package'],
  scene_prompt: 'Edit the supplied product into a clean studio advertising composition.', cautions: []
};
function imageResponse(image = resultPng, mimeType = 'image/png') {
  return responseParts([
    { thought: true, inlineData: { mimeType: 'image/png', data: inputPng.toString('base64') } },
    { text: 'Final creative' }, { inlineData: { mimeType, data: image.toString('base64') } }
  ]);
}
const imageItems = (count = 2, image = resultPng, mimeType = 'image/png') => Array.from({ length: count }, () => ({ json: imageResponse(image, mimeType) }));
const reviewItems = reviews => reviews.map(r => ({ json: response({ candidates: [r] }) }));
const inlineParts = request => request.contents[0].parts.filter(p => p.inlineData);
function review(id, score = 96, overrides = {}) {
  return { id, score, product_fidelity: true, brand_consistency: true, text_accuracy: true,
    required_items_present: true, claims_accurate: true, composition_clean: true, no_visible_artifacts: true,
    legible_text_seen: ['FORMIAL LABS', 'Skincare, made personal.', 'Personalised formulas. Dermatologist guidance.', 'Find your custom formula', 'formial.in'],
    issues: [], repair_instructions: '', ...overrides };
}
function context() {
  const store = new Map();
  const binaryStore = new Map();
  let nextId = 0;
  function upload(json = {}, files = { reference_image: inputPng }) {
    const binary = {};
    for (const [name, bytes] of Object.entries(files)) {
      const id = 'file-' + nextId++;
      binaryStore.set(id, bytes);
      binary[name] = { id, data: 'filesystem-v2', fileName: name + '.png', mimeType: 'image/png' };
    }
    return { json, binary };
  }
  async function run(name, item) {
    const inputs = Array.isArray(item) ? item : [item];
    const node = nodes.get(name);
    const fn = new AsyncFunction('$input', '$', '$execution', 'Buffer', node.parameters.jsCode);
    const result = await fn.call({ helpers: {
      getBinaryDataBuffer: async (index, field) => {
        assert.equal(index, 0);
        return binaryStore.get(inputs[index].binary[field].id);
      },
      prepareBinaryData: async (bytes, fileName, mimeType) => {
        const id = 'out-' + nextId++; binaryStore.set(id, bytes);
        return { id, data: 'filesystem-v2', fileName, mimeType };
      }
    } }, { first: () => inputs[0], all: () => inputs }, name => {
      assert(store.has(name), 'Missing referenced node ' + name);
      return { first: () => store.get(name)[0], all: () => store.get(name) };
    }, { id: 'test-run' }, Buffer);
    assert(Array.isArray(result) && result.length > 0); store.set(name, result); return result[0];
  }
  async function prepare(json, files, config = {}) {
    const settings = await run('Brand Settings', upload(json, files));
    Object.assign(settings.json.config, config);
    return run('Prepare Brief', settings);
  }
  async function start(json, files, config) {
    await prepare(json, files, config);
    store.set('Creative Director', [{ json: response(direction) }]);
    return run('Build Image Request', store.get('Creative Director'));
  }
  async function initial(reviews, config) {
    await start(undefined, undefined, config);
    await run('Build Quality Check', imageItems(reviews.length));
    return run('Select Candidate', reviewItems(reviews));
  }
  return { run, upload, prepare, start, initial, store, binaryStore };
}

await test('Workflow graph, node names, references and five credential-based HTTP nodes', () => {
  assert.equal(wf.active, false);
  assert.equal(nodes.size, wf.nodes.length);
  assert.equal(new Set(wf.nodes.map(n => n.id)).size, wf.nodes.length);
  const http = wf.nodes.filter(n => n.type === 'n8n-nodes-base.httpRequest' && n.parameters.authentication === 'genericCredentialType');
  assert.equal(http.length, 5);
  assert(http.every(n => n.parameters.authentication === 'genericCredentialType'));
  assert(http.every(n => n.retryOnFail === false));
  assert(http.every(n => n.parameters.url.includes('https://generativelanguage.googleapis.com/v1beta/models/')));
  assert(http.every(n => n.parameters.url.includes(':generateContent')));
  assert(http.every(n => n.parameters.options.batching.batch.batchSize === 1));
  assert(http.every(n => n.parameters.genericAuthType === 'httpHeaderAuth'));
  assert(http.every(n => n.parameters.options.response.response.responseFormat === 'json'));
  for (const node of wf.nodes) {
    if (node.type === 'n8n-nodes-base.code') {
      new AsyncFunction('$input', '$', '$execution', 'Buffer', node.parameters.jsCode);
      for (const [, name] of node.parameters.jsCode.matchAll(/\$\('([^']+)'\)/g)) assert(nodes.has(name), name);
    }
  }
  const visited = new Set();
  function traverse(name, path = new Set()) {
    assert(!path.has(name), 'Unexpected unbounded cycle');
    visited.add(name);
    for (const branch of wf.connections[name]?.main || []) for (const edge of branch) {
      assert(nodes.has(edge.node)); traverse(edge.node, new Set([...path, name]));
    }
  }
  traverse(process.env.WORKFLOW_FILE ? 'Dashboard Webhook' : 'Upload Creative Brief');
  for (const node of wf.nodes.filter(n => n.type !== 'n8n-nodes-base.stickyNote')) assert(visited.has(node.name));
  assert.equal(wf.connections['Repair Needed'].main[0][0].node, 'Build Repair');
  assert.equal(wf.connections['Repair Needed'].main[1][0].node, 'Package Creative');
});

await test('Filesystem-backed uploads, roles, ordering and multi-file item preservation', async () => {
  const c = context();
  const item = await c.start({ reference_role: 'Style reference' }, {
    reference_image: inputPng, product_images_0: inputPng, product_images_1: inputPng,
    item_images_0: inputPng, item_images_1: inputPng, logo: inputPng
  });
  assert.deepEqual(item.json.refs.map(r => r.role), ['product', 'product', 'logo', 'required item', 'required item', 'style']);
  assert.equal(inlineParts(item.json.requestBody).length, 6);
  assert(inlineParts(item.json.requestBody).every(i => i.inlineData.mimeType === 'image/png'));
  assert.equal(item.json.config.imageModel, 'gemini-3-pro-image');
  assert.equal(item.json.config.visionModel, 'gemini-3.1-pro-preview');
  assert.deepEqual(item.json.requestBody.generationConfig.responseFormat.image, process.env.WORKFLOW_FILE ? {
    aspectRatio: 'ASPECT_RATIO_FOUR_BY_FIVE', imageSize: 'IMAGE_SIZE_FOUR_K'
  } : {
    mimeType: 'IMAGE_JPEG', delivery: 'INLINE', aspectRatio: 'ASPECT_RATIO_FOUR_BY_FIVE', imageSize: 'IMAGE_SIZE_FOUR_K'
  });
  const takes = c.store.get('Build Image Request');
  assert.deepEqual(takes.map(i => i.json.candidateId), [1, 2]);
  assert.notEqual(takes[0].json.requestBody.contents[0].parts[0].text, takes[1].json.requestBody.contents[0].parts[0].text);
  assert(!('candidateCount' in item.json.requestBody.generationConfig));
  assert(!('responseJsonSchema' in item.json.requestBody.generationConfig));
  assert.equal(c.store.get('Prepare Brief')[0].json.requestBody.generationConfig.responseMimeType, 'application/json');
});

await test('Single-reference branded path selects the best passing image and packages real PNG bytes', async () => {
  const c = context();
  const selection = await c.initial([review(1, 93), review(2, 97)]);
  assert.equal(selection.json.selectedId, 2);
  assert.equal(selection.json.needsRepair, false);
  assert.equal(selection.json.status, 'qa_pass');
  const pack = await c.run('Package Creative', selection);
  assert.equal(Object.keys(pack.binary).length, 5);
  assert.deepEqual(c.binaryStore.get(pack.binary.selected.id), resultPng);
  const report = JSON.parse(c.binaryStore.get(pack.binary.report.id).toString());
  assert.equal(report.status, 'qa_pass');
  assert.equal(report.references.length, 1);
  assert.equal(report.provider, 'Google Gemini API');
  assert.equal(report.image_resolution, '4K');
  assert.equal(report.usage.initialImages.length, 2);
  assert.equal(report.usage.initialQuality.length, 2);
  assert(!JSON.stringify(report).includes('base64'));
  assert(pack.json.archiveName.endsWith('.zip'));
});

await test('One repair receives original assets, is reviewed, and may become the winner', async () => {
  const c = context();
  const selected = await c.initial([
    review(1, 70, { product_fidelity: false, issues: ['Bent cap'], repair_instructions: 'Restore cap from reference.' }),
    review(2, 85, { text_accuracy: false, issues: ['Wrong headline'], repair_instructions: 'Restore headline.' })
  ]);
  assert.equal(selected.json.needsRepair, true);
  const repair = await c.run('Build Repair', selected);
  assert.equal(inlineParts(repair.json.requestBody).length, selected.json.refs.length + 1);
  assert(repair.json.requestBody.contents[0].parts[0].text.includes('Original reference numbers are unchanged'));
  await c.run('Build Repair Check', { json: imageResponse() });
  const final = await c.run('Select Final', { json: response({ candidates: [review(3)] }) });
  assert.equal(final.json.selectedId, 3);
  assert.equal(final.json.status, 'qa_pass');
  assert.equal(final.json.repaired, true);
  assert.equal(final.json.needsRepair, false);
  const pack = await c.run('Package Creative', final);
  assert.equal(Object.keys(pack.binary).length, 6);
  await assert.rejects(() => c.run('Build Repair', final), /Repair limit/);
});

await test('A worse repair keeps the better original and labels the output needs_review', async () => {
  const c = context();
  const selected = await c.initial([review(1, 89), review(2, 80)]);
  await c.run('Build Repair', selected);
  await c.run('Build Repair Check', { json: imageResponse() });
  const final = await c.run('Select Final', { json: response({ candidates: [review(3, 50, { product_fidelity: false, issues: ['Wrong bottle'] })] }) });
  assert.equal(final.json.selectedId, 1);
  assert.equal(final.json.status, 'needs_review');
  const pack = await c.run('Package Creative', final);
  assert.match(pack.binary.selected.fileName, /needs_review/);
  assert.match(pack.json.completionTitle, /needs review/);
});

await test('A high numerical score cannot override a failed product, missing item or claim check', async () => {
  for (const key of ['product_fidelity', 'brand_consistency', 'text_accuracy', 'required_items_present', 'claims_accurate', 'composition_clean', 'no_visible_artifacts']) {
    const c = context();
    const selected = await c.initial([review(1, 100, { [key]: false }), review(2, 94)]);
    assert.equal(selected.json.selectedId, 2);
    assert.equal(selected.json.reviews[0].pass, false);
  }
});

await test('Literal transcript checks catch incorrect copy even when the reviewer says text is accurate', async () => {
  const c = context();
  const selected = await c.initial([review(1, 100, { legible_text_seen: ['Wrong headline', 'formial.in'] }), review(2, 91)]);
  assert.equal(selected.json.selectedId, 2);
  assert.equal(selected.json.reviews[0].text_accuracy, false);
});

await test('Output dimensions are independently checked and cannot pass by model score alone', async () => {
  const c = context();
  await c.start();
  await c.run('Build Quality Check', imageItems(2, inputPng));
  const selected = await c.run('Select Candidate', reviewItems([review(1), review(2)]));
  assert.equal(selected.json.status, 'needs_review');
  assert(selected.json.reviews.every(r => r.issues.some(i => i.includes('dimensions'))));
});

await test('Style-only and photography-only submissions avoid invented packaging and added copy', async () => {
  const c = context();
  const item = await c.start({ reference_role: 'Style reference', copy_mode: 'Photography only' });
  assert(item.json.warnings.some(w => w.includes('No authoritative product')));
  assert(Object.values(item.json.copy).every(v => v === ''));
  assert(item.json.prompt.includes('No added logo, headline, CTA or website typography'));
  assert(item.json.prompt.includes('without a fabricated Formial bottle'));
});

await test('Both image models, all four formats and three resolutions select native Gemini canvases', async () => {
  const sizes = {
    'Feed 4:5': ['928x1152', '1856x2304', '3712x4608'],
    'Square 1:1': ['1024x1024', '2048x2048', '4096x4096'],
    'Story 9:16': ['768x1376', '1536x2752', '3072x5504'],
    'Landscape 16:9': ['1376x768', '2752x1536', '5504x3072']
  };
  for (const imageModel of ['gemini-3-pro-image', 'gemini-3.1-flash-image']) {
    for (const [format, dimensions] of Object.entries(sizes)) {
      for (const [index, imageSize] of ['1K', '2K', '4K'].entries()) {
        const item = await context().start({ format }, undefined, { imageModel, imageSize });
        assert.equal(item.json.size, dimensions[index]);
        assert.equal(item.json.requestBody.generationConfig.responseFormat.image.aspectRatio, item.json.apiRatio);
        assert.equal(item.json.requestBody.generationConfig.responseFormat.image.imageSize, { '1K': 'IMAGE_SIZE_ONE_K', '2K': 'IMAGE_SIZE_TWO_K', '4K': 'IMAGE_SIZE_FOUR_K' }[imageSize]);
      }
    }
  }
});

await test('Input validation rejects missing files, spoofed MIME types, excessive counts and sizes', async () => {
  await assert.rejects(() => context().prepare({}, {}), /exactly one/);
  await assert.rejects(() => context().prepare({}, { reference_image: Buffer.from('<svg>not an image</svg>') }), /PNG, JPEG or WebP/);
  await assert.rejects(() => context().prepare({}, { reference_image: inputPng, product_images_0: inputPng,
    product_images_1: inputPng, product_images_2: inputPng, product_images_3: inputPng }), /up to 3/);
  await assert.rejects(() => context().prepare({}, { reference_image: Buffer.alloc(5 * 1024 * 1024 + 1) }), /5 MB/);
  const big = Buffer.alloc(4 * 1024 * 1024); inputPng.copy(big);
  await assert.rejects(() => context().prepare({}, { reference_image: big, product_images_0: big,
    product_images_1: big, product_images_2: big }), /8 MB/);
  await assert.rejects(() => context().prepare({ theme: 'invented theme' }), /Invalid selection/);
  await assert.rejects(() => context().prepare({ headline: 'x'.repeat(91) }), /too long/);
  await assert.rejects(() => context().prepare({}, undefined, { imageModel: 'gemini-2.5-flash-image' }), /Nano Banana/);
  await assert.rejects(() => context().prepare({}, undefined, { imageSize: '8K' }), /imageSize/);
  await assert.rejects(() => context().prepare({}, undefined, { visionModel: '../invalid' }), /vision model/);
});

await test('Incomplete, refused and malformed model responses fail without marking an image approved', async () => {
  const c = context(); await c.prepare();
  await assert.rejects(() => c.run('Build Image Request', { json: responseParts([], 'MAX_TOKENS') }), /MAX_TOKENS/);
  await assert.rejects(() => c.run('Build Image Request', { json: { promptFeedback: { blockReason: 'SAFETY' } } }), /blocked by Gemini/);
  await assert.rejects(() => c.run('Build Image Request', { json: { error: { message: 'Quota exceeded' } } }), /Quota exceeded/);
  await assert.rejects(() => c.run('Build Image Request', { json: responseParts([{ text: 'not json' }]) }), /structured JSON/);
  await c.start();
  await assert.rejects(() => c.run('Build Quality Check', imageItems(1)), /per creative take/);
  await assert.rejects(() => c.run('Build Quality Check', [{ json: responseParts([{ text: 'Cannot produce image' }]) }, imageItems(1)[0]]), /exactly one final image/);
  const corrupt = responseParts([{ inlineData: { mimeType: 'image/png', data: '!!!' } }]);
  await assert.rejects(() => c.run('Build Quality Check', [{ json: corrupt }, imageItems(1)[0]]), /invalid base64/);
  const extra = imageResponse(); extra.candidates[0].content.parts.push({ inlineData: { mimeType: 'image/png', data: inputPng.toString('base64') } });
  await assert.rejects(() => c.run('Build Quality Check', [{ json: extra }, imageItems(1)[0]]), /exactly one final image/);
  await c.run('Build Quality Check', imageItems());
  await assert.rejects(() => c.run('Select Candidate', reviewItems([review(1), review(1)])), /candidate IDs/);
  await assert.rejects(() => c.run('Select Candidate', reviewItems([review(1)])), /response count/);
  await assert.rejects(() => c.run('Select Candidate', [{ json: response({ candidates: [] }) }, reviewItems([review(2)])[0]]), /omitted or added/);
  await assert.rejects(() => c.run('Select Candidate', reviewItems([review(1, 101), review(2)])), /invalid assessment/);
});

await test('One-candidate setting and disabled repair are respected', async () => {
  const c = context();
  const selection = await c.initial([review(1, 75)], { candidates: 1, allowOneRepair: false });
  assert.equal(c.store.get('Build Image Request').length, 1);
  assert.equal(c.store.get('Build Quality Check').length, 1);
  assert.equal(selection.json.needsRepair, false);
  assert.equal(selection.json.status, 'needs_review');
});

await test('Each QA request includes originals and one final image, excluding thought images', async () => {
  const c = context(); await c.start();
  await c.run('Build Quality Check', imageItems());
  const checks = c.store.get('Build Quality Check');
  assert.equal(checks.length, 2);
  for (const [index, item] of checks.entries()) {
    assert.equal(inlineParts(item.json.requestBody).length, 2);
    assert.equal(item.json.candidates[0].id, index + 1);
    assert.equal(item.json.candidates[0].width, 3712);
    assert.deepEqual(item.pairedItem, { item: index });
  }
});

await test('Baseline/progressive JPEG header parsing preserves dimensions, MIME and bytes', async () => {
  // These are header fixtures for the parser, not fully decodable photographs.
  for (const progressive of [false, true]) {
    const c = context(); await c.start();
    const jpg = Buffer.from('ffd8ffe000040000ffc00011080000000003011100021100031100ffd9', 'hex');
    jpg[9] = progressive ? 0xc2 : 0xc0;
    jpg.writeUInt16BE(4608, 13); jpg.writeUInt16BE(3712, 15);
    await c.run('Build Quality Check', imageItems(2, jpg, 'image/jpeg'));
    const selected = await c.run('Select Candidate', reviewItems([review(1), review(2)]));
    assert.equal(selected.json.status, 'qa_pass');
    const pack = await c.run('Package Creative', selected);
    assert.equal(pack.binary.selected.mimeType, 'image/jpeg');
    assert(pack.binary.selected.fileName.endsWith('.jpg'));
    assert.deepEqual(c.binaryStore.get(pack.binary.selected.id), jpg);
  }
});

await test('Serialized payload limit applies before director, generation, QA and repair calls', async () => {
  await assert.rejects(() => context().prepare({}, undefined, { maxRequestBytes: 100 }), /inline request exceeds/);
  const c = context(); await c.start();
  c.store.get('Build Image Request')[0].json.config.maxRequestBytes = 100;
  await assert.rejects(() => c.run('Build Image Request', c.store.get('Creative Director')), /inline request exceeds/);
  await assert.rejects(() => c.run('Build Quality Check', imageItems()), /inline request exceeds/);
  const d = context();
  const selected = await d.initial([review(1, 80), review(2, 75)]);
  selected.json.config.maxRequestBytes = 100;
  await assert.rejects(() => d.run('Build Repair', selected), /inline request exceeds/);
});

const report = [
  '# Workflow Validation', '', 'Generated on: ' + new Date().toISOString(), '',
  checks.length + ' local checks passed using the actual JavaScript embedded in the exported n8n workflow.', '',
  ...checks.map(name => '- PASS: ' + name), '',
  'The harness simulated n8n multi-item lookup, filesystem-backed binary helpers, and Google Gemini API responses. PNG fixtures are synthetic test images. JPEG fixtures test header parsing only, not full decoding. No fixture is a generated ad.', '',
  'Not verified live: import/execution in your self-hosted n8n instance, its credential configuration, actual Google model access, image quality, billing, latency, and the final n8n Form/Compression node runtime.', '',
  'Node parameter names and Google request shapes were checked against official source/documentation linked in SETUP.md. A successful import and a paid end-to-end test with your product photo remain necessary.', ''
].join('\n');
writeFileSync(join(output, 'VALIDATION.md'), report);
console.log(checks.length + ' verification groups passed.');
