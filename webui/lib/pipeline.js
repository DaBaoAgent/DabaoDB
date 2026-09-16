'use strict';
/**
 * 全自动生产流水线：
 *   准备 → 拆解(抽帧+本地转写) → 读帧理解(deepseek-flash 多模态) → 拆解报告&分镜表
 *   → 分镜提示词(完全照对标 + 贴真标规则) → 渲染 .svml/.svrun → hypit plan/pricing
 *   → hypit build 生成镜像(逐镜) → ffmpeg 合成 → 导出到项目 out/
 *
 * 所有步骤通过 emit() 实时上报，前端用 SSE 收。
 */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const {
  run, runStream, extractJson, ensureDir, exists, ffprobeMeta, shrinkImage,
  grabThumb, makeCover, concatVideos, fmtSize,
} = require('./util');
const { Brain } = require('./deepseek');

/** 阶段权重（合计 100） */
const STAGES = [
  { key: 'prepare', name: '准备与校验', ui: 0, weight: 2 },
  { key: 'breakdown', name: '拆解对标视频（抽帧 + 本地转写）', ui: 0, weight: 10 },
  { key: 'analyze', name: '读帧理解与拆解报告', ui: 0, weight: 20 },
  { key: 'storyboard', name: '写分镜与各镜提示词', ui: 1, weight: 12 },
  { key: 'render', name: '渲染 .svml / .svrun', ui: 1, weight: 6 },
  { key: 'plan', name: '出片计划与估价', ui: 2, weight: 2 },
  { key: 'generate', name: '生成视频镜像（逐镜）', ui: 2, weight: 40 },
  { key: 'compose', name: '合成成片', ui: 3, weight: 5 },
  { key: 'export', name: '导出与预览', ui: 4, weight: 3 },
];

/** UI 五大步（左→右的步骤条） */
const UI_STEPS = ['拆解', '分镜', '生成镜像', '合成', '导出'];

/** 模型档 → 火山单价（元/百万 completion token）与可用分辨率 */
const MODEL_TABLE = {
  mini: { label: 'seedance-2-mini（最便宜）', rate: 23, res: ['480p', '720p'] },
  fast: { label: 'seedance-2-fast', rate: 37, res: ['480p', '720p'] },
  '2': { label: 'seedance-2', rate: 46, res: ['480p', '720p', '1080p', '4k'] },
  '2.5': { label: 'seedance-2.5', rate: 46, res: ['480p', '720p', '1080p'] },
};
/** 实测 token 用量（5 秒）→ 用于估价 */
const TOKENS_5S = { '480p': 50638, '720p': 108900, '1080p': 217800, '4k': 435600 };

function estimateCost({ model, resolution, shots, shotDuration }) {
  const m = MODEL_TABLE[model] || MODEL_TABLE.mini;
  const base = TOKENS_5S[resolution] || TOKENS_5S['720p'];
  const tokens = shots * base * (shotDuration / 5);
  return { tokens: Math.round(tokens), yuan: +(tokens / 1e6 * m.rate).toFixed(2), rate: m.rate };
}

async function nextDeliveryDir(outRoot, productName) {
  const base = String(productName || '未命名产品').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim() || '未命名产品';
  for (let n = 1; n < 10000; n++) {
    const dir = path.join(outRoot, `${base}_${n}`);
    if (!exists(dir)) return ensureDir(dir);
  }
  throw new Error('导出目录编号已用尽');
}

function publishCopy(review, productName) {
  const title = String(review?.title || `${productName}短视频方案`).trim();
  const tags = Array.isArray(review?.tags) ? review.tags.filter(Boolean).join(' ') : '';
  return `${title}\n\n${tags}\n`;
}

function applyReviewDirectives(shots, review) {
  const directives = [];
  if (review?.targetAudience) directives.push(`目标人群：${review.targetAudience}`);
  if (Array.isArray(review?.sellingPoints) && review.sellingPoints.length) directives.push(`本次必须保留的核心卖点：${review.sellingPoints.join('；')}`);
  if (review?.bannedWords) directives.push(`禁用词/禁用表达：${review.bannedWords}。不得出现、不得同义改写。`);
  if (!directives.length) return shots;
  const suffix = `\n\n【确认页最终要求｜必须执行】\n${directives.join('\n')}`;
  return shots.map((shot) => ({ ...shot, 提示词: `${shot.提示词}${suffix}` }));
}

/** 写一镜的 .svml / .svrun（render 阶段与"剔图重试"共用） */
async function renderShotSvml({ jobDir, shot, assets, spec }) {
  const n = String(shot.序号).padStart(2, '0');
  const svml = path.join(jobDir, `shot${n}.svml`);
  const svrun = path.join(jobDir, `shot${n}.svrun`);
  const promptId = `shot${n}-prompt`;
  const imgLines = assets.map((p, i) => `  <asset:Image id="img-${i + 1}" src="./assets/${path.basename(p)}"/>`).join('\n');
  const refLines = assets.map((p, i) => `    <seedance:Reference image={img-${i + 1}} person-reference="false"/>`).join('\n');
  const svmlBody = `<?svml using="@hypit/markup@1"?>
<svml>
  <import as="text" from="@hypit/text@1"/>
  <import as="asset" from="@hypit/media@1"/>
  <import as="seedance" from="@hypit/seedance@1"/>

${imgLines}

  <text:Value id="${promptId}">${shot.提示词}</text:Value>

  <seedance:ReferenceVideo id="final" model="${spec.model}" prompt={${promptId}}
    duration="${shot.时长}" resolution="${spec.resolution}" aspect-ratio="${spec.aspect}"
    generate-audio="${spec.audio ? 'true' : 'false'}">
${refLines}
  </seedance:ReferenceVideo>
</svml>
`;
  const svrunBody = `<?svml using="@hypit/run-markup@1"?>

<svrun version="1">
  <author source="./shot${n}.svml"/>
  <target output="final.video"/>
</svrun>
`;
  await fsp.writeFile(svml, svmlBody, 'utf8');
  await fsp.writeFile(svrun, svrunBody, 'utf8');
  return { svml, svrun };
}

/** 从失败的 Build 里挖出上游真实原因（Ark/Provider 的原始报错） */
async function buildFailure(buildId, P, spawnOptsFactory) {
  try {
    const r = await run(process.execPath,
      [P.hypitCli, 'inspect', buildId, '--json', '--workspace', P.project], spawnOptsFactory());
    const j = extractJson(r.out);
    return j?.build?.failure
      || j?.build?.operations?.find?.((o) => o.status === 'failed')?.failure?.message
      || '';
  } catch { return ''; }
}

// ────────────────────────────── 提示词 ──────────────────────────────

const P_SHEET = `你是短视频分镜分析师。这张图是一段参考视频的 3x3 联系表（9 格，按「左上→右下」时间顺序排列，每格间隔 2 秒）。
请逐格描述，只输出 JSON：
{"覆盖时间段":"0-18s","逐格":[{"格":1,"画面":"场景/环境","人物":"人数/年龄/服装/动作","产品":"产品出现的位置与状态","镜头运动":"景别与运动","画面文字":"画面里的字幕/文字原样抄下，没有写无"}]}
要求：只写你在图里真实看到的；看不清就写「看不清」，不要编。`;

const P_ANALYZE = `你是爆款视频拆解师。下面给你一条参考视频的「元数据」「逐镜视觉笔记」「口播逐句时间轴」。
请输出严格 JSON（不要多余文字）：
{
  "报告markdown": "一份完整的中文拆解报告（## 1 元数据 / ## 2 分镜表（时间|画面|镜头运动|产品|画面文字） / ## 3 口播全文 / ## 4 结构分析（前3秒钩子、卖点出现顺序、结尾CTA、可复刻要点、不要复刻的点））",
  "钩子": "前3秒钩子怎么做的",
  "卖点顺序": ["卖点1","卖点2"],
  "结尾CTA": "结尾怎么收",
  "视频类型": "真人口播/旁白解说/产品演示/生活场景等",
  "平台风格": "根据画面与节奏判断的平台风格；第一版统一按9:16竖屏短视频输出",
  "目标人群": "从对标内容推断的目标受众",
  "风险提示": ["仅提示迁移时需要注意的事实或表达风险"],
  "发布标题": "适合短视频平台的一句标题，不含竞品品牌",
  "发布标签": ["#标签1", "#标签2"],
  "可复刻要点": ["..."],
  "不复刻的点": ["他人形象/品牌/水印等"],
  "分镜": [
    {"序号":1,"起":0.0,"止":2.0,"画面":"...","口播":"这一镜对应的口播原句","镜头运动":"...","卖点":"这一镜承担什么作用"}
  ]
}
分镜必须覆盖整条视频，时间轴与口播时间对齐，不要漏镜、不要重复。
输出必须是完整、合法的 JSON；为避免截断：报告markdown 控制在 2800 个中文字符以内，分镜最多 12 镜，每项描述保持一句话，数组最多 6 项。宁可简洁，不要输出半截 JSON。`;

function promptStoryboard({ productName, learn, spec, report, images, refMeta }) {
  const mode = [];
  if (learn.narration) mode.push('旁白解说（画外音讲述，画面里没有真人说话）');
  if (learn.dialogue) mode.push('真人口播对白（画面里有真人开口说话，台词口语化）');
  if (!mode.length) mode.push('纯画面演示（无旁白、无对白）');
  const logoRule = learn.realLogo
    ? `【贴真标】已上传的品牌 Logo 会作为参考图加入。只在产品机身上还原该 Logo，拼写、比例和颜色必须与参考图一致；除该商标外不要生成其它文字、品牌或水印。`
    : `【不贴新标】允许保留产品参考图本身已有的品牌，但不要凭空生成新品牌、文字或 logo。`;
  const shots = Math.max(1, Number(spec.shots) || 1);
  const per = Math.max(1, Number(spec.shotDuration) || 15);
  return `你是 Seedance 视频提示词导演。把参考视频的「结构与节奏」复刻到我方产品上，产出可直接投喂视频模型的提示词。

## 我方产品
名称：${productName || '（未填）'}
参考图数量：${images} 张（已作为 reference_image 传入，产品外观**严格以参考图为准**，不要靠文字重新描述外观）

## 学习对标视频的开关（勾选了就是"完全照对标视频来"）
- 讲述方式：${mode.join(' + ')}
- 语气：${learn.tone ? '完全照抄对标视频的语气' : '自然中性'}
- 语速：${learn.speed ? '完全照抄对标视频的语速与节奏' : '常规语速'}
- 画面风格：${learn.style ? '完全照抄对标视频的画面风格、色调与调性' : '自然写实风格'}
- ${logoRule}

## 参考视频元数据
${refMeta}

## 参考视频拆解
${report}

## 输出规格
- 分镜数：${shots} 镜，每镜 ${per} 秒，画幅 ${spec.aspect}，分辨率 ${spec.resolution}
- 口播声音：${spec.audio ? '开启（要有人声/环境声）' : '关闭（静音画面）'}

## 硬规则（违反即返工）
1. 每镜提示词用中文写，包含：场景环境、人物与动作、产品出现方式与状态、镜头景别与运动、光线与调性；口播用"旁白：…"或"台词：…"显式给出，台词语言中文普通话、口语化。
2. **折叠/展开类机械动作必须写成"瞬发、一晃即开/一晃即折叠"，时间不超过 0.5 秒**（模型逐帧演算机械结构会穿帮、轮子车架变形）。
3. 口播口径保留产品卖点原话"3 秒折叠"（画面动作短促，但台词口径不改）。
4. 每镜结尾都写：除上述商标外，不要出现任何字幕、花字、水印、贴纸、UI 元素或随机字母。
5. 不要复刻参考视频里他人的人物形象、品牌、水印；换成我方产品与全新人物。

只输出 JSON：
{"总时长":15,"镜头":[{"序号":1,"时长":15,"提示词":"这一镜完整的生成提示词（含口播台词）"}]}`;
}

// ────────────────────────────── 流水线主体 ──────────────────────────────

async function runJob({ job, config, emit, registerChild }) {
  const P = config.paths;
  const jobDir = path.join(config.paths.dataDir, 'jobs', job.id);
  const stagesDone = {};
  job.stages = Object.fromEntries(STAGES.map((s) => [s.key, 'pending']));
  job.shots = [];
  job.startedAt = new Date().toISOString();

  function progress() {
    let done = 0;
    for (const s of STAGES) {
      const st = job.stages[s.key];
      if (st === 'done') done += s.weight;
      else if (st === 'running') done += s.weight * (job.stageFraction || 0);
      else break;
    }
    job.progress = Math.min(99, Math.round(done));
    emit('progress', { progress: job.progress, stage: job.stage, stageName: job.stageName, stageFraction: job.stageFraction || 0 });
  }

  async function stage(key, fn) {
    const def = STAGES.find((s) => s.key === key);
    job.stage = key;
    job.stageName = def.name;
    job.stageUi = def.ui;
    job.stageFraction = 0;
    if (inherited.has(key)) {
      job.stages[key] = 'done';
      log(`↻ 续跑：复用上一次的「${def.name}」结果（不重复花钱/花时间）`, 'ok');
      progress();
      return;
    }
    job.stages[key] = 'running';
    log(`▶ ${def.name}`, 'stage');
    progress();
    const t0 = Date.now();
    await fn();
    if (job.cancelRequested) throw new Error('任务已取消');
    job.stages[key] = 'done';
    job.stageFraction = 1;
    progress();
    log(`✔ ${def.name} 完成（${((Date.now() - t0) / 1000).toFixed(1)}s）`, 'ok');
  }

  function log(text, level = 'info', raw = false) {
    const entry = { at: new Date().toISOString(), stage: job.stage, text, level, raw };
    job.logs.push(entry);
    emit('log', entry);
  }

  const skip = new Set(config.dryStages || []);
  const inherited = new Set(job.inheritStages || []);
  async function maybeSkip(key) {
    if (skip.has(key)) {
      log(`（演练模式：跳过 ${key}）`, 'warn');
      job.stages[key] = 'done';
      progress();
      return true;
    }
    return false;
  }

  const brain = new Brain({
    baseUrl: config.deepseek.baseUrl,
    apiKey: config.deepseek.apiKey,
    model: config.deepseek.model,
    onLog: (t, l) => log(t, l),
  });

  await ensureDir(jobDir);
  const workDir = await ensureDir(path.join(jobDir, 'work'));
  const outDir = await ensureDir(path.join(jobDir, 'out'));
  const shotDir = await ensureDir(path.join(outDir, 'shot'));
  const assetDir = await ensureDir(path.join(jobDir, 'assets'));
  const reportDir = path.join(jobDir, '拆解');
  job.dir = jobDir;

  // 子进程登记（用于取消）
  const spawnOpts = (extra = {}) => ({
    ...extra,
    env: { ...(extra.env || {}), PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
    onSpawn: (child) => registerChild(child),
  });

  // ── 续跑：接手上一个任务的产物，跳过已完成的阶段 ──────────
  if (job.resumeFrom) {
    const prevDir = path.join(config.paths.dataDir, 'jobs', job.resumeFrom);
    if (!exists(prevDir)) throw new Error(`续跑失败：找不到上一个任务的产物目录 ${prevDir}`);
    log(`↻ 续跑模式：接手任务 ${job.resumeFrom} 的产物`, 'stage');
    const copyRel = async (rel) => {
      const src = path.join(prevDir, rel);
      if (!exists(src)) return;
      const dst = path.join(jobDir, rel);
      await ensureDir(path.dirname(dst));
      await fsp.cp(src, dst, { recursive: true, force: true });
    };
    for (const rel of ['拆解', 'assets', 'assets.json', 'out', 'work/ref.mp4',
      '拆解报告.md', '分镜提示词.json', '分镜方案.md', '分镜参考.json']) await copyRel(rel);
    for (const f of await fsp.readdir(prevDir)) {
      if (/^shot\d+\.(svml|svrun)$/.test(f)) await copyRel(f);
    }
    job.refCopy = path.join(workDir, 'ref.mp4');
    if (exists(job.refCopy)) job.refMeta = await ffprobeMeta(job.refCopy);
    const planFile = path.join(jobDir, '分镜提示词.json');
    if (exists(planFile)) job.shotsPlan = JSON.parse(await fsp.readFile(planFile, 'utf8'));
    const manifest = path.join(jobDir, 'assets.json');
    if (exists(manifest)) {
      job.assetImages = JSON.parse(await fsp.readFile(manifest, 'utf8'));
    } else {
      const list = (await fsp.readdir(assetDir)).filter((f) => /\.(jpe?g|png)$/i.test(f));
      list.sort((a, b) => (a === 'logo.png' ? 1 : b === 'logo.png' ? -1 : a.localeCompare(b)));
      job.assetImages = list.map((f) => path.join(assetDir, f));
    }
    const svmls = (await fsp.readdir(jobDir)).filter((f) => /^shot\d+\.svml$/.test(f)).sort();
    job.shotFiles = svmls.map((f) => ({
      shot: Number((f.match(/\d+/) || [0])[0]),
      svml: path.join(jobDir, f),
      svrun: path.join(jobDir, f.replace(/\.svml$/, '.svrun')),
    }));
    if (exists(path.join(jobDir, '拆解报告.md'))) job.report = await fsp.readFile(path.join(jobDir, '拆解报告.md'), 'utf8');
    if (exists(path.join(jobDir, '分镜参考.json'))) job.storyboardRef = JSON.parse(await fsp.readFile(path.join(jobDir, '分镜参考.json'), 'utf8'));
    if (exists(path.join(reportDir, 'transcript.txt'))) job.transcript = await fsp.readFile(path.join(reportDir, 'transcript.txt'), 'utf8');
    if (job.confirmedReview?.shots?.length) {
      job.shotsPlan = applyReviewDirectives(job.confirmedReview.shots, job.confirmedReview);
      await fsp.writeFile(path.join(jobDir, '分镜提示词.json'), JSON.stringify(job.shotsPlan, null, 2), 'utf8');
      await fsp.writeFile(path.join(jobDir, '分镜方案.md'),
        `# ${job.params.productName} 分镜方案（已确认）\n\n` + job.shotsPlan.map((s) => `## 第 ${s.序号} 镜（${s.时长}s）\n\n${s.提示词}\n`).join('\n'), 'utf8');
      log('已应用确认页编辑后的分镜与台词', 'ok');
    }
    job.shots = job.shotFiles.map((f) => ({
      index: f.shot,
      status: exists(path.join(shotDir, `shot${String(f.shot).padStart(2, '0')}.mp4`)) ? 'done' : 'scripted',
      duration: (job.shotsPlan || []).find((s) => s.序号 === f.shot)?.时长,
      file: exists(path.join(shotDir, `shot${String(f.shot).padStart(2, '0')}.mp4`)) ? path.join(shotDir, `shot${String(f.shot).padStart(2, '0')}.mp4`) : null,
    }));
    for (const s of job.shots) emit('shot', { index: s.index, status: s.status });
    log(`↻ 已接手：${(job.shotsPlan || []).length} 个分镜 · ${job.assetImages.length} 张参考图 · ${job.shotFiles.length} 份源码 · 已有成片 ${job.shots.filter((s) => s.status === 'done').length} 镜`, 'ok');
  }

  // ── 1. 准备 ──────────────────────────────────────────────
  await stage('prepare', async () => {
    if (!job.params.productName || !job.params.productName.trim()) throw new Error('产品名称不能为空');
    const imgs = job.params.productImages || [];
    if (imgs.length > 9) throw new Error('产品参考图最多 9 张（视频模型限制）');
    for (const p of imgs) {
      if (!exists(p)) throw new Error(`素材不存在：${p}`);
    }
    // 统一复制成 ASCII 名（中文/emoji 文件名会打断 ffmpeg 与 CLI 传参）
    const refCopy = path.join(workDir, 'ref.mp4');
    if (job.params.refVideo) {
      if (!exists(job.params.refVideo)) throw new Error(`对标视频不存在：${job.params.refVideo}`);
      await fsp.copyFile(job.params.refVideo, refCopy);
    } else if (job.params.refUrl) {
      if (!P.ytDlpProject || !exists(P.ytDlpProject)) throw new Error('抖音链接下载组件未配置，请检查 ytDlpProject 路径');
      const sourcePattern = path.join(workDir, 'source.%(ext)s');
      log('正在从抖音链接提取对标视频，仅用于本次本地拆解…', 'info');
      const downloadArgs = [
        'run', '--project', P.ytDlpProject, '--frozen', 'yt-dlp', '--no-playlist', '--no-progress', '--newline',
        '--format', 'bv*+ba/b', '--merge-output-format', 'mp4', '--format-sort', 'res:1080,vcodec:h264',
        '--output', sourcePattern, job.params.refUrl,
      ];
      let r = await runStream('uv', downloadArgs, spawnOpts(), (line, stream) => log(line, stream === 'stderr' ? 'warn' : 'raw', true));
      // 抖音常要求新鲜 Cookie：自动尝试本机 Edge Cookie，再决定是否报错。
      if (r.code !== 0) {
        const browsers = ['edge', 'chrome', 'chrome:Profile 1', 'chrome:Profile 4'];
        for (const browser of browsers) {
          log(`抖音要求登录态，尝试读取本机 ${browser} Cookie…`, 'warn');
          r = await runStream('uv', [...downloadArgs.slice(0, -1), '--cookies-from-browser', browser, job.params.refUrl], spawnOpts(), (line, stream) => log(line, stream === 'stderr' ? 'warn' : 'raw', true));
          if (r.code === 0) break;
        }
      }
      if (r.code !== 0) throw new Error('抖音视频提取失败：该链接需要可用的抖音登录 Cookie，请在浏览器登录后重试，或直接上传视频文件');
      const files = (await fsp.readdir(workDir))
        .filter((name) => /^source\./i.test(name) && /\.(mp4|mov|mkv|webm)$/i.test(name))
        .map((name) => path.join(workDir, name));
      if (!files.length) throw new Error('抖音视频提取完成但没有找到可分析的视频文件');
      await fsp.copyFile(files[0], refCopy);
      job.params.refVideo = refCopy;
      log('抖音对标视频已提取，开始本地拆解', 'ok');
    } else {
      throw new Error('未提供对标视频或抖音链接');
    }
    job.refCopy = refCopy;
    const meta = await ffprobeMeta(refCopy);
    job.refMeta = meta;
    const sourceName = job.params.refUrl ? '抖音链接视频' : path.basename(job.params.refVideo);
    log(`对标视频：${sourceName} · ${meta.width}×${meta.height} · ${meta.duration.toFixed(1)}s · ${meta.hasAudio ? '有音轨' : '无音轨'} · ${fmtSize(meta.size)}`, 'info');
    emit('ref-meta', meta);
    if (!meta.duration) throw new Error('对标视频时长读不到，文件可能损坏');
    job.cancelRequested = false;
  });

  // ── 2. 拆解（抽帧 + 本地转写）────────────────────────────
  await stage('breakdown', async () => {
    if (await maybeSkip('breakdown')) { job.transcript = '[演练模式跳过]'; return; }
    const script = P.breakdownScript;
    if (!exists(script)) throw new Error(`拆解脚本不存在：${script}`);
    if (!exists(P.python)) throw new Error(`Python 解释器不存在：${P.python}`);
    const args = [script, job.refCopy, '--out', reportDir, '--whisper-model', P.whisperModel || 'small'];
    log(`执行：ffmpeg 抽帧 + **本地** faster-whisper 转写（不走云端）· 模型 ${P.whisperModel ? path.basename(P.whisperModel) : 'small'}`, 'info', true);
    const r = await runStream(P.python, args, spawnOpts(), (line, stream) => log(line, stream === 'stderr' ? 'warn' : 'raw', true));
    if (r.code !== 0) throw new Error(`拆解脚本退出码 ${r.code}`);
    const trPath = path.join(reportDir, 'transcript.txt');
    job.transcript = exists(trPath) ? await fsp.readFile(trPath, 'utf8') : '';
    log(`转写完成，口播 ${job.transcript.split('\n').length - 1} 行`, 'ok');
    emit('transcript', { text: job.transcript });
  });

  // ── 3. 读帧理解 + 拆解报告 ───────────────────────────────
  await stage('analyze', async () => {
    if (job.stages.breakdown === 'pending') { /* 演练模式兼容 */ }
    if (skip.has('analyze')) { job.report = '# （演练模式跳过读帧）'; await fsp.writeFile(path.join(jobDir, '拆解报告.md'), job.report, 'utf8'); return; }
    const sheets = exists(path.join(reportDir, 'sheets'))
      ? (await fsp.readdir(path.join(reportDir, 'sheets'))).filter((f) => /\.jpe?g$/i.test(f)).sort()
      : [];
    if (!sheets.length) throw new Error('拆解没有产出联系表（sheets/），无法读帧');
    const sheetPaths = sheets.slice(0, 9).map((f) => path.join(reportDir, 'sheets', f));
    const notes = [];
    for (let i = 0; i < sheetPaths.length; i++) {
      job.stageFraction = (i / sheetPaths.length) * 0.6;
      progress();
      log(`读第 ${i + 1}/${sheetPaths.length} 张联系表…`, 'info');
      const text = await brain.visionAsk([sheetPaths[i]], P_SHEET, { maxTokens: 4000, label: `读图 sheet-${i + 1}` });
      const parsed = require('./util').looseJson(text);
      notes.push(parsed ? JSON.stringify(parsed, null, 1) : text);
      emit('sheet-note', { index: i + 1, note: parsed || text });
    }
    job.stageFraction = 0.65;
    progress();

    const refKey = exists(path.join(reportDir, 'keyframes'))
      ? (await fsp.readdir(path.join(reportDir, 'keyframes'))).filter((f) => /\.jpe?g$/i.test(f)).length : 0;
    const meta = job.refMeta;
    const userMsg = `## 元数据
分辨率 ${meta.width}×${meta.height}（${meta.height > meta.width ? '竖屏' : '横屏'}），时长 ${meta.duration.toFixed(1)}s，帧率 ${meta.fps}，音轨 ${meta.hasAudio ? '有' : '无'}，场景关键帧 ${refKey} 张。

## 逐镜视觉笔记（联系表读图结果）
${notes.map((n, i) => `### 联系表 ${i + 1}\n\`\`\`json\n${n}\n\`\`\``).join('\n')}

## 口播逐句时间轴
\`\`\`
${(job.transcript || '').slice(0, 12000)}
\`\`\``;
    const res = await brain.chatJson(
      [{ role: 'system', content: P_ANALYZE }, { role: 'user', content: userMsg }],
      { maxTokens: 8000, temperature: 0.4, label: '拆解报告' },
    );
    job.storyboardRef = res;
    job.report = res.报告markdown || JSON.stringify(res, null, 2);
    await fsp.writeFile(path.join(jobDir, '拆解报告.md'), job.report, 'utf8');
    await fsp.writeFile(path.join(jobDir, '分镜参考.json'), JSON.stringify(res, null, 2), 'utf8');
    job.stageFraction = 1;
    progress();
    emit('report', { markdown: job.report });
    log(`拆解报告已生成（${job.report.length} 字，参考分镜 ${(res.分镜 || []).length} 镜）`, 'ok');
  });

  // ── 4. 分镜 + 提示词 ────────────────────────────────────
  await stage('storyboard', async () => {
    if (await maybeSkip('storyboard')) {
      job.shotsPlan = [{ 序号: 1, 时长: Number(job.params.spec.shotDuration) || 15, 提示词: '（演练模式占位提示词）' }];
      return;
    }
    const imgs = job.params.productImages || [];
    const refText = (job.report || '').slice(0, 9000);
    const plan = await brain.chatJson(
      [{ role: 'system', content: promptStoryboard({
        productName: job.params.productName,
        learn: job.params.learn,
        spec: job.params.spec,
        report: refText,
        images: imgs.length,
        refMeta: `参考视频 ${job.refMeta.width}×${job.refMeta.height}、${job.refMeta.duration.toFixed(1)}s；我方可复刻全篇结构与节奏`,
      }) },
      { role: 'user', content: '请输出 JSON。' }],
      { maxTokens: 8000, temperature: 0.7, label: '分镜提示词' },
    );
    job.shotsPlan = (plan.镜头 || []).map((s, i) => ({
      序号: s.序号 || i + 1,
      时长: Number(s.时长) || Number(job.params.spec.shotDuration) || 15,
      提示词: String(s.提示词 || '').trim(),
    })).filter((s) => s.提示词);
    // 兜底：模型没给够镜数就补齐
    const want = Math.max(1, Number(job.params.spec.shots) || 1);
    while (job.shotsPlan.length < want) {
      job.shotsPlan.push({
        序号: job.shotsPlan.length + 1,
        时长: Number(job.params.spec.shotDuration) || 15,
        提示词: job.shotsPlan[0]?.提示词 || '产品演示镜头',
      });
    }
    job.shotsPlan = job.shotsPlan.slice(0, want);
    await fsp.writeFile(path.join(jobDir, '分镜提示词.json'), JSON.stringify(job.shotsPlan, null, 2), 'utf8');
    await fsp.writeFile(path.join(jobDir, '分镜方案.md'),
      `# ${job.params.productName} 分镜方案\n\n` + job.shotsPlan.map((s) => `## 第 ${s.序号} 镜（${s.时长}s）\n\n${s.提示词}\n`).join('\n'), 'utf8');
    emit('shots-plan', job.shotsPlan);
    log(`分镜 ${job.shotsPlan.length} 镜，提示词已就绪`, 'ok');
  });

  // 报告、分镜与可编辑方案总是在免费阶段完成后保存；全自动模式仅跳过人工确认。
  const ref = job.storyboardRef || {};
  job.estimate = estimateCost({
    model: job.params.spec.model,
    resolution: job.params.spec.resolution,
    shots: job.shotsPlan.length,
    shotDuration: Number(job.params.spec.shotDuration) || 15,
  });
  job.review = job.cachedReview ? {
    ...job.cachedReview,
    shots: job.shotsPlan,
  } : {
      videoType: ref.视频类型 || ref.视频类型判断 || '按对标视频结构生成',
      platformStyle: ref.平台风格 || '自动转换为 9:16 竖屏短视频风格',
      structure: ref.可复刻要点 || [],
      sellingPoints: ref.卖点顺序 || [],
      targetAudience: ref.目标人群 || '',
      risks: ref.风险提示 || [],
      title: ref.发布标题 || `${job.params.productName}，看看它怎么解决日常出行`,
      tags: Array.isArray(ref.发布标签) ? ref.发布标签 : [],
      shots: job.shotsPlan,
  };

  // 分析任务到这里暂停：这是付费调用前唯一的人工确认点。
  // 后续确认任务会以 resumeFrom 复用前四个免费阶段的产物。
  if (job.stopAfterAnalysis) {
    job.stage = 'confirmation';
    job.stageName = '等待确认（尚未产生视频生成费用）';
    job.awaitingConfirmation = true;
    job.progress = 44;
    log(`免费分析已完成，预计生成费用 ¥${job.estimate.yuan}。请在确认页检查并确认后再出片。`, 'ok');
    emit('review-ready', { review: job.review, estimate: job.estimate });
    return job;
  }

  // ── 5. 渲染 .svml / .svrun ──────────────────────────────
  await stage('render', async () => {
    // 产品参考图：压到 ≤1024 宽（原图 16MB base64 内联会爆）
    const imgs = job.params.productImages || [];
    const assetImages = [];
    for (let i = 0; i < imgs.length; i++) {
      const dst = path.join(assetDir, `prod-${i + 1}.jpg`);
      await shrinkImage(imgs[i], dst, 1024);
      assetImages.push(dst);
      log(`产品参考图 ${i + 1} 就绪：${path.basename(imgs[i])} → ${fmtSize((await fsp.stat(dst)).size)}`, 'info');
    }
    if (job.params.learn.realLogo && job.params.logo) {
      const dst = path.join(assetDir, 'logo.png');
      await shrinkImage(job.params.logo, dst, 1024);
      assetImages.push(dst);
      log('贴真标：爱优护 logo 已作为参考图加入', 'info');
    }
    job.assetImages = assetImages;

    await fsp.writeFile(path.join(jobDir, 'assets.json'), JSON.stringify(assetImages, null, 2), 'utf8');
    const spec = job.params.spec;
    job.shotFiles = [];
    for (const shot of job.shotsPlan) {
      const n = String(shot.序号).padStart(2, '0');
      const { svml, svrun } = await renderShotSvml({ jobDir, shot, assets: assetImages, spec });
      const chk = await run(process.execPath, [P.hypitCli, 'check', svml, '--workspace', P.project], spawnOpts());
      log(`shot${n} 源码校验：${chk.out.includes('Source is valid') ? '✓ 通过' : '⚠ 见原始输出'}`, chk.out.includes('Source is valid') ? 'ok' : 'warn');
      if (!chk.out.includes('Source is valid')) log(chk.out.trim().slice(-500), 'warn', true);
      job.shotFiles.push({ shot: shot.序号, svml, svrun });
      emit('shot', { index: shot.序号, status: 'scripted', thumb: null });
      job.shots.push({ index: shot.序号, status: 'scripted', thumb: null, duration: shot.时长 });
    }
  });

  // ── 6. 出片计划与估价（免费）────────────────────────────
  await stage('plan', async () => {
    for (const f of job.shotFiles) {
      const r = await run(process.execPath,
        [P.hypitCli, 'plan', f.svrun, '--workspace', P.project, '--runtime', P.runtime], spawnOpts());
      const tail = r.lines.map((l) => l.line).filter((l) => /Requests|Preflight|Provider requests/.test(l)).join(' · ');
      log(`shot${String(f.shot).padStart(2, '0')} 计划：${tail || '（见原始输出）'}`, 'info');
    }
    const est = estimateCost({
      model: job.params.spec.model,
      resolution: job.params.spec.resolution,
      shots: job.shotsPlan.length,
      shotDuration: job.shotsPlan.reduce((a, s) => a + s.时长, 0) / job.shotsPlan.length,
    });
    job.estimate = est;
    log(`预计花费 ≈ ¥${est.yuan}（${est.tokens.toLocaleString()} completion tokens × ${est.rate} 元/百万）`, 'warn');
    emit('estimate', est);
  });

  // ── 7. 逐镜生成（花钱）────────────────────────────────
  await stage('generate', async () => {
    if (await maybeSkip('generate')) {
      for (const s of job.shots) { s.status = 'done'; emit('shot', { index: s.index, status: 'done', thumb: null }); }
      return;
    }
    const total = job.shotFiles.length;
    for (let i = 0; i < total; i++) {
      const f = job.shotFiles[i];
      const n = String(f.shot).padStart(2, '0');
      const dst = path.join(shotDir, `shot${n}.mp4`);
      job.currentShot = f.shot;
      // 已有成片（续跑接手）→ 不重复花钱
      if (exists(dst) && fs.statSync(dst).size > 100 * 1024) {
        const rec = job.shots.find((s) => s.index === f.shot) || {};
        rec.status = 'done';
        rec.file = dst;
        const thumb = path.join(outDir, `thumb-shot${n}.jpg`);
        if (!exists(thumb)) await grabThumb(dst, thumb, Math.min(1, (job.shotsPlan[i]?.时长 || 5) / 2));
        rec.thumb = exists(thumb) ? `/media/job/${job.id}/out/thumb-shot${n}.jpg` : null;
        emit('shot', { index: f.shot, status: 'done', thumb: rec.thumb, file: `/media/job/${job.id}/out/shot/shot${n}.mp4` });
        log(`第 ${f.shot} 镜已有成片 → 续跑直接复用（省一次生成费用）`, 'ok');
        job.stageFraction = Math.min(1, (i + 1) / total);
        progress();
        continue;
      }
      const slice = 1 / total;
      job.stageFraction = i * slice;
      progress();

      const shotRec = job.shots.find((s) => s.index === f.shot) || {};
      let buildId = '', state = 'running', outcome = '', failure = '';
      const maxAttempts = 12;
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        log(`提交第 ${f.shot}/${total} 镜到火山方舟（Seedance ${job.params.spec.model} / ${job.params.spec.resolution} / ${job.shotsPlan[i]?.时长}s · 参考图 ${(job.assetImages || []).length} 张${attempt ? ` · 第 ${attempt + 1} 次尝试` : ''}）…`, 'stage');
        const b = await runStream(process.execPath,
          [P.hypitCli, 'build', f.svrun, '--json', '--workspace', P.project, '--runtime', P.runtime,
            '--title', `${job.params.productName || '爱优护'} shot${n}`],
          spawnOpts(), (line) => log(line, 'raw', true));
        const bJson = extractJson(b.out);
        buildId = bJson?.build?.id || bJson?.id || (String(b.out).match(/bld_[A-Za-z0-9_]+/) || [])[0] || '';
        if (!buildId) throw new Error(`第 ${f.shot} 镜提交失败，未拿到 build-id：${b.out.slice(-400)}`);
        shotRec.buildId = buildId;
        shotRec.status = 'running';
        emit('shot', { index: f.shot, status: 'running', buildId });
        log(`build-id = ${buildId}`, 'info', true);

        // 轮询状态（--follow 只是观察者，状态才是真相）
        const deadline = Date.now() + 30 * 60 * 1000;
        state = 'running'; outcome = '';
        const t0 = Date.now();
        let soft = 0;
        while (Date.now() < deadline) {
          if (job.cancelRequested) throw new Error('任务已取消');
          await new Promise((r) => setTimeout(r, 6000));
          const st = await run(process.execPath, [P.hypitCli, 'status', buildId, '--json', '--workspace', P.project], spawnOpts());
          const sj = extractJson(st.out);
          state = sj?.build?.work?.state || state;
          outcome = sj?.build?.work?.outcome || outcome;
          soft = Math.min(0.9, soft + 0.06);
          job.stageFraction = Math.min(1, i * slice + slice * soft);
          progress();
          log(`第 ${f.shot} 镜状态：${state}${outcome ? ' / ' + outcome : ''}（已等待 ${((Date.now() - t0) / 1000).toFixed(0)}s）`, 'info');
          if (state === 'done' || state === 'failed') break;
        }
        if (state === 'done' && (!outcome || outcome === 'complete')) break;

        // 失败：去 Build 里挖上游真实原因（Ark 的原始报错）
        failure = await buildFailure(buildId, P, spawnOpts);
        if (!failure) failure = `state=${state} outcome=${outcome}（build ${buildId}）`;
        log(`✖ 第 ${f.shot} 镜被上游拒绝：${failure}`, 'error');

        // 自愈：Ark 拒收"含真人"的参考图 → 自动剔除该图后重试
        if (/may contain real person/i.test(failure) && (job.assetImages || []).length > 1) {
          const m = /content\[(\d+)\]/.exec(failure);
          let idx = m ? Number(m[1]) - 1 : job.assetImages.length - 1; // content[0] 是文本，图片从 1 开始
          idx = Math.max(0, Math.min(idx, job.assetImages.length - 1));
          const victim = job.assetImages.splice(idx, 1)[0];
          log(`⚠ 火山拒收"疑似含真人"的参考图 → 自动剔除第 ${idx + 1} 张「${path.basename(victim)}」，剩 ${job.assetImages.length} 张后重试`, 'warn');
          try {
            const rejDir = await ensureDir(path.join(assetDir, '_rejected'));
            await fsp.rename(victim, path.join(rejDir, path.basename(victim)));
          } catch { /* 挪不动就留着，反正已不被引用 */ }
          await fsp.writeFile(path.join(jobDir, 'assets.json'), JSON.stringify(job.assetImages, null, 2), 'utf8');
          const planMap = new Map((job.shotsPlan || []).map((s) => [s.序号, s]));
          const rewritten = [];
          for (const sf of job.shotFiles) {
            const mm = `shot${String(sf.shot).padStart(2, '0')}.mp4`;
            if (exists(path.join(shotDir, mm))) continue; // 已出片的镜不动
            const ps = planMap.get(sf.shot);
            if (!ps) continue;
            await renderShotSvml({ jobDir, shot: ps, assets: job.assetImages, spec: job.params.spec });
            rewritten.push(sf.shot);
          }
          log(`已重写第 ${rewritten.join(' / ')} 镜源码（去掉被拒参考图）`, 'info');
          continue;
        }

        shotRec.status = 'failed';
        emit('shot', { index: f.shot, status: 'failed' });
        throw new Error(`第 ${f.shot} 镜生成失败：${failure}`);
      }
      // 导出这一镜
      const g = await runStream(process.execPath,
        [P.hypitCli, 'get', buildId, '--output', 'final.video', '--to', dst, '--workspace', P.project, '--json'],
        spawnOpts(), (line) => log(line, 'raw', true));
      if (!exists(dst)) throw new Error(`第 ${f.shot} 镜导出失败：${g.out.slice(-300)}`);
      const size = fmtSize((await fsp.stat(dst)).size);
      shotRec.file = dst;
      shotRec.status = 'done';
      const thumb = path.join(outDir, `thumb-shot${n}.jpg`);
      await grabThumb(dst, thumb, Math.min(1, job.shotsPlan[i].时长 / 2));
      shotRec.thumb = exists(thumb) ? `/media/job/${job.id}/out/thumb-shot${n}.jpg` : null;
      job.stageFraction = Math.min(1, (i + 1) * slice);
      progress();
      emit('shot', { index: f.shot, status: 'done', thumb: shotRec.thumb, file: `/media/job/${job.id}/out/shot/shot${n}.mp4`, size });
      log(`第 ${f.shot} 镜完成：${size}`, 'ok');
    }
    log(`生成阶段全部完成，共 ${total} 镜`, 'ok');
  });

  // ── 8. 合成 ────────────────────────────────────────────
  await stage('compose', async () => {
    if (skip.has('generate')) { log('（演练模式：无成片可合成）', 'warn'); job.finalPath = null; return; }
    if (job.shotFiles.length === 1) {
      job.finalPath = path.join(shotDir, 'shot01.mp4');
      log('单镜项目，直接作为成片', 'info');
    } else {
      const files = job.shotFiles.map((f) => path.join(shotDir, `shot${String(f.shot).padStart(2, '0')}.mp4`));
      const dst = path.join(outDir, 'final.mp4');
      job.stageFraction = 0.3; progress();
      log(`ffmpeg 拼接 ${files.length} 镜…`, 'info');
      const r = await concatVideos(files, dst, workDir);
      if (!r.ok) throw new Error(`拼接失败：${(r.log || '').slice(-300)}`);
      job.finalPath = dst;
      log('拼接完成', 'ok');
    }
    const meta = await ffprobeMeta(job.finalPath);
    job.finalMeta = meta;
    job.stageFraction = 1; progress();
    log(`成片：${meta.width}×${meta.height} · ${meta.duration.toFixed(2)}s · ${fmtSize(meta.size)}`, 'ok');
  });

  // ── 9. 导出 ────────────────────────────────────────────
  await stage('export', async () => {
    if (!job.finalPath || !exists(job.finalPath)) { log('没有可导出的成片（演练模式）', 'warn'); return; }
    const outRoot = P.outDir;
    await ensureDir(outRoot);
    const deliveryDir = await nextDeliveryDir(outRoot, job.params.productName);
    const dst = path.join(deliveryDir, '成片.mp4');
    const review = job.confirmedReview || job.review || {};
    const cover = path.join(deliveryDir, '封面.jpg');
    const text = path.join(deliveryDir, '发布文案.txt');
    await fsp.copyFile(job.finalPath, dst);
    const subtitle = Array.isArray(review.sellingPoints) && review.sellingPoints.length
      ? review.sellingPoints[0] : '自动生成短视频方案';
    const madeCover = await makeCover(job.finalPath, cover, { title: review.title, subtitle });
    if (!madeCover) {
      await grabThumb(job.finalPath, cover, 1);
      log('封面文字叠加失败，已回退为成片关键帧', 'warn');
    }
    await fsp.writeFile(text, publishCopy(review, job.params.productName), 'utf8');
    job.outputPath = dst;
    job.deliveryDir = deliveryDir;
    job.coverPath = cover;
    job.publishCopyPath = text;
    const deliveryRelative = path.relative(outRoot, cover).replace(/\\/g, '/');
    job.finalThumb = exists(cover) ? `/media/out/${encodeURI(deliveryRelative)}` : null;
    // 播放器只认 out/final.mp4：不管单镜还是多镜，都物化一份，否则前端 404 点不动
    const previewFile = path.join(outDir, 'final.mp4');
    if (path.resolve(job.finalPath) !== path.resolve(previewFile)) {
      await fsp.copyFile(job.finalPath, previewFile);
    }
    job.previewUrl = `/media/job/${job.id}/out/final.mp4`;
    emit('final', { outputPath: dst, previewUrl: job.previewUrl, thumb: job.finalThumb, meta: job.finalMeta, deliveryDir, coverPath: cover, publishCopyPath: text });
    log(`交付已导出：${deliveryDir}（成片、封面、发布文案）`, 'ok');
    log(`本次 API token 用量：prompt ${brain.usage.prompt} / completion ${brain.usage.completion}（${brain.usage.calls} 次调用）`, 'info');
    job.brainUsage = brain.usage;
  });

  job.progress = 100;
  emit('progress', { progress: 100, stage: 'done', stageName: '全部完成', stageFraction: 1 });
  job.status = 'done';
  job.finishedAt = new Date().toISOString();
  return job;
}

module.exports = { runJob, STAGES, UI_STEPS, estimateCost, MODEL_TABLE };
