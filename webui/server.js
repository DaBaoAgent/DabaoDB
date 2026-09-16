'use strict';
/**
 * 爱优护对标视频全自动生产工厂 — WebUI 后端
 *
 * 零 npm 依赖：只用 Node 内置模块（http / fs / child_process / fetch）。
 * 启动：node server.js [--port 8899] [--no-open] [--dry-stages=prepare,breakdown]
 */
const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { runJob, STAGES, UI_STEPS, MODEL_TABLE } = require('./lib/pipeline');
const { ensureDir, readHermesEnv, exists, safeName, fmtSize, nowIso } = require('./lib/util');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');

// ── 参数 / 配置 ────────────────────────────────────────────────
const argv = process.argv.slice(2);
const argVal = (name) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : '';
};
const CONFIG_FILE = path.join(ROOT, 'config.json');
if (!exists(CONFIG_FILE)) {
  console.error('缺少 webui/config.json（可从 config.example.json 复制）');
  process.exit(1);
}
const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
// 媒体工具优先使用项目配置，避免双击启动时受系统 PATH 影响。
if (config.paths?.ffmpeg || config.paths?.ffprobe) {
  const mediaDirs = [config.paths.ffmpeg, config.paths.ffprobe]
    .filter(Boolean).map((p) => path.dirname(p)).filter(exists);
  if (mediaDirs.length) process.env.PATH = `${mediaDirs.join(path.delimiter)}${path.delimiter}${process.env.PATH || ''}`;
}

// Key 兜底：config.json 没填就回落到 hermes 的 .env（Key 只留后端）
if (!config.deepseek?.apiKey) {
  const env = readHermesEnv();
  if (env.DEEPSEEK_API_KEY) {
    config.deepseek = config.deepseek || {};
    config.deepseek.apiKey = env.DEEPSEEK_API_KEY;
    console.log('[配置] DeepSeek Key 取自 hermes/.env');
  }
}
config.deepseek = { baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', ...(config.deepseek || {}) };
const PORT = Number(argVal('port') || config.port || 8899);
const OPEN_BROWSER = !argv.includes('--no-open');
const dryStages = (argVal('dry-stages') || '').split(',').map((s) => s.trim()).filter(Boolean);
if (dryStages.length) config.dryStages = dryStages;

const DATA_DIR = path.join(ROOT, 'data');
config.paths = config.paths || {};
config.paths.dataDir = DATA_DIR;
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const JOBS_DIR = path.join(DATA_DIR, 'jobs');
const JOBS_INDEX = path.join(DATA_DIR, 'jobs.json');
const BATCHES_INDEX = path.join(DATA_DIR, 'batches.json');
const ANALYSIS_CACHE_INDEX = path.join(DATA_DIR, 'analysis-cache.json');

// ── 任务状态 ──────────────────────────────────────────────────
/** @type {Map<string, any>} */
const jobs = new Map();
const batches = new Map();
const analysisCache = new Map();
const queue = [];
let running = null;
let currentChild = null;
const sseClients = new Set();

function validDouyinUrl(value) {
  try {
    const u = new URL(String(value || '').trim());
    return /^https?:$/.test(u.protocol) && /(^|\.)(douyin|iesdouyin)\.com$/i.test(u.hostname);
  } catch { return false; }
}

function hashFile(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const input = fs.createReadStream(file);
    input.on('data', (chunk) => h.update(chunk));
    input.on('error', reject);
    input.on('end', () => resolve(h.digest('hex')));
  });
}

async function sourceKeyFor(ref) {
  if (ref.refVideo) return `file:${await hashFile(ref.refVideo)}`;
  const u = new URL(ref.refUrl);
  // 同一个链接不因复制时带上的追踪参数而重复拆解。
  [...u.searchParams.keys()].filter((k) => /^utm_|^share_|^previous_page$/i.test(k)).forEach((k) => u.searchParams.delete(k));
  u.hash = '';
  return `url:${crypto.createHash('sha256').update(u.toString()).digest('hex')}`;
}

function reusableAnalysis(job) {
  return !!(job && job.report && job.stages?.prepare === 'done' && job.stages?.breakdown === 'done'
    && job.stages?.analyze === 'done');
}

function cacheAnalysis(job) {
  if (job.sourceKey && reusableAnalysis(job)) analysisCache.set(job.sourceKey, job.id);
}

function broadcast(type, payload, jobId) {
  const frame = `data: ${JSON.stringify({ type, payload, jobId, at: nowIso() })}\n\n`;
  for (const res of sseClients) {
    try { res.write(frame); } catch { sseClients.delete(res); }
  }
}

function jobSummary(job) {
  return {
    id: job.id,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    status: job.status,
    batchId: job.batchId || null,
    automatic: !!job.automatic,
    cacheHit: !!job.cacheHit,
    sourceKey: job.sourceKey,
    productName: job.params?.productName,
    spec: job.params?.spec,
    learn: job.params?.learn,
    pathId: job.pathId,
    stages: job.stages,
    progress: job.progress,
    stageName: job.stageName,
    outputPath: job.outputPath,
    deliveryDir: job.deliveryDir,
    coverPath: job.coverPath,
    publishCopyPath: job.publishCopyPath,
    previewUrl: job.previewUrl,
    finalThumb: job.finalThumb,
    finalMeta: job.finalMeta,
    estimate: job.estimate,
    review: job.review,
    awaitingConfirmation: !!job.awaitingConfirmation,
    brainUsage: job.brainUsage,
    shots: (job.shots || []).map((s) => ({ index: s.index, status: s.status, thumb: s.thumb, duration: s.duration })),
    error: job.error,
    resumeFrom: job.resumeFrom,
    inheritStages: job.inheritStages,
    logCount: (job.logs || []).length,
  };
}

function batchSummary(batch) {
  return {
    id: batch.id,
    createdAt: batch.createdAt,
    productName: batch.productName,
    status: batch.status,
    automatic: !!batch.automatic,
    jobs: batch.jobIds.map((id) => jobSummary(jobs.get(id))).filter(Boolean),
  };
}

function settleBatch(job) {
  if (!job.batchId) return;
  const batch = batches.get(job.batchId);
  if (!batch) return;
  const members = batch.jobIds.map((id) => jobs.get(id)).filter(Boolean);
  const ready = members.every((item) => ['awaiting_confirmation', 'failed', 'cancelled'].includes(item.status));
  if (ready && !batch.reviewReady) {
    batch.reviewReady = true;
    batch.status = 'awaiting_confirmation';
    broadcast('batch-ready', batchSummary(batch), batch.id);
  }
  const terminal = members.length && members.every((item) => ['done', 'failed', 'cancelled'].includes(item.status));
  if (terminal) {
    batch.status = members.some((item) => item.status === 'done') ? 'done' : 'failed';
    broadcast('batch-done', batchSummary(batch), batch.id);
  }
}

async function persistIndex() {
  const list = [...jobs.values()].map(jobSummary).slice(-200);
  await fsp.writeFile(JOBS_INDEX, JSON.stringify(list, null, 2), 'utf8');
  await fsp.writeFile(BATCHES_INDEX, JSON.stringify([...batches.values()].map(batchSummary).slice(-100), null, 2), 'utf8');
  await fsp.writeFile(ANALYSIS_CACHE_INDEX, JSON.stringify(Object.fromEntries(analysisCache), null, 2), 'utf8');
  for (const job of jobs.values()) {
    try {
      await fsp.writeFile(path.join(JOBS_DIR, job.id, 'job.json'),
        JSON.stringify({ ...jobSummary(job), params: job.params }, null, 2), 'utf8');
    } catch { /* 忽略 */ }
  }
}

async function startNext() {
  if (running || !queue.length) return;
  const job = queue.shift();
  running = job;
  job.status = 'running';
  broadcast('job-start', jobSummary(job), job.id);
  const emit = (type, payload) => {
    if (type === 'log') {
      broadcast('log', payload, job.id);
      return;
    }
    broadcast(type, payload, job.id);
    broadcast('job-update', jobSummary(job), job.id);
  };
  try {
    await runJob({
      job,
      config,
      emit,
      registerChild: (child) => { currentChild = child; },
    });
    cacheAnalysis(job);
    if (job.awaitingConfirmation) {
      job.status = 'awaiting_confirmation';
      job.finishedAt = new Date().toISOString();
      broadcast('review-ready', jobSummary(job), job.id);
    } else {
      job.status = 'done';
      broadcast('job-done', jobSummary(job), job.id);
    }
    settleBatch(job);
  } catch (err) {
    job.status = job.cancelRequested ? 'cancelled' : 'failed';
    job.error = String(err && err.message ? err.message : err);
    job.finishedAt = new Date().toISOString();
    const entry = { at: nowIso(), stage: job.stage, text: `✖ 任务失败：${job.error}`, level: 'error', raw: false };
    job.logs.push(entry);
    broadcast('log', entry, job.id);
    broadcast('job-error', { error: job.error, summary: jobSummary(job) }, job.id);
    settleBatch(job);
  } finally {
    currentChild = null;
    running = null;
    try { await fsp.writeFile(path.join(job.dir || JOBS_DIR, 'logs.txt'),
      job.logs.map((l) => `[${l.at}] [${l.stage}]${l.raw ? '[原始]' : ''} ${l.text}`).join('\n'), 'utf8'); } catch { /* 忽略 */ }
    await persistIndex();
    setTimeout(startNext, 200);
  }
}

function newJobId() {
  return 'job_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
}

// ── HTTP 工具 ─────────────────────────────────────────────────
function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}
function sendText(res, code, text, type = 'text/plain; charset=utf-8') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(text);
}
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.mp4': 'video/mp4', '.webm': 'video/webm', '.md': 'text/markdown; charset=utf-8',
  '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
};

/** 带 Range 的静态文件响应（视频拖动进度条必需） */
function serveFile(req, res, file) {
  if (!exists(file)) return sendText(res, 404, '404 Not Found');
  const stat = fs.statSync(file);
  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const range = req.headers.range;
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    if (m) {
      const start = m[1] ? parseInt(m[1], 10) : 0;
      const end = m[2] ? parseInt(m[2], 10) : stat.size - 1;
      if (start <= end && end < stat.size) {
        res.writeHead(206, {
          'Content-Type': type, 'Accept-Ranges': 'bytes',
          'Content-Range': `bytes ${start}-${end}/${stat.size}`,
          'Content-Length': end - start + 1,
        });
        fs.createReadStream(file, { start, end }).pipe(res);
        return;
      }
    }
  }
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': stat.size, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' });
  fs.createReadStream(file).pipe(res);
}

function readBody(req, limit = 5 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** 安全拼接 media 路径（禁止越界） */
function mediaPath(baseDir, rel) {
  const clean = decodeURIComponent(rel).replace(/^[\\/]+/, '');
  const full = path.resolve(baseDir, clean);
  if (!full.startsWith(path.resolve(baseDir))) return null;
  return full;
}

// ── 路由 ─────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;
  try {
    // 静态前端
    if (p === '/' || p === '/index.html') return serveFile(req, res, path.join(PUBLIC_DIR, 'index.html'));
    if (/^\/(app\.js|style\.css|favicon\.ico)$/.test(p)) return serveFile(req, res, path.join(PUBLIC_DIR, p.slice(1)));
    if (p.startsWith('/assets/')) return serveFile(req, res, path.join(PUBLIC_DIR, 'assets', mediaPath(PUBLIC_DIR, p) ? p.replace('/assets/', '') : 'logo.png'));

    // 已上传素材 / 任务产物
    if (p.startsWith('/media/upload/')) {
      const f = mediaPath(UPLOAD_DIR, p.replace('/media/upload/', ''));
      if (!f) return sendText(res, 400, 'bad path');
      return serveFile(req, res, f);
    }
    if (p.startsWith('/media/job/')) {
      const rest = p.replace('/media/job/', '');
      const slash = rest.indexOf('/');
      const jobId = rest.slice(0, slash);
      const rel = rest.slice(slash + 1);
      let f = mediaPath(path.join(JOBS_DIR, jobId), rel);
      if (!f) return sendText(res, 400, 'bad path');
      // 老任务兼容：单镜项目没写 out/final.mp4，用 out/shot/shot01.mp4 顶上
      if (!exists(f) && /(^|[\\/])final\.mp4$/.test(rel)) {
        const alt = mediaPath(path.join(JOBS_DIR, jobId), rel.replace(/final\.mp4$/, 'shot/shot01.mp4'));
        if (alt && exists(alt)) f = alt;
      }
      return serveFile(req, res, f);
    }
    if (p.startsWith('/media/out/')) {
      const f = mediaPath(config.paths.outDir, p.replace('/media/out/', ''));
      if (!f) return sendText(res, 400, 'bad path');
      return serveFile(req, res, f);
    }
    if (p === '/api/logo') {
      const logo = path.join(DATA_DIR, 'logo.png');
      if (exists(logo)) return serveFile(req, res, logo);
      if (config.paths.logoSource && exists(config.paths.logoSource)) return serveFile(req, res, config.paths.logoSource);
      return sendText(res, 404, 'no logo');
    }

    // 启动信息
    if (p === '/api/bootstrap') {
      return sendJson(res, 200, {
        title: config.title || '爱优护对标视频全自动生产工厂',
        defaults: config.defaults || {},
        models: Object.entries(MODEL_TABLE).map(([k, v]) => ({ value: k, label: v.label, res: v.res, rate: v.rate })),
        resolutions: ['480p', '720p', '1080p'],
        aspects: ['9:16', '16:9', '1:1'],
        steps: UI_STEPS,
        stages: STAGES.map((s) => ({ key: s.key, name: s.name })),
        paths: { project: config.paths.project, outDir: config.paths.outDir, hypitCli: config.paths.hypitCli },
        deepseek: { model: config.deepseek.model, keyConfigured: !!config.deepseek.apiKey },
        dryStages: config.dryStages || [],
        running: running ? running.id : null,
        queue: queue.map((j) => ({ id: j.id, productName: j.params?.productName })),
        history: [...jobs.values()].map(jobSummary).reverse().slice(0, 100),
      });
    }

    // 在资源管理器中定位文件（仅本机）
    if (p === '/api/reveal' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      const target = String(body.path || '');
      if (!target) return sendJson(res, 400, { error: '缺少 path' });
      const args = exists(target) ? ['/select,', path.normalize(target)] : [path.dirname(target)];
      const ch = spawn('explorer', args, { detached: true, stdio: 'ignore' });
      ch.on('error', () => {});
      ch.unref();
      return sendJson(res, 200, { ok: true });
    }

    // 上传（原始字节流，前端用 XHR 带进度）
    if (p === '/api/upload' && req.method === 'POST') {
      const kind = (url.searchParams.get('kind') || 'ref').replace(/[^\w-]/g, '') || 'ref';
      const name = safeName(url.searchParams.get('name') || `${kind}.bin`);
      const dir = await ensureDir(path.join(UPLOAD_DIR, kind));
      const dst = path.join(dir, `${Date.now().toString(36)}-${name}`);
      const maxBytes = Number(config.maxUploadMB || 300) * 1024 * 1024;
      let size = 0;
      const ws = fs.createWriteStream(dst);
      const failed = await new Promise((resolve) => {
        req.on('data', (c) => {
          size += c.length;
          if (size > maxBytes) { resolve(true); req.destroy(); return; }
          ws.write(c);
        });
        req.on('end', () => { ws.end(() => resolve(false)); });
        req.on('error', () => resolve(true));
      });
      if (failed) { ws.destroy(); try { fs.unlinkSync(dst); } catch {} return sendJson(res, 413, { error: `文件超过 ${config.maxUploadMB || 300}MB 上限` }); }
      await new Promise((r) => ws.on('close', r));
      return sendJson(res, 200, { path: dst, url: `/media/upload/${kind}/${path.basename(dst)}`, name, size, sizeText: fmtSize(size) });
    }

    // 启动任务
    if (p === '/api/start' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      const automatic = !!body.automatic;
      const maxSources = automatic ? 10 : 3;
      const params = {
        productName: String(body.productName || '').trim(),
        learn: {
          narration: !!body.learn?.narration,
          dialogue: !!body.learn?.dialogue,
          tone: !!body.learn?.tone,
          speed: !!body.learn?.speed,
          style: !!body.learn?.style,
          realLogo: !!body.learn?.realLogo,
        },
        spec: {
          model: ['mini', 'fast', '2', '2.5'].includes(body.spec?.model) ? body.spec.model : 'mini',
          resolution: '720p',
          aspect: '9:16',
          shots: 1,
          shotDuration: 15,
          audio: body.spec?.audio !== false,
        },
        refVideo: String(body.refVideo || ''),
        productImages: Array.isArray(body.productImages) ? body.productImages.slice(0, 9).map(String) : [],
        logo: body.logo ? String(body.logo) : '',
      };
      const refVideos = (Array.isArray(body.refVideos) ? body.refVideos : [params.refVideo])
        .map(String).filter(Boolean).slice(0, maxSources);
      const refUrls = (Array.isArray(body.refUrls) ? body.refUrls : [])
        .map((x) => String(x || '').trim()).filter(Boolean).slice(0, maxSources);
      // 已上传的视频优先；链接仅在没有本地视频时作为自动下载来源。
      const refs = refVideos.length
        ? refVideos.map((refVideo) => ({ refVideo, refUrl: '' }))
        : refUrls.map((refUrl) => ({ refVideo: '', refUrl }));
      const problems = [];
      if (!refs.length) problems.push('请上传对标视频，或填写抖音视频链接');
      for (const ref of refVideos) if (!exists(ref)) problems.push('有对标视频不存在，请重新上传');
      for (const ref of refUrls) if (!validDouyinUrl(ref)) problems.push('抖音链接格式不正确，请填写 v.douyin.com、douyin.com 或 iesdouyin.com 链接');
      if (!params.productName) problems.push('产品名称未填');
      if (problems.length) return sendJson(res, 400, { error: problems.join('；') });

      const batch = refs.length > 1 ? {
        id: `batch_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
        createdAt: nowIso(), productName: params.productName, status: automatic ? 'generating' : 'analyzing', jobIds: [], reviewReady: false, automatic,
      } : null;
      if (batch) batches.set(batch.id, batch);
      const created = [];
      for (const ref of refs) {
        const sourceKey = await sourceKeyFor(ref);
        const cached = jobs.get(analysisCache.get(sourceKey));
        const canReuse = reusableAnalysis(cached);
        const job = {
          id: newJobId(), createdAt: nowIso(), status: 'queued',
          params: { ...params, refVideo: ref.refVideo, refUrl: ref.refUrl }, logs: [], shots: [], stages: {}, progress: 0, stageFraction: 0,
          stageName: canReuse ? '复用已保存的拆解方案' : '排队中', stopAfterAnalysis: !automatic, batchId: batch?.id || null,
          automatic, sourceKey, cacheHit: canReuse,
          resumeFrom: canReuse ? cached.id : undefined,
          // 对标拆解只与源视频有关；分镜方案仍按这次的产品、卖点和图片重新生成。
          inheritStages: canReuse ? ['prepare', 'breakdown', 'analyze'] : [],
          configSnapshot: {
            model: params.spec.model, resolution: params.spec.resolution,
            aspect: params.spec.aspect, shots: params.spec.shots, shotDuration: params.spec.shotDuration,
            deepseek: config.deepseek.model,
          },
        };
        job.pathId = job.id;
        jobs.set(job.id, job);
        if (batch) batch.jobIds.push(job.id);
        await ensureDir(path.join(JOBS_DIR, job.id));
        queue.push(job);
        created.push(job);
        broadcast('job-queued', jobSummary(job), job.id);
      }
      await persistIndex();
      startNext();
      return sendJson(res, 200, batch
        ? { batchId: batch.id, ids: created.map((j) => j.id), queued: queue.length, status: batch.status }
        : { id: created[0].id, queued: queue.length, status: created[0].status });
    }

    // 批量确认：只为选中的对标方案创建付费续接任务，彼此完全独立。
    let batchConfirmMatch = /^\/api\/batches\/([\w-]+)\/confirm$/.exec(p);
    if (batchConfirmMatch && req.method === 'POST') {
      const batch = batches.get(batchConfirmMatch[1]);
      if (!batch) return sendJson(res, 404, { error: 'batch not found' });
      const body = JSON.parse(await readBody(req));
      const selected = Array.isArray(body.items) ? body.items.slice(0, 3) : [];
      if (!selected.length) return sendJson(res, 400, { error: '请至少选择一条方案' });
      const created = [];
      for (const item of selected) {
        const src = jobs.get(String(item.jobId || ''));
        if (!src || src.batchId !== batch.id || src.status !== 'awaiting_confirmation') continue;
        const review = item.review || {};
        const params = JSON.parse(JSON.stringify(src.params));
        params.reviewEdits = {
          targetAudience: String(review.targetAudience || ''),
          sellingPoints: Array.isArray(review.sellingPoints) ? review.sellingPoints.map(String).slice(0, 12) : [],
          bannedWords: String(review.bannedWords || ''), title: String(review.title || ''),
          tags: Array.isArray(review.tags) ? review.tags.map(String).slice(0, 12) : [],
        };
        const editedShots = Array.isArray(review.shots) ? review.shots.map((s, i) => ({
          序号: i + 1, 时长: 15, 提示词: String(s.提示词 || s.prompt || '').trim(),
        })).filter((s) => s.提示词) : [];
        const job = {
          id: newJobId(), createdAt: nowIso(), status: 'queued', params,
          logs: [], shots: [], stages: {}, progress: 0, stageFraction: 0, stageName: '排队中', stage: 'queued', batchId: batch.id,
          resumeFrom: src.id, inheritStages: ['prepare', 'breakdown', 'analyze', 'storyboard'],
          confirmedReview: { ...src.review, ...params.reviewEdits, shots: editedShots.length ? editedShots : src.shotsPlan },
        };
        jobs.set(job.id, job);
        batch.jobIds.push(job.id);
        src.status = 'confirmed';
        src.finishedAt = src.finishedAt || nowIso();
        await ensureDir(path.join(JOBS_DIR, job.id));
        queue.push(job); created.push(job);
        broadcast('job-queued', jobSummary(job), job.id);
      }
      if (!created.length) return sendJson(res, 409, { error: '所选方案已不可确认，请刷新后重试' });
      batch.status = 'generating';
      await persistIndex(); startNext();
      return sendJson(res, 200, { ids: created.map((j) => j.id), status: batch.status });
    }

    // 确认后才创建可付费的续接任务。编辑结果只写入这一次续接任务。
    let confirmMatch = /^\/api\/jobs\/([\w-]+)\/confirm$/.exec(p);
    if (confirmMatch && req.method === 'POST') {
      const src = jobs.get(confirmMatch[1]);
      if (!src) return sendJson(res, 404, { error: 'job not found' });
      if (src.status !== 'awaiting_confirmation') return sendJson(res, 409, { error: '该任务不在待确认状态' });
      const body = JSON.parse(await readBody(req));
      const review = body.review || {};
      const params = JSON.parse(JSON.stringify(src.params));
      params.productName = String(body.productName || params.productName).trim() || params.productName;
      params.reviewEdits = {
        targetAudience: String(review.targetAudience || ''),
        sellingPoints: Array.isArray(review.sellingPoints) ? review.sellingPoints.map(String).slice(0, 12) : [],
        bannedWords: String(review.bannedWords || ''),
        title: String(review.title || ''),
        tags: Array.isArray(review.tags) ? review.tags.map(String).slice(0, 12) : [],
      };
      const editedShots = Array.isArray(review.shots) ? review.shots.map((s, i) => ({
        序号: i + 1, 时长: 15, 提示词: String(s.提示词 || s.prompt || '').trim(),
      })).filter((s) => s.提示词) : [];
      const job = {
        id: newJobId(), createdAt: nowIso(), status: 'queued', params,
        logs: [], shots: [], stages: {}, progress: 0, stageFraction: 0,
        stageName: '排队中', stage: 'queued', resumeFrom: src.id,
        inheritStages: ['prepare', 'breakdown', 'analyze', 'storyboard'],
        confirmedReview: { ...src.review, ...params.reviewEdits, shots: editedShots.length ? editedShots : src.shotsPlan },
      };
      jobs.set(job.id, job);
      src.status = 'confirmed';
      src.finishedAt = src.finishedAt || nowIso();
      await ensureDir(path.join(JOBS_DIR, job.id));
      if (editedShots.length) {
        await fsp.writeFile(path.join(JOBS_DIR, job.id, '分镜提示词.json'), JSON.stringify(editedShots, null, 2), 'utf8');
      }
      queue.push(job);
      broadcast('job-queued', jobSummary(job), job.id);
      startNext();
      return sendJson(res, 200, { id: job.id, status: job.status });
    }

    // 任务列表 / 详情
    let batchMatch = /^\/api\/batches\/([\w-]+)$/.exec(p);
    if (batchMatch && req.method === 'GET') {
      const batch = batches.get(batchMatch[1]);
      if (!batch) return sendJson(res, 404, { error: 'batch not found' });
      return sendJson(res, 200, { batch: batchSummary(batch) });
    }
    if (p === '/api/jobs') {
      return sendJson(res, 200, { jobs: [...jobs.values()].map(jobSummary).reverse() });
    }
    let m = /^\/api\/jobs\/([\w-]+)$/.exec(p);
    if (m) {
      const job = jobs.get(m[1]);
      if (!job) return sendJson(res, 404, { error: 'job not found' });
      return sendJson(res, 200, { job: jobSummary(job), logs: job.logs.slice(-500) });
    }
    m = /^\/api\/jobs\/([\w-]+)\/logs$/.exec(p);
    if (m) {
      const job = jobs.get(m[1]);
      if (!job) return sendJson(res, 404, { error: 'job not found' });
      return sendJson(res, 200, { logs: job.logs });
    }
    m = /^\/api\/jobs\/([\w-]+)\/report$/.exec(p);
    if (m) {
      const job = jobs.get(m[1]);
      if (!job) return sendJson(res, 404, { error: 'job not found' });
      const f = path.join(JOBS_DIR, job.id, '拆解报告.md');
      const md = exists(f) ? await fsp.readFile(f, 'utf8') : (job.report || '（报告还没生成）');
      const plan = path.join(JOBS_DIR, job.id, '分镜方案.md');
      const planMd = exists(plan) ? await fsp.readFile(plan, 'utf8') : '';
      return sendJson(res, 200, { markdown: md, storyboard: planMd });
    }
    m = /^\/api\/jobs\/([\w-]+)\/cancel$/.exec(p);
    if (m) {
      const job = jobs.get(m[1]);
      if (!job) return sendJson(res, 404, { error: 'job not found' });
      job.cancelRequested = true;
      if (currentChild) { try { currentChild.kill(); } catch {} }
      return sendJson(res, 200, { ok: true });
    }
    m = /^\/api\/jobs\/([\w-]+)\/rerun$/.exec(p);
    if (m) {
      const src = jobs.get(m[1]);
      if (!src) return sendJson(res, 404, { error: 'job not found' });
      if (!src.params || (!src.params.refVideo && !src.params.refUrl)) return sendJson(res, 400, { error: '上一个任务的参数已丢失（进程重启过旧记录），请直接重新提交' });
      const cached = jobs.get(analysisCache.get(src.sourceKey)) || (reusableAnalysis(src) ? src : null);
      const canReuse = reusableAnalysis(cached);
      const job = {
        id: newJobId(),
        createdAt: nowIso(),
        status: 'queued',
        params: JSON.parse(JSON.stringify(src.params)),
        logs: [], shots: [], stages: {}, progress: 0, stageFraction: 0,
        stageName: canReuse ? '复用已保存的拆解方案' : '排队中', stage: 'queued',
        stopAfterAnalysis: !src.automatic,
        automatic: !!src.automatic,
        sourceKey: src.sourceKey,
        cacheHit: canReuse,
        resumeFrom: canReuse ? cached.id : undefined,
        inheritStages: canReuse ? ['prepare', 'breakdown', 'analyze'] : [],
      };
      jobs.set(job.id, job);
      await ensureDir(path.join(JOBS_DIR, job.id));
      queue.push(job);
      broadcast('job-queued', jobSummary(job), job.id);
      startNext();
      return sendJson(res, 200, { id: job.id });
    }

    // 续跑：接手某个任务的产物，从失败/未完成的阶段继续（不重复花钱）
    m = /^\/api\/jobs\/([\w-]+)\/resume$/.exec(p);
    if (m) {
      const src = jobs.get(m[1]);
      if (!src) return sendJson(res, 404, { error: 'job not found' });
      if (!src.params || (!src.params.refVideo && !src.params.refUrl)) return sendJson(res, 400, { error: '上一个任务的参数已丢失（进程重启过旧记录），请重新提交' });
      const INHERITABLE = ['prepare', 'breakdown', 'analyze', 'storyboard', 'render'];
      const inheritStages = INHERITABLE.filter((k) => src.stages?.[k] === 'done');
      const job = {
        id: newJobId(),
        createdAt: nowIso(),
        status: 'queued',
        params: JSON.parse(JSON.stringify(src.params)),
        logs: [], shots: [], stages: {}, progress: 0, stageFraction: 0,
        stageName: '排队中', stage: 'queued',
        resumeFrom: src.id,
        inheritStages,
      };
      jobs.set(job.id, job);
      await ensureDir(path.join(JOBS_DIR, job.id));
      queue.push(job);
      broadcast('job-queued', jobSummary(job), job.id);
      startNext();
      return sendJson(res, 200, { id: job.id, resumeFrom: src.id, inheritStages });
    }

    // SSE 实时日志
    if (p === '/api/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-store',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write(': connected\n\n');
      sseClients.add(res);
      const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 15000);
      req.on('close', () => { clearInterval(ping); sseClients.delete(res); });
      return;
    }

    return sendText(res, 404, '404');
  } catch (err) {
    return sendJson(res, 500, { error: String(err && err.message ? err.message : err) });
  }
});

// ── 启动 ─────────────────────────────────────────────────────
(async () => {
  await ensureDir(DATA_DIR);
  await ensureDir(UPLOAD_DIR);
  await ensureDir(JOBS_DIR);
  await ensureDir(path.join(PUBLIC_DIR, 'assets'));
  // 复制 logo 到 data（原路径归百度网盘管，这里留一份稳定的）
  try {
    if (config.paths.logoSource && exists(config.paths.logoSource)) {
      await fsp.copyFile(config.paths.logoSource, path.join(DATA_DIR, 'logo.png'));
      await fsp.copyFile(config.paths.logoSource, path.join(PUBLIC_DIR, 'assets', 'logo.png'));
    }
  } catch { /* 忽略 */ }
  // 载入历史索引
  try {
    if (exists(JOBS_INDEX)) {
      const list = JSON.parse(await fsp.readFile(JOBS_INDEX, 'utf8'));
      for (const s of list) {
        if (!s || !s.id) continue;
        let params = s.params || null;
        if (!params) {
          // 旧索引里没有 params：去任务目录的 job.json 里补，好让「续跑/重生」在重启后也能用
          const jf = path.join(JOBS_DIR, s.id, 'job.json');
          if (exists(jf)) {
            try { params = JSON.parse(await fsp.readFile(jf, 'utf8')).params || null; } catch { /* 忽略 */ }
          }
        }
        const job = { ...s, logs: [], params: params || {} };
        // 报告正文不放在任务列表响应里，但缓存索引恢复时需要它作为完整性标记。
        const reportFile = path.join(JOBS_DIR, s.id, '拆解报告.md');
        if (exists(reportFile)) {
          try { job.report = await fsp.readFile(reportFile, 'utf8'); } catch { /* 忽略 */ }
        }
        jobs.set(s.id, job);
      }
    }
  } catch { /* 忽略 */ }

  // 已完成的免费拆解按视频内容/链接建立索引；服务重启后仍可复用。
  try {
    if (exists(ANALYSIS_CACHE_INDEX)) {
      const saved = JSON.parse(await fsp.readFile(ANALYSIS_CACHE_INDEX, 'utf8'));
      for (const [key, id] of Object.entries(saved || {})) {
        if (reusableAnalysis(jobs.get(id))) analysisCache.set(key, id);
      }
    }
    for (const job of jobs.values()) cacheAnalysis(job);
  } catch { /* 忽略 */ }

  // 兼容旧索引：根据成员任务自动补建批量任务记录。
  for (const job of jobs.values()) {
    if (!job.batchId) continue;
    let batch = batches.get(job.batchId);
    if (!batch) {
      batch = { id: job.batchId, createdAt: job.createdAt, productName: job.params?.productName || job.productName,
        status: 'analyzing', jobIds: [], reviewReady: false };
      batches.set(batch.id, batch);
    }
    if (!batch.jobIds.includes(job.id)) batch.jobIds.push(job.id);
  }
  for (const batch of batches.values()) {
    const members = batch.jobIds.map((id) => jobs.get(id)).filter(Boolean);
    if (members.length && members.every((job) => ['awaiting_confirmation', 'failed', 'cancelled'].includes(job.status))) {
      batch.status = 'awaiting_confirmation'; batch.reviewReady = true;
    }
  }

  // 载入批量任务索引；各成员任务仍以 jobs 为事实来源。
  try {
    if (exists(BATCHES_INDEX)) {
      const list = JSON.parse(await fsp.readFile(BATCHES_INDEX, 'utf8'));
      for (const batch of list) {
        if (!batch?.id || !Array.isArray(batch.jobs)) continue;
        batches.set(batch.id, {
          id: batch.id, createdAt: batch.createdAt, productName: batch.productName,
          status: batch.status, jobIds: batch.jobs.map((job) => job.id).filter(Boolean),
          reviewReady: batch.status === 'awaiting_confirmation' || batch.status === 'generating', automatic: !!batch.automatic,
        });
      }
    }
  } catch { /* 忽略 */ }

  server.on('error', (err) => {
    if (err && err.code === 'EADDRINUSE') {
      const url = `http://localhost:${PORT}`;
      console.log(`\n  端口 ${PORT} 已经有工厂在跑了 → 直接打开 ${url}\n`);
      try {
        if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
      } catch { /* 忽略 */ }
      process.exit(0);
    }
    console.error('服务错误：', err);
    process.exit(1);
  });

  server.listen(PORT, '127.0.0.1', () => {
    const url = `http://localhost:${PORT}`;
    console.log('');
    console.log('  ┌──────────────────────────────────────────────┐');
    console.log('  │   爱优护对标视频全自动生产工厂 · WebUI 已启动   │');
    console.log('  └──────────────────────────────────────────────┘');
    console.log(`   地址：${url}`);
    console.log(`   项目：${config.paths.project}`);
    console.log(`   成片：${config.paths.outDir}`);
    console.log(`   大脑：${config.deepseek.model} ${config.deepseek.apiKey ? '（Key 已就绪）' : '（⚠ 未配置 Key）'}`);
    if (config.dryStages?.length) console.log(`   ⚠ 演练模式：跳过 ${config.dryStages.join(', ')}`);
    console.log('');
    if (OPEN_BROWSER) {
      try {
        if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
        else if (process.platform === 'darwin') spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
        else spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
      } catch { /* 忽略 */ }
    }
  });
})().catch((err) => {
  console.error('启动失败：', err);
  process.exit(1);
});
