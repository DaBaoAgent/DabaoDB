/* 爱优护对标视频全自动生产工厂 — 前端逻辑（原生 JS，无框架） */
'use strict';

const $ = (id) => document.getElementById(id);
const LS_KEY = 'aiyouhu.factory.v1';
const RING_LEN = 439.8;

const MODEL_TABLE = {
  mini: { label: 'seedance-2-mini（最便宜 · 720p/15s≈7.5元）', rate: 23, res: ['480p', '720p'] },
  fast: { label: 'seedance-2-fast', rate: 37, res: ['480p', '720p'] },
  2: { label: 'seedance-2（支持 1080p/4K）', rate: 46, res: ['480p', '720p', '1080p'] },
  2.5: { label: 'seedance-2.5', rate: 46, res: ['480p', '720p', '1080p'] },
};
const TOKENS_5S = { '480p': 50638, '720p': 108900, '1080p': 217800 };

const state = {
  cfg: null,
  ref: null,            // {path, name, sizeText}
  refs: [],             // 普通 3 条；全自动批量最多 10 条
  refUrls: [],          // 抖音链接：没有本地对标视频时自动提取
  products: [],         // [{path, url, name}]
  logo: null,           // {path, url, name}
  learn: {},            // 勾选组
  spec: {},
  jobId: null,
  job: null,
  logs: [],
  autoScroll: true,
  showRaw: true,
  es: null,
  resumeTarget: null,
  playBase: null,
  playerAspect: '9:16',
  review: null,
  batchId: null,
  batch: null,
};

// ── 本地持久化 ────────────────────────────────────────────────
function save() {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify({
      learn: state.learn, spec: state.spec,
      productName: $('productName').value, ref: state.ref, refs: state.refs, refUrls: readRefUrls(), automatic: $('autoMode').checked, products: state.products, logo: state.logo,
    }));
  } catch { /* 忽略 */ }
}
function load() {
  try { return JSON.parse(localStorage.getItem(LS_KEY) || 'null'); } catch { return null; }
}

// ── 小工具 ────────────────────────────────────────────────────
function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.textContent = msg;
  $('toasts').appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transform = 'translateY(6px)'; }, 5200);
  setTimeout(() => el.remove(), 5800);
}
const fmtTime = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** 把上游原始报错翻译成人话 + 给出下一步 */
function humanError(raw) {
  const s = String(raw || '');
  if (/may contain real person/i.test(s)) {
    return {
      title: '火山方舟拒收：参考图里检测到真人',
      fix: '产品参考图请只放纯产品图（别放带真人模特的照片）。程序已会自动剔除那张图并重试；也可以点右边的「续跑」从当前进度继续，已经生成的镜不会重复花钱。',
    };
  }
  if (/ModelNotOpen/i.test(s)) return { title: '火山账号里这个模型还没开通', fix: '去火山方舟控制台开通该模型，然后点「续跑」。' };
  if (/Arrearage|欠费|insufficient|balance/i.test(s)) return { title: '火山账号余额不足', fix: '充值后点「续跑」，已生成的镜不会重复花钱。' };
  if (/MANAGED_PROGRAM_DOWN|HyperFrames/i.test(s)) return { title: '本地渲染引擎不可用', fix: '见 README 排障：让 ~/.hyperframes/config.json 的 lastSkillsCheck 保持新鲜。' };
  if (/未拿到 build-id|提交失败/.test(s)) return { title: '提交 Build 失败', fix: '看原始错误；修好后点「续跑」。' };
  return { title: '任务失败', fix: '看下面原始错误；修好后点「续跑」从当前进度继续。' };
}

function showError(raw) {
  const b = $('errBanner');
  if (!raw) { b.classList.remove('on'); b.innerHTML = ''; return; }
  const h = humanError(raw);
  b.innerHTML = `<b>${esc(h.title)}</b><span class="fix">${esc(h.fix)}</span><span class="raw">${esc(String(raw).slice(0, 400))}</span>`;
  b.classList.add('on');
}

/** 「续跑」按钮：只在有可接手的上次任务时可用 */
function armResume(job) {
  const btn = $('btnResume');
  const resumable = !!(job && job.id && job.status !== 'running' && job.status !== 'queued'
    && !(job.status === 'done' && job.previewUrl));
  state.resumeTarget = resumable ? job.id : null;
  btn.disabled = !resumable;
  btn.classList.toggle('armed', resumable && job.status === 'failed');
  $('resumeHint').textContent = !resumable ? '接上次进度继续'
    : job.status === 'failed' ? '接上次失败点继续（不重复花钱）' : '接上次进度继续';
}

async function api(path, opts = {}) {
  const res = await fetch(path, opts);
  const txt = await res.text();
  let json = null;
  try { json = JSON.parse(txt); } catch { /* ignore */ }
  if (!res.ok) throw new Error(json?.error || txt.slice(0, 300) || `HTTP ${res.status}`);
  return json;
}

function uploadFile(file, kind, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/upload?kind=${encodeURIComponent(kind)}&name=${encodeURIComponent(file.name)}`);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.upload.onprogress = (e) => { if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total); };
    xhr.onload = () => {
      let json = null;
      try { json = JSON.parse(xhr.responseText); } catch { /* ignore */ }
      if (xhr.status >= 200 && xhr.status < 300 && json) resolve(json);
      else reject(new Error(json?.error || `上传失败 HTTP ${xhr.status}`));
    };
    xhr.onerror = () => reject(new Error('上传失败（网络中断）'));
    xhr.send(file);
  });
}

// ── 顶部徽章 / 规格下拉 ───────────────────────────────────────
function renderBadges() {
  const c = state.cfg || {};
  const items = [
    `<span class="badge ${c.deepseek?.keyConfigured ? 'ok' : 'warn'}">大脑 ${esc(c.deepseek?.model || 'deepseek-flash')}${c.deepseek?.keyConfigured ? ' · Key 就绪' : ' · Key 缺失'}</span>`,
    `<span class="badge">项目 ${esc((c.paths?.project || '').replace(/^.*[\\/]/, '…'))}</span>`,
    `<span class="badge">成片目录 out/</span>`,
  ];
  if (c.dryStages?.length) items.push(`<span class="badge warn">演练模式：跳过 ${esc(c.dryStages.join(','))}</span>`);
  $('badges').innerHTML = items.join('');
}

function fillSelect(el, list, value) {
  el.innerHTML = list.map((o) => `<option value="${esc(o.value ?? o)}">${esc(o.label ?? o)}</option>`).join('');
  if (value !== undefined) el.value = value;
}

function refreshModelOptions() {
  const m = $('specModel').value;
  const info = MODEL_TABLE[m] || MODEL_TABLE.mini;
  const resList = state.cfg?.resolutions?.filter((r) => info.res.includes(r)) || info.res;
  const cur = $('specRes').value;
  fillSelect($('specRes'), resList, resList.includes(cur) ? cur : resList[resList.length - 1]);
  updateSpecPills();
}

function readSpec() {
  return {
    model: $('specModel').value,
    resolution: $('specRes').value,
    aspect: $('specAspect').value,
    shots: Math.max(1, Math.min(6, Number($('specShots').value) || 1)),
    shotDuration: Math.max(2, Math.min(30, Number($('specDur').value) || 15)),
    audio: $('audioSwitch').classList.contains('on'),
  };
}
function readLearn() {
  const out = {};
  document.querySelectorAll('#learnSwitches .switch-row').forEach((row) => {
    out[row.dataset.key] = row.classList.contains('on');
  });
  return out;
}

function estimate() {
  const s = readSpec();
  const info = MODEL_TABLE[s.model] || MODEL_TABLE.mini;
  const base = TOKENS_5S[s.resolution] || TOKENS_5S['720p'];
  const tokens = s.shots * base * (s.shotDuration / 5);
  return { tokens: Math.round(tokens), yuan: +(tokens / 1e6 * info.rate).toFixed(2) };
}

function updateSpecPills() {
  const s = readSpec();
  const est = estimate();
  $('estPill').innerHTML = `预计花费 ≈ <b>¥${est.yuan}</b>`;
  $('specPill').textContent = `${s.shots} 镜 × ${s.shotDuration}s · ${s.aspect} · ${s.resolution} · ${s.model}${s.audio ? ' · 有声' : ' · 静音'}`;
  $('pillModel').innerHTML = `模型 <b>${esc(s.model)}</b>`;
  $('pillSpec').innerHTML = `规格 <b>${s.shots}×${s.shotDuration}s · ${s.aspect} · ${s.resolution}</b>`;
}

// ── 上传交互 ──────────────────────────────────────────────────
function wireDrop(dropId, inputId, barId, onFiles) {
  const drop = $(dropId), input = $(inputId), bar = $(barId);
  drop.addEventListener('click', () => input.click());
  input.addEventListener('change', () => { if (input.files?.length) onFiles([...input.files]); input.value = ''; });
  ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('dragover'); }));
  ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('dragover'); }));
  drop.addEventListener('drop', (e) => { const f = [...(e.dataTransfer?.files || [])]; if (f.length) onFiles(f); });
  return { drop, bar };
}

function setBar(bar, pct) {
  bar.classList.add('on');
  bar.firstElementChild.style.width = `${Math.round(pct * 100)}%`;
  if (pct >= 1) setTimeout(() => { bar.classList.remove('on'); bar.firstElementChild.style.width = '0'; }, 700);
}

async function handleRefFiles(files) {
  const max = $('autoMode').checked ? 10 : 3;
  const room = max - state.refs.length;
  if (room <= 0) return toast(`当前模式对标视频最多 ${max} 条`, 'error');
  for (const f of files.filter((x) => x.type.startsWith('video/')).slice(0, room)) {
    try {
      const r = await uploadFile(f, 'ref', (p) => setBar($('refBar'), p));
      state.refs.push({ path: r.path, name: r.name, sizeText: r.sizeText });
    } catch (e) { toast('对标视频上传失败：' + e.message, 'error'); }
  }
  state.ref = state.refs[0] || null;
  renderRefs(); save();
}

function renderRefs() {
  const list = state.refs || [];
  $('dropRef').classList.toggle('has-file', !!list.length);
  $('refFile').innerHTML = list.map((ref, i) => `<span class="ref-line">✓ ${esc(ref.name)} · ${esc(ref.sizeText || '')}<button class="thumb-del" data-ref="${i}" title="移除">✕</button></span>`).join('');
  $('pillRef').innerHTML = list.length ? `对标 <b>${list.length} 条独立方案</b>` : '对标 <b>—</b>';
  $('refFile').querySelectorAll('[data-ref]').forEach((button) => button.addEventListener('click', (event) => {
    event.stopPropagation(); state.refs.splice(Number(button.dataset.ref), 1); state.ref = state.refs[0] || null; renderRefs(); save();
  }));
}

function readRefUrls() {
  const input = $('douyinLinks');
  const max = $('autoMode').checked ? 10 : 3;
  return input ? input.value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(0, max) : [];
}

function syncAutomaticMode() {
  const automatic = $('autoMode').checked;
  const max = automatic ? 10 : 3;
  $('refLimitHint').textContent = automatic ? '全自动模式最多 10 条，逐条独立成片' : '普通模式最多 3 条，各自独立生成';
  $('refDropText').textContent = automatic ? '点击或拖入 1–10 条对标视频' : '点击或拖入 1–3 条对标视频';
  $('linkLimitHint').textContent = `每行一个，1–${max} 条`;
  $('btnGenerate').firstChild.textContent = automatic ? '一键智能批量生成\n            ' : '免费拆解并生成方案\n            ';
  $('btnSub').textContent = automatic ? '拆解 → 方案 → 自愈 → 成片，全程自动完成' : '先分析对标视频，确认后才会产生出片费用';
  if (state.refs.length > max) {
    state.refs = state.refs.slice(0, max); state.ref = state.refs[0] || null; renderRefs();
    toast(`已按普通模式保留前 ${max} 条对标视频`, 'error');
  }
  save();
}

async function handleProdFiles(files) {
  const room = 9 - state.products.length;
  if (room <= 0) return toast('产品参考图最多 9 张', 'error');
  for (const f of files.slice(0, room)) {
    try {
      const r = await uploadFile(f, 'product', (p) => setBar($('prodBar'), p));
      state.products.push({ path: r.path, url: r.url, name: r.name });
      renderProducts();
    } catch (e) { toast('产品图上传失败：' + e.message, 'error'); }
  }
  save();
}

async function handleLogoFiles(files) {
  const f = files.find((x) => x.type.startsWith('image/')) || files[0];
  if (!f) return;
  try {
    const r = await uploadFile(f, 'logo', (p) => setBar($('logoBar'), p));
    state.logo = { path: r.path, url: r.url, name: r.name, sizeText: r.sizeText };
    $('dropLogo').classList.add('has-file');
    $('logoFile').textContent = `✓ ${r.name} · ${r.sizeText}`;
    save();
    toast('Logo 已就绪：生成时会作为机身真标参考', 'ok');
  } catch (e) { toast('Logo 上传失败：' + e.message, 'error'); }
}

function renderProducts() {
  $('prodThumbs').innerHTML = state.products.map((p, i) => `
    <div class="thumb"><img src="${p.url}" alt="${esc(p.name)}">
      <button class="thumb-del" data-i="${i}" title="移除">✕</button>
      <span class="n">${i + 1}</span>
    </div>`).join('');
  $('prodCount').textContent = `${state.products.length} / 9`;
  $('prodThumbs').querySelectorAll('.thumb-del').forEach((b) => {
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      state.products.splice(Number(b.dataset.i), 1);
      renderProducts(); save();
    });
  });
}

function reviewList(items) {
  const list = Array.isArray(items) ? items.filter(Boolean) : [];
  return list.length ? list.map((x) => `• ${String(x)}`).join('\n') : '暂无';
}
function openReview(review, estimate) {
  state.review = { ...review, estimate };
  $('reviewVideoType').textContent = review.videoType || '按对标视频结构生成';
  $('reviewPlatform').textContent = review.platformStyle || '9:16 竖屏短视频风格';
  $('reviewStructure').textContent = reviewList(review.structure);
  $('reviewCost').textContent = `约 ¥${estimate?.yuan ?? '—'} / 条（720p · 9:16 · 15 秒）`;
  $('reviewAudience').value = review.targetAudience || '';
  $('reviewPoints').value = (review.sellingPoints || []).join('\n');
  $('reviewBanned').value = review.bannedWords || '';
  $('reviewTitleInput').value = review.title || '';
  $('reviewTags').value = (review.tags || []).join(' ');
  $('reviewRisks').textContent = reviewList(review.risks);
  $('reviewShots').innerHTML = (review.shots || []).map((shot, i) => `<div class="review-shot"><label for="reviewShot${i}">第 ${i + 1} 镜 · 15 秒</label><textarea class="input" id="reviewShot${i}">${esc(shot.提示词 || '')}</textarea></div>`).join('');
  const over = Number(estimate?.yuan || 0) > 20;
  $('reviewWarning').textContent = over ? '⚠ 预计费用超过 ¥20，确认后仍可继续生成。' : '确认后将开始付费生成；此前阶段未调用视频模型。';
  $('reviewWarning').style.color = over ? 'var(--amber)' : '';
  $('reviewModal').classList.remove('hidden');
}
function closeReview() { $('reviewModal').classList.add('hidden'); }
async function confirmReview() {
  if (!state.jobId || !state.review) return;
  const btn = $('btnConfirmReview');
  btn.disabled = true;
  const shots = (state.review.shots || []).map((s, i) => ({ 提示词: $(`reviewShot${i}`).value }));
  const review = {
    targetAudience: $('reviewAudience').value.trim(),
    sellingPoints: $('reviewPoints').value.split('\n').map((x) => x.trim()).filter(Boolean),
    bannedWords: $('reviewBanned').value.trim(),
    title: $('reviewTitleInput').value.trim(),
    tags: $('reviewTags').value.split(/[\s,，]+/).map((x) => x.trim()).filter(Boolean),
    shots,
  };
  try {
    const r = await api(`/api/jobs/${state.jobId}/confirm`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ review }) });
    state.jobId = r.id;
    closeReview();
    $('btnGenerate').disabled = true;
    $('btnGenerate').classList.add('running');
    $('btnSub').textContent = '正在生成成片…';
    $('btnCancel').classList.remove('hidden');
    toast('已确认方案，开始付费生成', 'ok');
    refreshHistory();
  } catch (e) { toast('确认失败：' + e.message, 'error'); }
  finally { btn.disabled = false; }
}

function batchReviewFields(job, index) {
  const review = job.review || {};
  const shot = review.shots?.[0]?.提示词 || '';
  return `<div class="batch-fields">
    <div><label>目标人群</label><input class="input" data-batch="audience-${index}" value="${esc(review.targetAudience || '')}"></div>
    <div><label>标题</label><input class="input" data-batch="title-${index}" value="${esc(review.title || '')}"></div>
    <div><label>卖点（每行一个）</label><textarea class="input" data-batch="points-${index}">${esc((review.sellingPoints || []).join('\n'))}</textarea></div>
    <div><label>禁用词</label><textarea class="input" data-batch="banned-${index}"></textarea></div>
    <div style="grid-column:1/-1"><label>标签</label><input class="input" data-batch="tags-${index}" value="${esc((review.tags || []).join(' '))}"></div>
    <div style="grid-column:1/-1"><label>15 秒分镜与台词</label><textarea class="input" data-batch="shot-${index}">${esc(shot)}</textarea></div>
  </div>`;
}
function openBatchReview(batch) {
  state.batch = batch; state.batchId = batch.id;
  const ready = (batch.jobs || []).map((job, index) => ({ job, index })).filter(({ job }) => job.status === 'awaiting_confirmation');
  $('batchList').innerHTML = ready.map(({ job, index }) => {
    const review = job.review || {};
    return `<article class="batch-card selected" data-batch-card="${index}">
      <label class="pick"><input type="checkbox" data-batch-pick="${index}" checked><span>方案 ${index + 1} · ${esc(job.productName || '')}</span></label>
      <div class="batch-meta"><span class="meta-pill">${esc(review.videoType || '短视频方案')}</span><span class="meta-pill">${esc(review.platformStyle || '9:16 短视频')}</span><span class="meta-pill cost">约 ¥${job.estimate?.yuan ?? '—'}</span></div>
      <div class="review-read">${esc((review.structure || []).slice(0, 3).map((x) => `• ${x}`).join('\n') || '结构分析已完成')}</div>
      <details><summary>编辑本条方案</summary>${batchReviewFields(job, index)}</details>
    </article>`;
  }).join('') || '<div class="empty-hint">没有可确认的方案</div>';
  $('batchList').querySelectorAll('[data-batch-pick]').forEach((box) => box.addEventListener('change', () => {
    box.closest('.batch-card').classList.toggle('selected', box.checked); updateBatchTotal();
  }));
  updateBatchTotal(); $('batchModal').classList.remove('hidden');
}
function updateBatchTotal() {
  const cards = [...$('batchList').querySelectorAll('[data-batch-pick]')];
  const selected = cards.filter((box) => box.checked);
  const total = selected.reduce((sum, box) => sum + Number(state.batch?.jobs?.[Number(box.dataset.batchPick)]?.estimate?.yuan || 0), 0);
  $('batchTotal').textContent = `已选择 ${selected.length} 条 · 预计 ¥${total.toFixed(2)}（每条独立计费）`;
}
function batchValue(key) { return document.querySelector(`[data-batch="${key}"]`)?.value || ''; }
async function confirmBatchReview() {
  const picks = [...$('batchList').querySelectorAll('[data-batch-pick]')].filter((box) => box.checked);
  if (!picks.length) return toast('请至少选择一条方案', 'error');
  const items = picks.map((box) => {
    const i = Number(box.dataset.batchPick); const job = state.batch.jobs[i];
    return { jobId: job.id, review: {
      targetAudience: batchValue(`audience-${i}`).trim(), title: batchValue(`title-${i}`).trim(),
      sellingPoints: batchValue(`points-${i}`).split('\n').map((x) => x.trim()).filter(Boolean),
      bannedWords: batchValue(`banned-${i}`).trim(),
      tags: batchValue(`tags-${i}`).split(/[\s,，]+/).map((x) => x.trim()).filter(Boolean),
      shots: [{ 提示词: batchValue(`shot-${i}`).trim() }],
    }};
  });
  const btn = $('btnConfirmBatch'); btn.disabled = true;
  try {
    const r = await api(`/api/batches/${state.batchId}/confirm`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items }) });
    $('batchModal').classList.add('hidden'); state.batchId = null;
    $('btnGenerate').disabled = true; $('btnGenerate').classList.add('running');
    $('btnSub').textContent = `正在生成 ${r.ids.length} 条独立成片…`;
    toast(`已确认 ${r.ids.length} 条方案，开始依次生成`, 'ok'); refreshHistory();
  } catch (e) { toast('批量确认失败：' + e.message, 'error'); }
  finally { btn.disabled = false; }
}

// ── 步骤条 / 进度环 / 分镜 / 播放器 ───────────────────────────
function renderSteps(uiIndex, stages) {
  const names = state.cfg?.steps || ['拆解', '分镜', '生成镜像', '合成', '导出'];
  $('steps').innerHTML = names.map((n, i) => {
    const cls = stages ? (i < uiIndex ? 'done' : i === uiIndex ? 'active' : '') : '';
    return `<div class="step ${cls}"><div class="node">${i + 1}</div>${esc(n)}</div>`;
  }).join('');
}

function setCoreFlow(stage, status) {
  const group = { prepare: 'breakdown', breakdown: 'breakdown', analyze: 'breakdown', storyboard: 'plan', render: 'plan', plan: 'plan', generate: 'heal', compose: 'delivery', export: 'delivery' };
  const active = status === 'done' ? 'delivery' : (group[stage] || '');
  const order = ['breakdown', 'plan', 'heal', 'delivery'];
  const current = order.indexOf(active);
  document.querySelectorAll('.core-step').forEach((el, index) => {
    el.classList.toggle('active', index === current);
    el.classList.toggle('done', current > index || status === 'done');
  });
  const texts = {
    breakdown: '正在免费拆解对标内容',
    plan: '正在生成可编辑方案',
    heal: '正在逐镜生成，并自动处理素材问题',
    delivery: status === 'done' ? '已交付：成片、封面与发布文案已保存' : '正在导出可发布成品',
  };
  $('coreFlowStatus').textContent = texts[active] || '准备就绪：免费拆解后再确认出片';
}

function setProgress(pct, stageName, busy) {
  const p = Math.max(0, Math.min(100, Number(pct) || 0));
  $('ringBar').setAttribute('stroke-dashoffset', String(RING_LEN * (1 - p / 100)));
  $('ringPct').innerHTML = `${p}<span>%</span>`;
  $('ringStage').textContent = stageName || '待命';
  $('ring').classList.toggle('busy', !!busy);
}

function renderShots(shots) {
  if (!shots?.length) {
    $('shotGrid').innerHTML = '<div class="empty-hint" style="grid-column:1/-1">生成开始后，每一镜完成这里会实时点亮</div>';
    $('shotHint').textContent = '尚未开始';
    return;
  }
  const wide = (state.spec.aspect || '9:16') !== '9:16';
  $('shotGrid').innerHTML = shots.map((s) => {
    const label = `<span class="label">第 ${s.index} 镜</span>`;
    if (s.status === 'done' && s.thumb) {
      return `<div class="shot ${wide ? 'wide' : ''} done playable" data-shot="${s.index}" title="点击在成片预览里播放这一镜">${label}<img src="${s.thumb}?t=${Date.now()}" alt="第${s.index}镜"><span class="play-badge">▶</span></div>`;
    }
    if (s.status === 'running') {
      return `<div class="shot ${wide ? 'wide' : ''} running">${label}<div class="shimmer"></div><div class="spin-sm"></div></div>`;
    }
    if (s.status === 'failed') return `<div class="shot ${wide ? 'wide' : ''} failed">${label}<div class="state">生成失败</div></div>`;
    return `<div class="shot ${wide ? 'wide' : ''}">${label}<div class="state">${s.status === 'scripted' ? '提示词已就绪' : '排队中'}</div></div>`;
  }).join('');
  const done = shots.filter((s) => s.status === 'done').length;
  $('shotHint').textContent = `${done} / ${shots.length} 镜完成${done ? ' · 点缩略图可单镜回放' : ''}`;
  // 点某一镜的缩略图 → 在成片预览里播这一镜
  $('shotGrid').querySelectorAll('.shot.playable').forEach((el) => {
    el.addEventListener('click', () => {
      const nn = String(el.dataset.shot).padStart(2, '0');
      if (!state.playBase) return toast('先按「开始生成视频」或从历史里点「回放」', 'error');
      showFinal(`${state.playBase}shot/shot${nn}.mp4`, null, null, null);
      $('finalHint').textContent = `第 ${Number(el.dataset.shot)} 镜回放`;
    });
  });
  state.spec = readSpec();
}

/** 预览框跟随画幅：竖屏为主（9:16），也可切 16:9 / 1:1 */
function applyPlayerAspect(input) {
  let a = '9:16';
  if (input && typeof input === 'object' && input.width && input.height) {
    const r = input.width / input.height;
    a = Math.abs(r - 9 / 16) < 0.14 ? '9:16' : Math.abs(r - 16 / 9) < 0.14 ? '16:9' : Math.abs(r - 1) < 0.14 ? '1:1' : '9:16';
  } else if (typeof input === 'string' && input.includes(':')) {
    a = input;
  }
  const wrap = $('playerWrap');
  wrap.style.aspectRatio = a.replace(':', ' / ');
  wrap.style.width = a === '16:9' ? '100%' : a === '1:1' ? '440px' : '320px';
  wrap.style.margin = a === '16:9' ? '0' : '0 auto';
  state.playerAspect = a;
}

function showFinal(url, thumb, outPath, meta) {
  const base = String(url || '').replace(/final\.mp4.*$/, '');   // 供单镜回放拼 URL
  state.playBase = base || null;
  applyPlayerAspect(meta && meta.width ? meta : state.spec.aspect);
  $('playerWrap').innerHTML = `<video controls playsinline preload="auto"
      ${thumb ? `poster="${thumb}"` : ''} src="${url}"></video>
    <button class="play-overlay" id="playOverlay" title="播放（有声）">▶</button>`;
  const video = $('playerWrap').querySelector('video');
  const overlay = $('playOverlay');
  const setPlaying = (on) => $('playerWrap').classList.toggle('playing', on);
  video.addEventListener('play', () => setPlaying(true));
  video.addEventListener('pause', () => setPlaying(false));
  video.addEventListener('ended', () => setPlaying(false));
  video.addEventListener('error', () => {
    setPlaying(false);
    $('finalHint').textContent = '这条任务的成片文件读不到（未导出或已删除）';
    toast('播放失败：成片文件不存在（可能是演练任务或已被清理）', 'error');
  });
  overlay.addEventListener('click', () => { video.muted = false; video.play().catch(() => {}); });
  video.play().catch(() => {});   // 浏览器可能拦自动播放，那就等用户点 ▶
  $('finalHint').textContent = meta ? `${meta.width}×${meta.height} · ${Number(meta.duration || 0).toFixed(2)}s` : '成片已就绪 · 点 ▶ 播放（有声）';
  if (outPath) {
    $('outPath').textContent = outPath;
    $('btnOpenOut').classList.remove('hidden');
    $('btnOpenOut').onclick = () => api('/api/reveal', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: outPath }),
    }).catch((e) => toast(e.message, 'error'));
  }
}

// ── 日志 ──────────────────────────────────────────────────────
function addLog(entry) {
  state.logs.push(entry);
  if (state.logs.length > 4000) state.logs.splice(0, 1000);
  const body = $('logBody');
  if (body.querySelector('.log-empty')) body.innerHTML = '';
  if (entry.level === 'raw' && !state.showRaw) { /* 仍入内存，不渲染 */ }
  else {
    const row = document.createElement('div');
    const t = new Date(entry.at);
    const p = (n) => String(n).padStart(2, '0');
    row.className = `log-row ${entry.level || 'info'}${entry.raw ? ' raw' : ''}`;
    row.innerHTML = `<span class="t">${p(t.getHours())}:${p(t.getMinutes())}:${p(t.getSeconds())}</span>
      <span class="s">${esc(entry.stage || '')}</span><span class="m">${esc(entry.text)}</span>`;
    body.appendChild(row);
    while (body.childElementCount > 1500) body.removeChild(body.firstChild);
  }
  $('logCount').textContent = `${state.logs.length} 行`;
  if (state.autoScroll) body.scrollTop = body.scrollHeight;
}

// ── 事件流 ────────────────────────────────────────────────────
function applyJobUpdate(s) {
  if (!s) return;
  state.job = s;
  $('jobTag').textContent = s.status === 'running' ? (s.stageName || '进行中')
    : s.status === 'awaiting_confirmation' ? '等待确认'
      : s.status === 'done' ? '已完成' : s.status === 'failed' ? '失败' : s.status === 'queued' ? '排队中' : s.status;
  if (Array.isArray(s.shots) && s.shots.length) renderShots(s.shots);
  if (s.estimate) $('pillCost').innerHTML = `花费 <b>≈¥${s.estimate.yuan}</b>`;
  if (s.brainUsage) $('pillToken').innerHTML = `token <b>${(s.brainUsage.prompt + s.brainUsage.completion).toLocaleString()}</b>`;
  if (s.stages && state.cfg) {
    const ui = ['prepare', 'breakdown', 'analyze', 'storyboard', 'render', 'plan', 'generate', 'compose', 'export'];
    const runningKey = Object.keys(s.stages).find((k) => s.stages[k] === 'running');
    const lastDone = Object.keys(s.stages).filter((k) => s.stages[k] === 'done').pop();
    const key = runningKey || (s.status === 'done' ? 'export' : lastDone);
    const i = Math.max(0, ui.indexOf(key));
    const uiMap = { prepare: 0, breakdown: 0, analyze: 0, storyboard: 1, render: 1, plan: 2, generate: 2, compose: 3, export: 4 };
    renderSteps(uiMap[key] ?? 0, s.stages);
    if (s.status === 'done') renderSteps(5, s.stages);
    setCoreFlow(key, s.status);
  }
  if (typeof s.progress === 'number') setProgress(s.progress, s.stageName, s.status === 'running');
  if (s.status === 'failed') showError(s.error);
  else if (s.status === 'done' || s.status === 'running' || s.status === 'awaiting_confirmation') showError(null);
  armResume(s);
}

function connectSSE() {
  if (state.es) state.es.close();
  const es = new EventSource('/api/events');
  state.es = es;
  es.onmessage = (ev) => {
    let msg = null;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (!msg || !msg.type) return;
    if (state.batchId && msg.type !== 'batch-ready' && msg.type !== 'batch-done') {
      if (msg.type === 'job-error') toast('有一条对标视频分析失败，其余方案会继续完成', 'error');
      if (msg.type === 'job-queued' || msg.type === 'job-done') refreshHistory();
      return;
    }
    if (state.jobId && msg.jobId && msg.jobId !== state.jobId) {
      if (msg.type === 'job-queued' || msg.type === 'job-done') refreshHistory();
      return;
    }
    switch (msg.type) {
      case 'log': addLog(msg.payload); break;
      case 'progress': setProgress(msg.payload.progress, msg.payload.stageName, true); setCoreFlow(msg.payload.stage, 'running'); break;
      case 'job-start':
      case 'job-update': applyJobUpdate(msg.payload); break;
      case 'job-queued': refreshHistory(); break;
      case 'ref-meta':
        $('pillRef').innerHTML = `对标 <b>${state.ref?.name || ''} ${msg.payload.width}×${msg.payload.height} · ${Number(msg.payload.duration).toFixed(1)}s</b>`;
        break;
      case 'shots-plan':
        renderShots(msg.payload.map((s) => ({ index: s.序号, status: 'scripted', duration: s.时长 })));
        break;
      case 'shot': {
        const cur = state.job?.shots || [];
        const hit = cur.find((s) => s.index === msg.payload.index);
        if (hit) { Object.assign(hit, msg.payload); renderShots(cur); }
        break;
      }
      case 'estimate': $('pillCost').innerHTML = `花费 <b>≈¥${msg.payload.yuan}</b>`; break;
      case 'report': $('reportBody').textContent = msg.payload.markdown || ''; break;
      case 'final':
        showFinal(msg.payload.previewUrl, msg.payload.thumb, msg.payload.outputPath, msg.payload.meta);
        $('btnGenerate').disabled = false; $('btnGenerate').classList.remove('running');
        $('btnSub').textContent = '全自动：拆解 → 分镜 → 生成 → 合成 → 导出';
        $('btnCancel').classList.add('hidden');
        toast('成片已完成：' + msg.payload.outputPath, 'ok');
        refreshHistory();
        break;
      case 'job-done':
        applyJobUpdate(msg.payload);
        setProgress(100, '全部完成', false);
        $('btnGenerate').disabled = false; $('btnGenerate').classList.remove('running');
        $('btnSub').textContent = '全自动：拆解 → 分镜 → 生成 → 合成 → 导出';
        $('btnCancel').classList.add('hidden');
        loadReport(state.jobId);
        refreshHistory();
        break;
      case 'review-ready': {
        const summary = msg.payload?.review ? msg.payload : state.job;
        applyJobUpdate(summary);
        setProgress(44, '方案已就绪，等待确认', false);
        $('btnGenerate').disabled = false; $('btnGenerate').classList.remove('running');
        $('btnSub').textContent = '可修改方案；确认后才会产生出片费用';
        $('btnCancel').classList.add('hidden');
        openReview(summary.review, summary.estimate);
        loadReport(state.jobId);
        refreshHistory();
        break;
      }
      case 'batch-ready':
        setProgress(44, '批量方案已就绪，等待选择', false);
        $('btnGenerate').disabled = false; $('btnGenerate').classList.remove('running');
        $('btnSub').textContent = '选择要生成的方案；未选中不会花费';
        $('btnCancel').classList.add('hidden');
        openBatchReview(msg.payload);
        refreshHistory();
        break;
      case 'batch-done':
        setProgress(100, '批量任务已完成', false);
        $('btnGenerate').disabled = false; $('btnGenerate').classList.remove('running');
        $('btnSub').textContent = $('autoMode').checked ? '拆解 → 方案 → 自愈 → 成片，全程自动完成' : '先分析对标视频，确认后才会产生出片费用';
        $('btnCancel').classList.add('hidden');
        toast('批量任务已结束，可在历史任务中查看每条成片', 'ok');
        refreshHistory();
        break;
      case 'job-error':
        applyJobUpdate(msg.payload.summary);
        showError(msg.payload.error);
        toast('任务失败：' + humanError(msg.payload.error).title, 'error');
        $('btnGenerate').disabled = false; $('btnGenerate').classList.remove('running');
        $('btnCancel').classList.add('hidden');
        refreshHistory();
        break;
    }
  };
  es.onerror = () => { /* EventSource 会自动重连 */ };
}

async function loadReport(jobId) {
  try {
    const r = await api(`/api/jobs/${jobId}/report`);
    if (r.markdown) $('reportBody').textContent = r.markdown;
    if (r.storyboard) $('storyBody').textContent = r.storyboard;
  } catch { /* 忽略 */ }
}

// ── 生成 ──────────────────────────────────────────────────────
async function startJob() {
  const btn = $('btnGenerate');
  const learn = readLearn();
  learn.realLogo = !!state.logo;
  const rawRefUrls = $('douyinLinks').value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const refUrls = readRefUrls();
  const automatic = $('autoMode').checked;
  const max = automatic ? 10 : 3;
  if (!state.refs.length && !refUrls.length) return toast('先上传对标视频，或填写抖音视频链接', 'error');
  if (rawRefUrls.length > max) return toast(`当前模式抖音链接最多填写 ${max} 条`, 'error');
  if (!$('productName').value.trim()) return toast('先填产品名称', 'error');
  if (!state.products.length) return toast('至少上传 1 张产品参考图', 'error');
  btn.disabled = true;
  btn.classList.add('running');
  showError(null);
  armResume({ status: 'running' });
  const est = estimate();
  $('btnSub').textContent = '正在提交免费拆解任务…';
  try {
    const r = await api('/api/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        productName: $('productName').value.trim(),
        learn,
        spec: readSpec(),
        refVideo: state.refs[0]?.path || '',
        refVideos: state.refs.map((ref) => ref.path),
        refUrls: state.refs.length ? [] : refUrls,
        automatic,
        productImages: state.products.map((p) => p.path),
        logo: state.logo?.path || '',
      }),
    });
    state.jobId = r.id || null;
    state.batchId = r.batchId || null;
    state.logs = [];
    $('logBody').innerHTML = '';
    $('reportBody').textContent = '拆解中…';
    $('storyBody').textContent = '分镜生成中…';
    $('shotGrid').innerHTML = '<div class="empty-hint" style="grid-column:1/-1">等待拆解完成…</div>';
    $('playerWrap').innerHTML = '<div class="player-empty"><div class="big">▶</div><div>成片导出后在这里直接播放</div></div>';
    $('btnCancel').classList.remove('hidden');
    $('jobTag').textContent = '排队中';
    setProgress(0, '排队中', true);
    renderSteps(0, { prepare: 'running' });
    const sourceCount = state.refs.length || refUrls.length;
    $('btnSub').textContent = automatic ? `正在全自动生产 ${sourceCount} 条成片…` : (state.batchId ? `正在独立拆解 ${sourceCount} 条对标视频…` : '免费拆解中：完成后将自动打开确认页');
    toast(automatic ? '全自动批量任务已启动：每条将独立完成拆解、生成与导出' : (state.batchId ? '批量免费分析已启动，全部完成后统一确认' : '免费分析已启动，确认前不会产生视频生成费用'));
    save();
    refreshHistory();
  } catch (e) {
    toast('提交失败：' + e.message, 'error');
    btn.disabled = false;
    btn.classList.remove('running');
    $('btnSub').textContent = '全自动：拆解 → 分镜 → 生成 → 合成 → 导出';
  }
}

// ── 续跑：接上次进度继续（复用已完成的阶段与已出片的镜，不重复花钱）──
async function resumeJob() {
  if (!state.resumeTarget) return toast('没有可续跑的上次任务', 'error');
  const btn = $('btnResume');
  btn.disabled = true;
  try {
    const r = await api(`/api/jobs/${state.resumeTarget}/resume`, { method: 'POST' });
    state.jobId = r.id;
    state.logs = [];
    $('logBody').innerHTML = '';
    $('reportBody').textContent = '（续跑：复用上次拆解报告）';
    $('shotGrid').innerHTML = '<div class="empty-hint" style="grid-column:1/-1">续跑中，等待接手上次的产物…</div>';
    $('btnCancel').classList.remove('hidden');
    showError(null);
    setProgress(0, '续跑排队中', true);
    renderSteps(2, { plan: 'running' });
    $('btnSub').textContent = '续跑中（复用上次产物，已出片的镜不重复花钱）';
    toast(`续跑已启动：复用${(r.inheritStages || []).length} 个已完成阶段`, 'ok');
    state.resumeTarget = null;
    refreshHistory();
  } catch (e) {
    toast('续跑失败：' + e.message, 'error');
    btn.disabled = false;
  }
}

// ── 历史 ──────────────────────────────────────────────────────
async function refreshHistory() {
  try {
    const r = await api('/api/jobs');
    const list = r.jobs || [];   // 后端已按「最新在前」返回，别再反转
    $('histCount').textContent = `${list.length} 条`;
    if (!list.length) { $('historyList').innerHTML = '<div class="empty-hint">还没有历史任务</div>'; return; }
    const grouped = new Map();
    list.forEach((job) => { if (job.batchId) grouped.set(job.batchId, [...(grouped.get(job.batchId) || []), job]); });
    const renderedBatches = new Set();
    $('historyList').innerHTML = list.map((j) => {
      if (j.batchId) {
        if (renderedBatches.has(j.batchId)) return '';
        renderedBatches.add(j.batchId);
        const members = grouped.get(j.batchId) || [];
        const waiting = members.filter((item) => item.status === 'awaiting_confirmation').length;
        const complete = members.filter((item) => item.status === 'done').length;
        const running = members.filter((item) => ['queued', 'running'].includes(item.status)).length;
        const estimate = members.filter((item) => item.status === 'awaiting_confirmation').reduce((sum, item) => sum + Number(item.estimate?.yuan || 0), 0);
        const statuses = members.map((item) => `<span class="status-chip ${esc(item.status)}">${esc(item.status)}</span>`).join('');
        return `<div class="card batch-history-card">
          <div class="batch-history-top"><div><span class="batch-kicker">${j.automatic ? '全自动批量生产' : '批量对标'}</span><b>${esc(j.productName || '未命名产品')} · ${members.length} 条独立方案</b><span class="small">${fmtTime(j.createdAt)}</span></div><div class="batch-statuses">${statuses}</div></div>
          <div class="batch-history-meta"><span>待确认 <b>${waiting}</b></span><span>生成中 <b>${running}</b></span><span>已交付 <b>${complete}</b></span><span>待确认预计 <b>${estimate ? `¥${estimate.toFixed(2)}` : '—'}</b></span></div>
          <div class="hist-actions">${waiting ? `<button class="btn-ghost on" data-act="batch-review" data-batch="${esc(j.batchId)}">管理批量方案</button>` : ''}</div>
        </div>`;
      }
      const spec = j.spec || {};
      const dur = j.finalMeta ? `${Number(j.finalMeta.duration).toFixed(2)}s` : '—';
      const elapsed = j.startedAt && j.finishedAt
        ? `${Math.round((new Date(j.finishedAt) - new Date(j.startedAt)) / 1000)}s` : '—';
      const est = j.estimate ? `≈¥${j.estimate.yuan}` : '—';
      const learn = j.learn ? Object.keys(j.learn).filter((k) => j.learn[k]).length : 0;
      const thumb = j.finalThumb ? `<img src="${j.finalThumb}?t=${Date.now()}" alt="">` : esc(j.status);
      const playable = j.previewUrl || '';   // 只有真导出过成片的任务才给「回放」
      return `<div class="card hist-card" style="padding:14px 16px">
        <div class="hist-thumb">${thumb}</div>
        <div>
          <div class="row" style="margin-bottom:9px;gap:10px;flex-wrap:wrap">
            <b style="font-size:15px">${esc(j.productName || '未命名')}</b>
            <span class="status-chip ${esc(j.status)}">${esc(j.status)}</span>
            ${j.cacheHit ? '<span class="meta-pill">已复用拆解报告</span>' : ''}
            <span class="small">${fmtTime(j.createdAt)}</span>
          </div>
          <div class="hist-meta">
            <div>规格<b>${spec.shots || '?'} 镜 × ${spec.shotDuration || '?'}s · ${esc(spec.aspect || '')} · ${esc(spec.resolution || '')} · ${esc(spec.model || '')}</b></div>
            <div>学习项<b>${learn} 项已勾选</b></div>
            <div>预计花费<b>${est}</b></div>
            <div>成片时长<b>${dur}</b></div>
            <div>耗时<b>${elapsed}</b></div>
            <div>成片路径<b>${esc(j.outputPath || '—')}</b></div>
          </div>
        </div>
        <div class="hist-actions">
          ${playable ? `<button class="btn-ghost" data-act="play" data-id="${j.id}" data-url="${playable}">回放</button>` : ''}
          ${j.status === 'awaiting_confirmation' ? `<button class="btn-ghost on" data-act="review" data-id="${j.id}">查看方案</button>` : ''}
          <button class="btn-ghost" data-act="logs" data-id="${j.id}">日志</button>
          ${(j.status === 'failed' || (j.status === 'done' && !j.previewUrl)) ? `<button class="btn-ghost" data-act="resume" data-id="${j.id}">续跑</button>` : ''}
          <button class="btn-ghost" data-act="rerun" data-id="${j.id}">一键重生</button>
        </div>
      </div>`;
    }).join('');
    $('historyList').querySelectorAll('button[data-act]').forEach((b) => {
      b.addEventListener('click', async () => {
        const id = b.dataset.id;
        if (b.dataset.act === 'batch-review') {
          try {
            const r = await api(`/api/batches/${b.dataset.batch}`);
            state.batchId = r.batch.id;
            openBatchReview(r.batch);
            document.querySelector('.tab[data-pane="prod"]').click();
          } catch (e) { toast(e.message, 'error'); }
        } else if (b.dataset.act === 'play') {
          document.querySelector('.tab[data-pane="prod"]').click();
          showFinal(b.dataset.url, null, null, null);
          $('finalHint').textContent = '历史成片回放 · 点 ▶ 播放（有声）';
          // 把这条任务的镜次缩略图也铺出来，点缩略图可单镜回放
          const rec = list.find((x) => x.id === id);
          if (rec?.shots?.length) renderShots(rec.shots);
        } else if (b.dataset.act === 'review') {
          try {
            const r = await api(`/api/jobs/${id}`);
            state.jobId = id;
            applyJobUpdate(r.job);
            openReview(r.job.review, r.job.estimate);
            document.querySelector('.tab[data-pane="prod"]').click();
          } catch (e) { toast(e.message, 'error'); }
        } else if (b.dataset.act === 'logs') {
          try {
            const r = await api(`/api/jobs/${id}/logs`);
            state.logs = [];
            $('logBody').innerHTML = '';
            r.logs.forEach(addLog);
            toast(`已载入 ${r.logs.length} 行日志`);
          } catch (e) { toast(e.message, 'error'); }
        } else if (b.dataset.act === 'resume') {
          state.resumeTarget = id;
          resumeJob();
        } else {
          try {
            const r = await api(`/api/jobs/${id}/rerun`, { method: 'POST' });
            state.jobId = r.id;
            state.logs = [];
            $('logBody').innerHTML = '';
            $('btnCancel').classList.remove('hidden');
            document.querySelector('.tab[data-pane="prod"]').click();
            toast('已重新排队，任务 ID ' + r.id, 'ok');
            refreshHistory();
          } catch (e) { toast(e.message, 'error'); }
        }
      });
    });
  } catch (e) { /* 忽略 */ }
}

// ── 初始化 ────────────────────────────────────────────────────
async function init() {
  renderSteps(0, null);
  setProgress(0, '待命', false);
  setCoreFlow('', 'idle');
  try {
    state.cfg = await api('/api/bootstrap');
  } catch (e) { toast('无法连接后端：' + e.message, 'error'); return; }
  renderBadges();
  fillSelect($('specModel'), Object.entries(MODEL_TABLE).map(([v, m]) => ({ value: v, label: m.label })));
  fillSelect($('specAspect'), state.cfg.aspects || ['9:16', '16:9', '1:1']);
  $('specModel').addEventListener('change', () => { refreshModelOptions(); save(); });

  const saved = load();
  const d = state.cfg.defaults || {};
  $('productName').value = saved?.productName || d.productName || '';
  (d.spec?.model) && ($('specModel').value = saved?.spec?.model || d.spec.model);
  refreshModelOptions();
  const spec = { ...(d.spec || {}), ...(saved?.spec || {}) };
  if (spec.resolution && [...$('specRes').options].some((o) => o.value === spec.resolution)) $('specRes').value = spec.resolution;
  if (spec.aspect) $('specAspect').value = spec.aspect;
  $('specShots').value = spec.shots ?? 1;
  $('specDur').value = spec.shotDuration ?? 15;
  $('audioSwitch').classList.toggle('on', spec.audio !== false);

  const learn = { ...(d.learn || {}), ...(saved?.learn || {}) };
  document.querySelectorAll('#learnSwitches .switch-row').forEach((row) => {
    row.classList.toggle('on', !!learn[row.dataset.key]);
    row.addEventListener('click', () => { row.classList.toggle('on'); save(); });
  });
  $('audioSwitch').addEventListener('click', () => { $('audioSwitch').classList.toggle('on'); updateSpecPills(); save(); });

  // 恢复上次的素材
  $('autoMode').checked = !!saved?.automatic;
  state.refs = (saved?.refs?.length ? saved.refs : (saved?.ref?.path ? [saved.ref] : [])).slice(0, $('autoMode').checked ? 10 : 3);
  state.ref = state.refs[0] || null;
  if (state.refs.length) renderRefs();
  state.refUrls = Array.isArray(saved?.refUrls) ? saved.refUrls.slice(0, $('autoMode').checked ? 10 : 3) : [];
  $('douyinLinks').value = state.refUrls.join('\n');
  $('douyinLinks').addEventListener('input', save);
  $('autoMode').addEventListener('change', syncAutomaticMode);
  syncAutomaticMode();
  if (saved?.products?.length) { state.products = saved.products; renderProducts(); }
  if (saved?.logo?.path) {
    state.logo = saved.logo;
    $('dropLogo').classList.add('has-file');
    $('logoFile').textContent = `✓ ${saved.logo.name} · ${saved.logo.sizeText || ''}`;
  }

  // 上传区
  wireDrop('dropRef', 'refInput', 'refBar', handleRefFiles);
  wireDrop('dropProd', 'prodInput', 'prodBar', (files) => handleProdFiles(files.filter((f) => f.type.startsWith('image/'))));
  wireDrop('dropLogo', 'logoInput', 'logoBar', handleLogoFiles);

  // 参数联动
  ['specRes', 'specAspect', 'specShots', 'specDur'].forEach((id) => {
    const onChange = () => {
      updateSpecPills();
      if (id === 'specAspect') applyPlayerAspect($(id).value);   // 预览框跟着画幅走
      save();
    };
    $(id).addEventListener('input', onChange);
    $(id).addEventListener('change', onChange);
  });
  applyPlayerAspect($('specAspect').value || '9:16');
  updateSpecPills();

  // 按钮
  $('btnGenerate').addEventListener('click', startJob);
  $('btnCloseReview').addEventListener('click', closeReview);
  $('btnConfirmReview').addEventListener('click', confirmReview);
  $('btnCloseBatch').addEventListener('click', () => $('batchModal').classList.add('hidden'));
  $('btnConfirmBatch').addEventListener('click', confirmBatchReview);
  $('btnResume').addEventListener('click', resumeJob);
  $('btnCancel').addEventListener('click', async () => {
    if (!state.jobId) return;
    try { await api(`/api/jobs/${state.jobId}/cancel`, { method: 'POST' }); toast('已请求取消'); } catch (e) { toast(e.message, 'error'); }
  });
  $('btnRaw').addEventListener('click', (e) => {
    state.showRaw = !state.showRaw;
    e.target.classList.toggle('on', state.showRaw);
    $('logBody').classList.toggle('hide-raw', !state.showRaw);
    e.target.textContent = state.showRaw ? '显示原始输出' : '已隐藏原始输出';
  });
  $('btnAuto').addEventListener('click', (e) => {
    state.autoScroll = !state.autoScroll;
    e.target.classList.toggle('on', state.autoScroll);
    e.target.textContent = state.autoScroll ? '自动滚动' : '自动滚动已关';
  });
  $('btnClearLog').addEventListener('click', () => {
    state.logs = []; $('logBody').innerHTML = '<div class="log-empty">日志已清空</div>'; $('logCount').textContent = '0 行';
  });
  $('btnCopyLog').addEventListener('click', async () => {
    const text = state.logs.map((l) => `[${fmtTime(l.at)}] [${l.stage}] ${l.text}`).join('\n');
    try { await navigator.clipboard.writeText(text); toast(`已复制 ${state.logs.length} 行日志`, 'ok'); }
    catch { toast('复制失败，浏览器拒绝剪贴板权限', 'error'); }
  });
  $('btnDlLog').addEventListener('click', () => {
    const text = state.logs.map((l) => `[${fmtTime(l.at)}] [${l.stage}]${l.raw ? '[原始]' : ''} ${l.text}`).join('\n');
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url; a.download = `日志_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.txt`;
    a.click(); URL.revokeObjectURL(url);
  });

  // 标签页
  document.querySelectorAll('.tab').forEach((t) => {
    t.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'));
      document.querySelectorAll('.pane').forEach((x) => x.classList.remove('active'));
      t.classList.add('active');
      $('pane-' + t.dataset.pane).classList.add('active');
      if (t.dataset.pane === 'hist') refreshHistory();
    });
  });

  // 报告按需拉取
  $('reportFold').addEventListener('toggle', () => { if ($('reportFold').open && state.jobId) loadReport(state.jobId); });

  connectSSE();
  refreshHistory();
  // 支持从历史任务直接恢复确认页，刷新页面也不会丢掉待确认方案。
  const reviewId = new URLSearchParams(location.search).get('review');
  if (reviewId) {
    try {
      const r = await api(`/api/jobs/${reviewId}`);
      if (r.job?.status === 'awaiting_confirmation' && r.job.review) {
        state.jobId = reviewId;
        applyJobUpdate(r.job);
        openReview(r.job.review, r.job.estimate);
      }
    } catch { /* 无效历史链接无需打断主界面 */ }
  }
  const batchId = new URLSearchParams(location.search).get('batch');
  if (batchId) {
    try {
      const r = await api(`/api/batches/${batchId}`);
      if (r.batch?.status === 'awaiting_confirmation') openBatchReview(r.batch);
    } catch { /* 无效批量链接无需打断主界面 */ }
  }
  // 若有任务在跑，恢复显示
  if (state.cfg.running) { state.jobId = state.cfg.running; $('btnCancel').classList.remove('hidden'); toast('检测到有任务在运行，已接上实时进度'); }
}

init();
