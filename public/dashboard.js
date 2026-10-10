const $ = s => document.querySelector(s);
const app = $('#app'), dialog = $('#dialog');
const icons = {
  studio: '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="m7 15 4-5 3 3 3-4"/><circle cx="8" cy="8" r="1"/>',
  assets: '<rect x="3" y="7" width="18" height="14" rx="2"/><path d="M7 7V3h10v4M3 12h18M10 12v3h4v-3"/>',
  brief: '<path d="M6 3h9l3 3v15H6zM14 3v5h4M9 12h6M9 16h6"/>',
  history: '<path d="M3 11a9 9 0 1 1 2 7M3 4v7h7M12 7v5l3 2"/>',
  plus: '<path d="M12 5v14M5 12h14"/>', upload: '<path d="M12 16V3m-5 5 5-5 5 5M4 15v6h16v-6"/>',
  arrow: '<path d="M4 12h16m-6-6 6 6-6 6"/>', spark: '<path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5zM20 2v4m-2-2h4"/>',
  check: '<path d="m5 12 4 4L19 6"/>', download: '<path d="M12 3v13m-5-5 5 5 5-5M4 17v4h16v-4"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/>', image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8" cy="8" r="1.5"/><path d="m3 17 6-6 4 4 3-3 5 5"/>',
  book: '<path d="M4 4h6l2 2 2-2h6v16h-6l-2 2-2-2H4zM12 6v16"/>',
};
const icon = name => `<span class="icon" aria-hidden="true"><svg viewBox="0 0 24 24">${icons[name] || icons.image}</svg></span>`;
const esc = x => String(x ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fileUrl = file => `/api/files/${encodeURIComponent(file)}`;
function brandLogo(preview = false) {
  const uploaded = preview && state.uploads.logo?.[0];
  const asset = preview && state.saved.logo?.[0] || state.assets.find(a => a.field === 'logo');
  const src = uploaded?.preview || (asset && fileUrl(asset.file));
  return src ? `<img class="brand-logo" src="${esc(src)}" alt="Formial Labs logo">` : '<span class="brand-text">FORMIAL<span>LABS</span></span>';
}
const date = d => new Date(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const statusName = job => job.status === 'complete' ? job.mode === 'demo' ? 'Demo layout' : job.qaStatus === 'qa_pass' ? 'Automated QA passed' : 'Needs review' : ({ queued: 'Queued', directing: 'Creative direction', generating: 'Generating', reviewing: 'Visual review', repairing: 'Targeted repair', packaging: 'Packaging', failed: 'Failed' }[job.status] || job.status);
const state = { page: 'studio', assets: [], presets: [], jobs: [], uploads: {}, saved: {}, format: 'Feed 4:5', activeJob: null, filter: '', search: '', submitting: false };
let config, poll, draft, toastTimer, viewVersion = 0, refreshing;
function toast(text) { $('#toast').textContent = text; $('#toast').classList.add('visible'); clearTimeout(toastTimer); toastTimer = setTimeout(() => $('#toast').classList.remove('visible'), 4500); }
async function api(path, options = {}) {
  let res;
  try {
    res = await fetch('/api/' + path, { credentials: 'same-origin', ...options });
  } catch {
    throw new Error('Connection to the workspace was interrupted. Keep the dashboard running and check Creative history before generating again.');
  }
  let data;
  try { data = await res.json(); } catch {
    throw new Error('The workspace connection is temporarily unavailable. Check Creative history once it reconnects before generating again.');
  }
  if (!res.ok) { if (res.status === 401 && path !== 'session') login(); throw new Error(data.error || 'Request failed.'); } return data;
}
const post = (path, body) => api(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
async function uploadChunks(file, onProgress) {
  const transfer = await post('uploads', { name: file.name, mimeType: file.type, size: file.size });
  for (let index = 0; index < transfer.parts; index++) {
    if (onProgress) onProgress(index + 1, transfer.parts);
    await api(`uploads/${transfer.uploadId}/parts/${index}`, { method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: file.slice(index * transfer.chunkBytes, (index + 1) * transfer.chunkBytes) });
  }
  return post(`uploads/${transfer.uploadId}/finalize`, {});
}
function revokeUploads() {
  for (const group of Object.keys(state.uploads)) {
    for (const f of state.uploads[group] || []) {
      if (f.preview && typeof f.preview === 'string' && f.preview.startsWith('blob:')) {
        try { URL.revokeObjectURL(f.preview); } catch {}
      }
    }
  }
}
async function refresh() {
  refreshing ||= Promise.all([api('assets'), api('presets'), api('jobs')])
    .then(([assets, presets, jobs]) => { state.assets = assets; state.presets = presets; state.jobs = jobs; })
    .finally(() => { refreshing = null; });
  await refreshing;
}
function syncRoute() {
  if (typeof location === 'undefined') return;
  const hash = state.page === 'job' ? '#job:' + state.activeJob : '#' + state.page;
  if (location.hash !== hash) location.hash = hash;
}
async function navigatePage(page) {
  const render = {studio, assets, presets, history}[page];
  if (!render) return;
  render();
  const version = viewVersion;
  await refresh();
  if (viewVersion !== version || state.page !== page) return;
  if (page === 'history') updateHistoryView();
  else if (page === 'studio') preview();
  else render();
}
async function restoreRoute(force = false) {
  if (!config || !draft || state.page === 'login') return;
  const hash = typeof location === 'undefined' ? '' : location.hash.slice(1);
  if (/^job:[a-f0-9-]{36}$/.test(hash)) {
    if (force || state.page !== 'job' || state.activeJob !== hash.slice(4)) await openJob(hash.slice(4));
    return;
  }
  const page = ['studio', 'assets', 'presets', 'history'].includes(hash) ? hash : 'studio';
  if (force || state.page !== page) ({studio, assets, presets, history}[page])();
  else syncRoute();
}
function badge(text, cls = '') { return `<span class="badge ${cls}">${esc(text)}</span>`; }
function button(text, action, style = '', symbol = '') { return `<button class="button ${style}" data-action="${action}">${symbol ? icon(symbol) : ''}${text}</button>`; }
function shell(content) {
  viewVersion++;
  if (state.page !== 'job') clearTimeout(poll);
  syncRoute();
  app.innerHTML = `<div class="layout"><aside class="sidebar"><div class="brand">${brandLogo()}<small>CREATIVE STUDIO</small></div><div class="eyebrow workspace-label">Your workspace</div><nav class="nav" aria-label="Workspace">${[['studio','Creative studio','studio'],['assets','Brand assets','assets'],['presets','Campaign briefs','brief'],['history','Creative history','history']].map(([page,label,symbol]) => `<button data-page="${page}" class="${state.page === page || state.page === 'job' && page === 'history' ? 'active' : ''}">${icon(symbol)}${label}</button>`).join('')}</nav><div class="sidebar-bottom"><p class="small muted"><span class="status-dot"></span>Formial brand workspace</p><div class="team"><div class="avatar">${icon('studio')}</div><div><strong class="small">Formial Labs</strong><p class="small muted">Creative team</p></div></div></div></aside><main class="main"><header class="topbar"><div class="breadcrumbs">Workspace <strong>/ ${state.page === 'job' ? 'Creative review' : ({studio:'Creative studio',assets:'Brand assets',presets:'Campaign briefs',history:'Creative history'}[state.page])}</strong></div><div class="top-actions">${badge(config.mode === 'demo' ? 'LOCAL DEMO' : 'N8N CONNECTED', config.mode === 'demo' ? 'demo' : 'pass')}${config.loginRequired ? button('Sign out','logout','subtle') : `<div class="avatar">${icon('studio')}</div>`}</div></header><div class="content">${content}<footer class="footer-note"><span>Thoughtful skincare. Thoughtfully made creatives.</span><span>FORMIAL LABS · formial.in</span></footer></div></main></div>`;
}
function notice() { return config.mode === 'demo' ? `<div class="notice">${icon('info')}<span>Demo workspace. Generate illustrative layouts from your uploaded reference. No Google calls or automated visual review.</span></div>` : `<div class="notice">${icon('info')}<span>Every generation is billable. Check product details and ad copy before approval.</span></div>`; }
function field(name, label, type = 'input', max = 100, helper = '') {
  return `<div class="field"><label for="${name}">${label}</label>${type === 'textarea' ? `<textarea id="${name}" name="${name}" maxlength="${max}" rows="3">${esc(draft[name])}</textarea>` : `<input id="${name}" name="${name}" maxlength="${max}" value="${esc(draft[name])}" ${['name','campaign'].includes(name) ? 'required' : ''}>`}${helper ? `<p class="helper">${helper}</p>` : ''}</div>`;
}
function select(name, label, values) { return `<div class="field"><label for="${name}">${label}</label><select id="${name}" name="${name}">${values.map(v => `<option ${draft[name] === v ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select></div>`; }
function uploadBox(group, title, subtitle, compact = false) {
  const files = [...(state.uploads[group] || []).map(f => ({ name: f.name, size: f.size, src: f.preview, saved: false })), ...(state.saved[group] || []).map(a => ({ ...a, src: fileUrl(a.file), saved: true }))];
  return `<div class="section-label"><label>${title}</label><button class="text-button" data-action="pick:${group}" type="button">From brand assets ${icon('arrow')}</button></div><label class="upload-area ${compact ? 'compact' : ''}" data-drop="${group}">${compact ? '' : `<span class="upload-circle">${icon('upload')}</span>`}<strong>${compact ? icon('plus') : ''}${compact ? 'Add ' + title.toLowerCase() : 'Drop your reference here, or browse'}</strong><p>${subtitle}</p><input type="file" data-upload="${group}" accept="image/png,image/jpeg,image/webp" ${['product_images','item_images'].includes(group) ? 'multiple' : ''} aria-label="Upload ${title.toLowerCase()}"></label><div>${files.map((f, i) => `<div class="upload-preview"><img src="${esc(f.src)}" alt="${esc(f.name)}"><div class="details"><strong class="truncate">${esc(f.name)}</strong><p class="small muted">${(f.size / 1024).toFixed(0)} KB${f.saved ? ' · Saved brand asset' : ''}</p></div><button data-action="remove:${group}:${i}" type="button" aria-label="Remove ${esc(f.name)}">×</button></div>`).join('')}</div>`;
}
function formatSelector() {
  return `<div class="field"><label for="format">Format</label><div class="format-choices">${config.choices.format.map(f => `<button type="button" class="format-choice ${draft.format === f ? 'active' : ''}" data-format="${esc(f)}"><span class="shape" aria-hidden="true"></span><span>${esc(f)}</span></button>`).join('')}</div><select id="format" name="format" style="display:none">${config.choices.format.map(v => `<option ${draft.format === v ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select></div>`;
}
function studio() {
  state.page = 'studio';
  shell(`<div class="page-heading"><div><h1>Creative studio</h1><p>Upload a reference, write a brief, and create.</p></div></div>
    <div class="workspace-grid simple-workspace"><form id="creative-form">
      <section class="panel"><div class="panel-body">
        ${uploadBox('reference_image','Reference image','PNG, JPG or WebP &middot; up to 5 MiB')}
        <details class="optional-section" data-section="assets" ${state.openSections?.assets ? 'open' : ''}>
          <summary>Logo & additional images <span>Optional</span></summary><div class="optional-body">
            ${uploadBox('logo','Brand logo','Current logo &middot; one image',true)}
            ${uploadBox('product_images','Product photos','Up to 3 additional angles',true)}
            ${uploadBox('item_images','Required items','Up to 3 objects to include',true)}
          </div>
        </details>
      </div></section>
      <section class="panel"><div class="panel-body">
        <div class="row">${field('name','Campaign name','input',100)}${formatSelector()}</div>
        ${field('campaign','Creative brief','textarea',1800,'Describe the scene, mood and message you want.')}
        <details class="optional-section" data-section="settings" ${state.openSections?.settings ? 'open' : ''}>
          <summary>Copy & advanced settings <span>Optional</span></summary><div class="optional-body">
            ${field('audience','Audience','input',400)}
            ${select('copy_mode','Text treatment',config.choices.copy_mode)}
            <div id="copy-fields" ${draft.copy_mode === 'Photography only' ? 'hidden' : ''}>
              ${field('headline','Exact headline','input',90)}
              ${field('supporting_line','Supporting line','input',140)}
              ${field('cta','Call to action','input',55,'Website: formial.in. Blank fields use the brand defaults.')}
            </div>
            <div class="row">${field('must_include','Must include','textarea',1200)}${field('avoid','Avoid','textarea',800)}</div>
            ${select('reference_role','Reference role',config.choices.reference_role)}
            ${select('theme','Creative theme',config.choices.theme)}
            <button type="button" class="text-button" data-action="save-preset">Save campaign brief ${icon('plus')}</button>
          </div>
        </details>
      </div><div class="submit-bar"><p>${config.mode === 'demo' ? 'Demo only &middot; no AI calls' : 'Gemini + Nano Banana'}</p><button type="submit" class="button primary" id="generate">${config.mode === 'demo' ? 'Generate demo layouts' : 'Generate creatives'} ${icon('arrow')}</button></div><p class="form-error" id="form-error" role="alert"></p></section>
    </form><aside class="preview-panel"><div class="preview-top"><h2>Preview</h2>${badge(draft.format)}</div><div id="preview"></div><p class="preview-caption">Composition preview. Final layouts may differ.</p></aside></div>`);
  preview();
  $('#creative-form').addEventListener('submit', submit);
  $('#creative-form').addEventListener('input', e => { if (e.target.name) { draft[e.target.name] = e.target.value; preview(); } });
  $('#creative-form').addEventListener('change', e => {
    if (e.target.name) {
      draft[e.target.name] = e.target.value;
      if (e.target.name === 'format') {
        document.querySelectorAll('.format-choice').forEach(b => b.classList.toggle('active', b.dataset.format === draft.format));
        const badgeEl = $('.preview-top .badge'); if (badgeEl) badgeEl.textContent = draft.format;
      }
      if (e.target.name === 'copy_mode') $('#copy-fields').hidden = e.target.value === 'Photography only';
      preview();
    }
  });
  bindUploads();
  document.querySelectorAll('details[data-section]').forEach(el => el.addEventListener('toggle', () => { state.openSections ||= {}; state.openSections[el.dataset.section] = el.open; }));
}
function preview() {
  const r = state.uploads.reference_image?.[0] || state.saved.reference_image?.[0];
  const image = r ? `<img src="${esc(r.preview || fileUrl(r.file))}" alt="Main reference composition preview">` : `<div class="preview-empty">${icon('image')}<span>Your reference belongs here</span></div>`;
  const photoOnly = draft.copy_mode === 'Photography only';
  $('#preview').innerHTML = `<div class="preview-canvas" data-theme="${esc(draft.theme)}"><div class="preview-wordmark">${brandLogo(true)}</div>${photoOnly ? '' : `<div class="preview-headline">${esc(draft.headline || config.defaults.headline)}</div><p class="preview-sub">${esc(draft.supporting_line || config.defaults.supporting_line)}</p>`}<div class="preview-reference">${image}</div><div class="preview-footer">${photoOnly ? '<span>Photography only</span>' : `<span>${esc(draft.cta || config.defaults.cta)} ↗</span><span>formial.in</span>`}</div></div>`;
}
function recentRow(job) { const c = job.candidates.find(c => c.id === job.selectedId); const badgeCls = job.mode === 'demo' ? 'demo' : job.approval !== 'pending' ? job.approval : job.status === 'complete' ? (job.qaStatus === 'qa_pass' ? 'pass' : 'needs_review') : job.status === 'failed' ? 'failed' : 'pending'; return `<div class="recent-row" role="button" tabindex="0" data-job="${job.id}">${c ? `<img src="${fileUrl(c.file)}" alt="">` : `<div class="placeholder-thumb">${icon('image')}</div>`}<div class="details"><strong class="truncate">${esc(job.brief.name)}</strong><p>${date(job.createdAt)} · ${esc(job.brief.format)}</p></div>${badge(job.approval === 'pending' ? statusName(job) : job.approval, badgeCls)}</div>`; }
async function addFiles(group, list) {
  const max = { reference_image: 1, product_images: 3, item_images: 3, logo: 1 }[group];
  const next = max === 1 ? [] : [...(state.uploads[group] || [])];
  if (list.length + next.length + (max === 1 ? 0 : (state.saved[group]?.length || 0)) > max) throw new Error(`Choose at most ${max} ${group.replaceAll('_',' ')} file${max > 1 ? 's' : ''}.`);
  for (const file of list) {
    if (!['image/png','image/jpeg','image/webp'].includes(file.type) || file.size > 5 * 1024 * 1024 || file.size === 0) throw new Error('Use nonempty PNG, JPG or WebP images, up to 5 MiB each.');
    // Browser decoding gives useful early feedback; server validation remains authoritative.
    try { const bitmap = await createImageBitmap(file); bitmap.close(); } catch { throw new Error(`${file.name} cannot be read as an image.`); }
    next.push(file);
  }
  let total = next.reduce((a,f) => a + f.size,0);
  for (const key of ['reference_image','product_images','item_images','logo']) {
    if (key !== group) total += (state.uploads[key] || []).reduce((a,f) => a + f.size,0);
    if (!(key === group && max === 1)) total += (state.saved[key] || []).reduce((a,f) => a + f.size,0);
  }
  if (total > 8 * 1024 * 1024) throw new Error('Combined uploads must be at most 8 MiB.');
  if (max === 1) { for (const file of state.uploads[group] || []) URL.revokeObjectURL(file.preview); state.saved[group] = []; }
  for (const f of next) if (!f.preview) f.preview = URL.createObjectURL(f);
  state.uploads[group] = next; studio();
}
function bindUploads() {
  document.querySelectorAll('[data-upload]').forEach(el => el.addEventListener('change', async () => { try { await addFiles(el.dataset.upload, [...el.files]); } catch (e) { toast(e.message); el.value = ''; } }));
  document.querySelectorAll('[data-drop]').forEach(el => {
    el.addEventListener('dragover', e => { e.preventDefault(); el.classList.add('drag'); });
    el.addEventListener('dragleave', () => el.classList.remove('drag'));
    el.addEventListener('drop', async e => { e.preventDefault(); el.classList.remove('drag'); try { await addFiles(el.dataset.drop, [...e.dataTransfer.files]); } catch (err) { toast(err.message); } });
  });
}
async function submit(event) {
  event.preventDefault(); if (state.submitting) return;
  const button = $('#generate'); $('#form-error').textContent = '';
  if (!draft.name || !draft.name.trim()) {
    const err = 'Campaign name is required.';
    $('#form-error').textContent = err; toast(err); return;
  }
  if (!draft.campaign || !draft.campaign.trim()) {
    const err = 'Creative brief is required.';
    $('#form-error').textContent = err; toast(err); return;
  }
  const refCount = (state.uploads.reference_image?.length || 0) + (state.saved.reference_image?.length || 0);
  if (refCount !== 1) {
    const err = 'Choose exactly one main reference image.';
    $('#form-error').textContent = err; toast(err); return;
  }
  state.submitting = true; button.disabled = true;
  const originalText = button.innerHTML;
  try {
    const data = new FormData(); data.append('brief', JSON.stringify(draft));
    const saved = [], uploads = [];
    for (const key of ['reference_image','product_images','item_images','logo']) {
      for (const file of state.uploads[key] || []) {
        if (config.uploadProtocol === 'chunked') {
          button.textContent = `Uploading ${file.name.slice(0, 16)}...`;
          const uploaded = await uploadChunks(file, (curr, total) => {
            button.textContent = `Uploading ${file.name.slice(0, 14)} (${curr}/${total})...`;
          });
          uploads.push({ field: key, uploadId: uploaded.uploadId });
        }
        else data.append(key, file);
      }
      for (const asset of state.saved[key] || []) saved.push({ id: asset.id, field: key });
    }
    data.append('savedAssets',JSON.stringify(saved));
    if (config.uploadProtocol === 'chunked') button.textContent = 'Generating creatives...';
    const job = config.uploadProtocol === 'chunked' ? await post('jobs', { brief: draft, savedAssets: saved, uploads }) : await api('jobs',{method:'POST',body:data});
    revokeUploads(); state.uploads = {}; state.saved = {};
    state.jobs.unshift(job); openJob(job.id);
  } catch (e) { $('#form-error').textContent = e.message; toast(e.message); }
  finally { state.submitting = false; if (button.isConnected) { button.innerHTML = originalText; button.disabled = false; } }
}
function assets() {
  state.page = 'assets'; shell(`<div class="page-heading"><div><div class="eyebrow">The source of truth</div><h1>Your brand, saved.</h1><p>Keep approved product photos, logos and references close at hand.</p></div>${button('Upload asset','upload-asset','primary','plus')}</div><div class="cards">${state.assets.length ? state.assets.map(a => `<article class="asset-card"><img src="${fileUrl(a.file)}" alt="${esc(a.name)}"><div class="card-body"><h3 class="truncate">${esc(a.name)}</h3><p>${esc({logo:'Logo',product_images:'Product photo',item_images:'Required item',reference_image:'Main reference'}[a.field])} · ${(a.size / 1024).toFixed(0)} KB · ${date(a.createdAt)}</p><div class="card-actions">${button('Use in creative',`use-asset:${a.id}`,'','arrow')}${button('Remove',`delete-asset:${a.id}`,'subtle danger')}</div></div></article>`).join('') : `<div class="empty full-empty">${icon('assets')}<h3>Make it unmistakably Formial.</h3><p>Upload your current logo and real product photography. Assets remain on this server and can be reused in every brief.</p>${button('Upload your first asset','upload-asset','primary','plus')}</div>`}</div>`);
}
function presets() {
  state.page = 'presets'; shell(`<div class="page-heading"><div><div class="eyebrow">A good starting point</div><h1>Briefs worth keeping.</h1><p>Reusable campaign direction, exact copy and brand settings.</p></div>${button('New creative','page:studio','primary','plus')}</div><div class="cards">${state.presets.length ? state.presets.map(p => `<article class="preset-card"><h3>${esc(p.brief.name)}</h3><p class="small muted">Saved ${date(p.createdAt)}</p><blockquote>${esc(p.brief.headline || 'Photography only')}</blockquote><p class="small muted">${esc(p.brief.campaign)}</p><div class="chips"><span>${esc(p.brief.format)}</span><span>${esc(p.brief.theme)}</span></div>${button('Use this brief',`use-preset:${p.id}`,'','arrow')}</article>`).join('') : `<div class="empty full-empty">${icon('brief')}<h3>A thoughtful brief goes a long way.</h3><p>Use “Save brief” in the creative studio to keep a campaign’s direction, copy and settings for next time.</p>${button('Create a campaign brief','page:studio','primary','plus')}</div>`}</div>`);
}
function historyCardsHtml(jobs) {
  return jobs.length ? jobs.map(j => { const c = j.candidates.find(c => c.id === j.selectedId); return `<article class="history-card" tabindex="0" role="button" data-job="${j.id}">${c ? `<img class="thumb" src="${fileUrl(c.file)}" alt="${esc(j.brief.name)} selected creative">` : `<div class="thumb empty-thumb">${icon('image')}</div>`}<div class="card-body"><h3 class="truncate">${esc(j.brief.name)}</h3><p>${date(j.createdAt)} · ${esc(j.brief.format)}${j.parentId ? ' · Revision' : ''}</p><div class="card-actions">${badge(statusName(j),j.mode === 'demo' ? 'demo' : j.status === 'failed' ? 'failed' : j.qaStatus)}${badge(j.approval,j.approval)}</div></div></article>`; }).join('') : `<div class="empty full-empty">${icon('history')}<h3>${state.jobs.length ? 'No matching creatives.' : 'A space for every creative.'}</h3><p>${state.jobs.length ? 'Try another filter or campaign name.' : 'Your jobs, candidates and revisions will live here. Start by uploading a reference in the studio.'}</p>${button('Open creative studio','page:studio','primary','plus')}</div>`;
}
function updateHistoryView() {
  const jobs = state.jobs.filter(j => (!state.filter || j.approval === state.filter || j.status === state.filter || state.filter === 'demo' && j.mode === 'demo') && j.brief.name.toLowerCase().includes(state.search.toLowerCase()));
  const cards = $('#history-cards'), count = $('#history-count');
  if (cards) cards.innerHTML = historyCardsHtml(jobs);
  if (count) count.textContent = `${jobs.length} creative${jobs.length === 1 ? '' : 's'}`;
}
function history() {
  state.page = 'history'; const jobs = state.jobs.filter(j => (!state.filter || j.approval === state.filter || j.status === state.filter || state.filter === 'demo' && j.mode === 'demo') && j.brief.name.toLowerCase().includes(state.search.toLowerCase()));
  shell(`<div class="page-heading"><div><div class="eyebrow">Every take, in one place</div><h1>Your creative history.</h1><p>Review candidates, revisit campaigns and keep earlier versions.</p></div>${button('New creative','page:studio','primary','plus')}</div><div class="filter-bar"><input id="history-search" placeholder="Search campaigns…" aria-label="Search campaigns" value="${esc(state.search)}"><select id="history-filter" aria-label="Filter history">${[['','All creatives'],['pending','Pending review'],['approved','Approved'],['rejected','Rejected'],['failed','Failed'],['demo','Demo layouts']].map(([v,t]) => `<option value="${v}" ${v === state.filter ? 'selected' : ''}>${t}</option>`).join('')}</select><span id="history-count" class="muted small">${jobs.length} creative${jobs.length === 1 ? '' : 's'}</span></div><div class="cards" id="history-cards">${historyCardsHtml(jobs)}</div>`);
  $('#history-search')?.addEventListener('input', e => { state.search = e.target.value; updateHistoryView(); });
  $('#history-filter')?.addEventListener('change', e => { state.filter = e.target.value; updateHistoryView(); });
}
async function openJob(jobId) {
  clearTimeout(poll);
  state.activeJob = jobId; state.page = 'job';
  syncRoute();
  renderJob(); await pollJob();
}
const stageList = ['queued','directing','generating','reviewing','repairing','packaging','complete'];
function renderJob() {
  const j = state.jobs.find(j => j.id === state.activeJob); if (!j) return;
  const finished = ['complete','failed'].includes(j.status), completed = j.status === 'complete';
  shell(`<div class="page-heading"><div><div class="eyebrow">${j.parentId ? 'Creative revision' : 'Creative review'} · ${j.id.slice(0,8)}</div><h1>${esc(j.brief.name)}</h1><p>${esc(j.brief.format)} · ${esc(j.brief.theme)} · Created ${date(j.createdAt)} ${j.parentId ? `· <button class="text-button" data-job="${j.parentId}">View previous version</button>` : ''}</p></div>${button('History','page:history','','history')}</div>${j.mode === 'demo' ? `<div class="notice">${icon('info')}<span>DEMO ONLY. These are illustrative layouts using your reference. No Gemini generation, Nano Banana generation or visual QA occurred.</span></div>` : ''}${j.status === 'failed' ? `<div class="error-box"><h3>We couldn’t finish this creative.</h3><p>${esc(j.error)}</p>${button('Create a revision','revision','','plus')}</div>` : `<section class="progress-card"><div class="progress-title"><h2>${completed ? 'Your candidates are ready to compare.' : esc(statusName(j)) + '…'}</h2>${badge(statusName(j),j.mode === 'demo' ? 'demo' : j.qaStatus)}</div><div class="progress-track">${[['queued','Brief received'],['directing','Direction'],['generating','Generation'],['reviewing','Review'],['repairing','Optional repair'],['packaging','Ready']].map(([stage,label]) => { const isRepair = stage === 'repairing'; const skipped = isRepair && completed && !j.report?.repair_attempted; const done = completed ? (isRepair ? Boolean(j.report?.repair_attempted) : true) : stageList.indexOf(stage) < stageList.indexOf(j.status); const cur = !completed && stage === j.status; return `<div class="step ${done ? 'done' : cur ? 'current spinning' : skipped ? 'skipped' : ''}">${label}${skipped ? ' (bypassed)' : ''}</div>`; }).join('')}</div><p class="progress-detail">${completed ? j.mode === 'demo' ? 'Demo complete. Download or request a new revision. No quality score is assigned.' : 'Automated model review is guidance. Check exact labels, packaging and claims before human approval.' : 'You can leave this page. Progress and results are saved to your creative history.'}</p></section>`}${completed ? `<div class="result-toolbar"><div>${badge('Human decision: ' + j.approval,j.approval)} <span class="small muted">${j.candidates.length} candidates · ${j.report?.repair_attempted ? '1 repair used' : 'No repair used'}</span></div><div class="actions">${button('Request changes','revision','','plus')}${button('Reject','reject','subtle danger')}${button('Approve','approve','primary','check')}<a class="button" href="/api/jobs/${j.id}/archive">${icon('download')}Download ZIP</a><a class="button" href="/api/jobs/${j.id}/report">Report</a></div></div><div class="comparison">${j.candidates.map(c => `<article class="candidate ${c.id === j.selectedId ? 'selected' : ''}"><div class="candidate-top"><strong>${esc(c.label)}</strong>${c.id === j.selectedId ? badge('Selected','pass') : button('Select',`select:${c.id}`,'subtle')}</div><img src="${fileUrl(c.file)}" alt="${esc(c.label)} for ${esc(j.brief.name)}"><div class="candidate-info"><div class="score">${c.score == null ? 'Demo' : c.score + '<small> / 100 · automated review</small>'}</div>${c.width ? `<p class="small muted">${c.width} × ${c.height} pixels</p>` : '<p class="small muted">Illustrative composition · no AI score</p>'}<div class="checks">${Object.entries(c.checks).map(([k,v]) => `<span class="${v ? '' : 'bad'}">${v ? '✓' : '×'} ${esc(k.replaceAll('_',' '))}</span>`).join('')}</div>${c.issues.length ? `<ul class="issues">${c.issues.map(i => `<li>${esc(i)}</li>`).join('')}</ul>` : '<p class="small muted">No issues reported by the model reviewer.</p>'}<div class="card-actions"><a class="button" href="${fileUrl(c.file)}?download">${icon('download')}Download ${j.mode === 'demo' ? 'demo SVG' : 'image'}</a>${button('View full size',`full:${c.id}`,'subtle')}</div></div></article>`).join('')}</div>` : ''}<section class="panel result-meta"><div class="panel-head"><h2>Campaign details</h2>${finished ? button('Reuse brief','reuse','','brief') : ''}</div><div class="panel-body"><div><strong>Creative direction</strong>${esc(j.brief.campaign)}</div><div><strong>Audience</strong>${esc(j.brief.audience)}</div><div><strong>Exact copy</strong>${esc(j.brief.copy_mode === 'Photography only' ? 'Photography only · no added text' : [j.brief.headline,j.brief.supporting_line,j.brief.cta].join(' · '))}</div><div><strong>References</strong>${j.references.map(r => esc(r.name)).join(', ')}</div><div><strong>Must include</strong>${esc(j.brief.must_include || 'No additional requirements')}</div><div><strong>Avoid</strong>${esc(j.brief.avoid || 'No additional exclusions')}</div></div></section>`);
}
async function pollJob() {
  clearTimeout(poll); if (state.page !== 'job') return;
  const jobId = state.activeJob;
  try {
    const job = await api(`jobs/${jobId}`), previous = state.jobs.find(j => j.id === job.id);
    if (state.page !== 'job' || state.activeJob !== jobId) return;
    if (previous) state.jobs = state.jobs.map(j => j.id === job.id ? job : j);
    else state.jobs.unshift(job);
    if (JSON.stringify(job) !== JSON.stringify(previous)) renderJob();
    if (!['complete','failed'].includes(job.status)) poll = setTimeout(pollJob,1200);
  } catch (e) {
    if (state.page !== 'job' || state.activeJob !== jobId) return;
    toast(e.message); poll = setTimeout(pollJob,5000);
  }
}
function modal(content) { $('#dialog-content').innerHTML = content; if (!dialog.open) dialog.showModal(); }
function chooseAsset(group) {
  modal(`<h2>Choose a brand asset.</h2><p>Use a saved image as ${esc(group.replaceAll('_',' '))}.</p>${state.assets.length ? `<div class="asset-pick">${state.assets.map(a => `<button data-action="pick-asset:${group}:${a.id}"><img src="${fileUrl(a.file)}" alt=""><span class="truncate">${esc(a.name)}</span></button>`).join('')}</div>` : `<div class="empty"><p>No saved assets yet. Upload an asset from the Brand assets page.</p></div>`}<div class="dialog-actions">${button('Close','close')}</div>`);
}
function assetUpload() {
  modal(`<h2>Save a brand asset.</h2><p>Use only current, approved artwork and photography. PNG, JPEG or WebP, up to 5 MiB.</p><form id="asset-form"><div class="field"><label for="asset-role">Asset role</label><select id="asset-role" name="role"><option value="product_images">Product photo</option><option value="logo">Brand logo</option><option value="reference_image">Reference image</option><option value="item_images">Required item</option></select></div><div class="field"><label for="asset-file">Image</label><input id="asset-file" type="file" name="file" accept="image/png,image/jpeg,image/webp" required></div><p class="form-error" id="asset-error" role="alert"></p><div class="dialog-actions">${button('Cancel','close')}<button class="button primary" type="submit">Save asset</button></div></form>`);
  $('#asset-form').addEventListener('submit', async e => {
    e.preventDefault(); const btn = e.submitter; btn.disabled = true;
    try {
      const form = new FormData(e.target);
      const result = config.uploadProtocol === 'chunked' ? await post('assets', { role: form.get('role'), uploadId: (await uploadChunks(form.get('file'))).uploadId }) : await api('assets',{method:'POST',body:form});
      state.assets.unshift(result); dialog.close(); assets(); toast('Brand asset saved.');
    } catch (err) { $('#asset-error').textContent = err.message; } finally { btn.disabled = false; }
  });
}
function revision() {
  const j = state.jobs.find(j => j.id === state.activeJob);
  modal(`<h2>Make the next take.</h2><p>Describe what should change. This creates a separate job and keeps these candidates intact.${config.mode === 'n8n' ? ' A new revision incurs new Google API calls.' : ' This revision will be a demo.'}</p><form id="revision-form"><div class="field"><label for="revision-changes">Requested changes</label><textarea id="revision-changes" name="changes" maxlength="1000" required placeholder="For example: give the headline more space, soften the lighting, keep the product front-facing."></textarea></div><p class="form-error" id="revision-error" role="alert"></p><div class="dialog-actions">${button('Cancel','close')}<button class="button primary" type="submit">Create revision ${icon('arrow')}</button></div></form>`);
  $('#revision-form').addEventListener('submit', async e => { e.preventDefault(); e.submitter.disabled = true; try { const job = await post(`jobs/${j.id}/revision`,{changes:$('#revision-changes').value}); state.jobs.unshift(job); dialog.close(); openJob(job.id); } catch (err) { $('#revision-error').textContent = err.message; e.submitter.disabled = false; } });
}
async function action(value) {
  const [name, arg, extra] = value.split(':');
  const j = state.jobs.find(j => j.id === state.activeJob);
  if (name === 'page') await navigatePage(arg);
  if (name === 'close') dialog.close();
  if (name === 'save-preset') { const p = await post('presets',draft); state.presets.unshift(p); toast('Campaign brief saved.'); }
  if (name === 'upload-asset') assetUpload();
  if (name === 'delete-asset') modal(`<h2>Remove this saved asset?</h2><p>It will leave your brand library. Earlier jobs keep their reference files.</p><div class="dialog-actions">${button('Cancel','close')}${button('Remove asset',`confirm-delete:${arg}`,'danger')}</div>`);
  if (name === 'confirm-delete') { await api(`assets/${arg}`,{method:'DELETE'}); state.assets = state.assets.filter(a => a.id !== arg); dialog.close(); assets(); toast('Asset removed from the library.'); }
  if (name === 'use-asset') {
    const a = state.assets.find(a => a.id === arg); const group = a.field;
    if (['logo','reference_image'].includes(group)) { for (const f of state.uploads[group] || []) URL.revokeObjectURL(f.preview); state.uploads[group] = []; state.saved[group] = [a]; }
    else { if ((state.uploads[group]?.length || 0) + (state.saved[group] || []).filter(x => x.id !== a.id).length >= 3) throw new Error('Use up to 3 images for this role.'); state.saved[group] = [...(state.saved[group] || []).filter(x => x.id !== a.id),a]; }
    studio(); toast('Brand asset added to your brief.');
  }
  if (name === 'use-preset') { draft = {...state.presets.find(p => p.id === arg).brief}; studio(); toast('Campaign brief loaded. Add your references to continue.'); }
  if (name === 'pick') chooseAsset(arg);
  if (name === 'pick-asset') {
    const a = state.assets.find(a => a.id === extra), max = {reference_image:1,logo:1,product_images:3,item_images:3}[arg];
    if (max === 1) { for (const f of state.uploads[arg] || []) if (f.preview && f.preview.startsWith('blob:')) URL.revokeObjectURL(f.preview); state.uploads[arg] = []; state.saved[arg] = [a]; }
    else { const current = (state.saved[arg] || []).filter(x => x.id !== a.id); if ((state.uploads[arg]?.length || 0) + current.length >= max) throw new Error(`Use up to ${max} images for this role.`); state.saved[arg] = [...current, a]; }
    dialog.close(); studio();
  }
  if (name === 'remove') { const index = Number(extra), count = state.uploads[arg]?.length || 0; if (index < count) { const [file] = state.uploads[arg].splice(index,1); if (file?.preview?.startsWith('blob:')) URL.revokeObjectURL(file.preview); } else state.saved[arg].splice(index-count,1); studio(); }
  if (name === 'revision') revision();
  if (name === 'reuse') { revokeUploads(); draft = {...j.brief}; state.saved = {}; state.uploads = {}; studio(); toast('Brief copied. Add reference images for a new campaign.'); }
  if (name === 'approve' || name === 'reject') { const result = await post(`jobs/${j.id}/decision`,{approval:name === 'approve' ? 'approved' : 'rejected'}); state.jobs = state.jobs.map(job => job.id === j.id ? result : job); renderJob(); toast(name === 'approve' ? 'Human review marked approved.' : 'Creative marked rejected.'); }
  if (name === 'select') { const result = await post(`jobs/${j.id}/selection`,{selectedId:Number(arg)}); state.jobs = state.jobs.map(job => job.id === j.id ? result : job); renderJob(); toast('Selection saved. Human review reset to pending.'); }
  if (name === 'full') { const c = j.candidates.find(c => c.id === Number(arg)); modal(`<h2>${esc(c.label)}</h2><img class="full-image" src="${fileUrl(c.file)}" alt="${esc(c.label)}"><div class="dialog-actions"><a class="button" href="${fileUrl(c.file)}?download">Download</a>${button('Close','close')}</div>`); }
  if (name === 'logout') { await post('logout',{}); login(); }
}
document.addEventListener('click', async e => {
  const target = e.target.closest('[data-action],[data-page],[data-job],[data-format]'); if (!target) return;
  e.preventDefault();
  try {
    if (target.dataset.action) await action(target.dataset.action);
    else if (target.dataset.page) await navigatePage(target.dataset.page);
    else if (target.dataset.job) await openJob(target.dataset.job);
    else if (target.dataset.format) {
      draft.format = target.dataset.format;
      document.querySelectorAll('.format-choice').forEach(b => b.classList.toggle('active', b.dataset.format === draft.format));
      const sel = $('#format'); if (sel) sel.value = draft.format;
      const fmtBadge = $('.preview-top .badge'); if (fmtBadge) fmtBadge.textContent = draft.format;
      preview();
    }
  } catch (err) { toast(err.message); }
});
document.addEventListener('keydown', e => { if (['Enter',' '].includes(e.key) && e.target.matches('[data-job][role="button"]')) { e.preventDefault(); openJob(e.target.dataset.job); } });
dialog.addEventListener('click', e => { if (e.target === dialog) { const r = dialog.getBoundingClientRect(); if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) dialog.close(); } });
function login() {
  state.page = 'login'; viewVersion++;
  clearTimeout(poll);
  app.innerHTML = `<main class="login login-workspace"><section class="login-shell" aria-labelledby="login-title"><div class="brand"><span class="brand-text">FORMIAL<span>LABS</span></span></div><p class="login-kicker">Creative studio</p><h1 id="login-title">Sign in</h1><form id="login-form"><div class="field"><label for="password">Workspace password</label><input id="password" name="password" type="password" autocomplete="current-password" aria-describedby="login-error" required></div><label class="login-options" for="show-password"><input id="show-password" type="checkbox">Show password</label><p id="login-error" class="form-error" role="alert" aria-live="polite"></p><button id="login-submit" class="button primary" type="submit">Sign in ${icon('arrow')}</button></form><footer class="login-footer"><a href="https://formial.in" target="_blank" rel="noopener noreferrer">formial.in</a></footer></section></main>`;
  const form = $('#login-form'), passwordInput = $('#password'), error = $('#login-error'), submitButton = $('#login-submit');
  let signingIn = false;
  $('#show-password').addEventListener('change', e => { passwordInput.type = e.target.checked ? 'text' : 'password'; });
  passwordInput.addEventListener('input', () => { error.textContent = ''; passwordInput.removeAttribute('aria-invalid'); });
  form.addEventListener('submit', async e => {
    e.preventDefault(); if (signingIn) return;
    signingIn = true; error.textContent = ''; submitButton.disabled = true; form.setAttribute('aria-busy', 'true'); submitButton.textContent = 'Signing in...';
    try { await post('session', { password: passwordInput.value }); await refresh(); state.page = 'studio'; await restoreRoute(true); }
    catch (err) { error.textContent = err.message; passwordInput.setAttribute('aria-invalid', 'true'); passwordInput.focus(); }
    finally { signingIn = false; submitButton.disabled = false; form.removeAttribute('aria-busy'); submitButton.innerHTML = `Sign in ${icon('arrow')}`; }
  });
  passwordInput.focus();
}
async function init() {
  config = await api('config'); draft = {...config.defaults};
  if (!config.loginRequired) await post('session',{});
  try {
    await refresh();
    await restoreRoute(true);
  } catch { if (config.loginRequired) login(); }
}
if (typeof window !== 'undefined') window.addEventListener('hashchange', () => restoreRoute().catch(e => toast(e.message)));
init().catch(e => { app.innerHTML = `<div class="loading"><h2>Unable to open the workspace.</h2><p>${esc(e.message)}</p><p>Reload this page once the local server is running.</p></div>`; });
