'use strict';
/**
 * 通用工具：子进程流式执行、路径、ffmpeg/ffprobe、文件系统。
 * 零外部依赖，只用 Node 内置模块。
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const HOME = os.homedir();

/** 把一个 Buffer 解码成字符串（优先 utf-8，含 BOM 兜底） */
function decode(buf) {
  let s = buf.toString('utf8');
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  return s;
}

/**
 * 流式执行子进程：每读到一整行就回调 onLine(line, stream)。
 * 返回 {code, lines, out}；不会因非零退出码抛错。
 */
function runStream(cmd, args, opts = {}, onLine = () => {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...(opts.env || {}) },
      windowsHide: true,
    });
    const lines = [];
    let out = '';
    const push = (raw, stream) => {
      out += raw;
      for (const line of raw.split(/\r?\n/)) {
        if (line.trim() === '') continue;
        lines.push({ line, stream });
        try { onLine(line, stream); } catch { /* 回调不打断进程 */ }
      }
    };
    if (child.stdout) child.stdout.on('data', (b) => push(decode(b), 'stdout'));
    if (child.stderr) child.stderr.on('data', (b) => push(decode(b), 'stderr'));
    child.on('error', (err) => {
      push(`[启动失败] ${cmd}: ${err.message}`, 'stderr');
      resolve({ code: -1, lines, out });
    });
    child.on('close', (code) => resolve({ code: code === null ? -1 : code, lines, out }));
    if (opts.onSpawn) opts.onSpawn(child);
  });
}

/** 简单执行并拿完整输出（不流式） */
async function run(cmd, args, opts = {}) {
  return runStream(cmd, args, opts);
}

/** 解析命令输出里第一段 JSON（CLI 的 --json 输出前后可能带提示行） */
function extractJson(text) {
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(text.slice(start, i + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

/** 从模型回复里宽松抠出 JSON 对象 */
function looseJson(text) {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  const direct = extractJson(candidate);
  if (direct) return direct;
  const arr = candidate.match(/\[[\s\S]*\]/);
  if (arr) { try { return JSON.parse(arr[0]); } catch { /* ignore */ } }
  return null;
}

async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
  return dir;
}

function safeName(name, fallback = 'file') {
  const base = path.basename(String(name || '')).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim();
  return base === '' ? fallback : base.slice(0, 120);
}

function exists(p) {
  try { fs.accessSync(p); return true; } catch { return false; }
}

async function ffprobeMeta(file) {
  const r = await run('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration,size,bit_rate',
    '-show_entries', 'stream=codec_type,codec_name,width,height,r_frame_rate,sample_rate,channels',
    '-of', 'json', file,
  ]);
  const json = extractJson(r.out);
  if (!json) return { raw: r.out, duration: 0, width: 0, height: 0 };
  const v = (json.streams || []).find((s) => s.codec_type === 'video') || {};
  const a = (json.streams || []).find((s) => s.codec_type === 'audio') || {};
  return {
    duration: Number(json.format?.duration || 0),
    size: Number(json.format?.size || 0),
    bitRate: Number(json.format?.bit_rate || 0),
    width: v.width || 0,
    height: v.height || 0,
    fps: v.r_frame_rate || '',
    hasAudio: !!a.codec_name,
    vcodec: v.codec_name || '',
    acodec: a.codec_name || '',
  };
}

/** 压缩图片到最大宽度（Seedance 内联 base64 需要小图） */
async function shrinkImage(src, dst, maxWidth = 1024) {
  const r = await run('ffmpeg', ['-y', '-v', 'error', '-i', src,
    '-vf', `scale='min(${maxWidth},iw)':-2`, '-q:v', '3', dst]);
  if (r.code === 0 && exists(dst)) return dst;
  await fsp.copyFile(src, dst);
  return dst;
}

/** 抽一帧当缩略图 */
async function grabThumb(video, dst, atSeconds = 1) {
  const r = await run('ffmpeg', ['-y', '-v', 'error', '-ss', String(atSeconds), '-i', video,
    '-frames:v', '1', '-vf', 'scale=480:-2', '-q:v', '4', dst]);
  if (r.code === 0 && exists(dst)) return dst;
  return null;
}

function drawTextEscape(value) {
  return String(value || '')
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\\\'")
    .replace(/:/g, '\\:')
    .replace(/%/g, '\\%')
    .replace(/[\r\n]+/g, ' ');
}

/** 从成片抽最佳帧，制作 9:16 发布封面（主标题 + 小卖点）。 */
async function makeCover(video, dst, { title, subtitle, atSeconds = 1 } = {}) {
  const rawTitle = String(title || '').slice(0, 24);
  const titleA = drawTextEscape(rawTitle.slice(0, 12));
  const titleB = drawTextEscape(rawTitle.slice(12));
  const secondary = drawTextEscape(String(subtitle || '').slice(0, 28));
  const font = 'C\\:/Windows/Fonts/msyh.ttc';
  const filter = [
    "scale=720:1280:force_original_aspect_ratio=increase",
    'crop=720:1280',
    'drawbox=x=0:y=0:w=iw:h=ih:color=black@0.12:t=fill',
    'drawbox=x=0:y=h-410:w=iw:h=410:color=black@0.58:t=fill',
    `drawtext=fontfile='${font}':text='${titleA}':fontcolor=white:fontsize=48:x=42:y=h-340:shadowcolor=black@0.75:shadowx=2:shadowy=3`,
    ...(titleB ? [`drawtext=fontfile='${font}':text='${titleB}':fontcolor=white:fontsize=48:x=42:y=h-270:shadowcolor=black@0.75:shadowx=2:shadowy=3`] : []),
    `drawtext=fontfile='${font}':text='${secondary}':fontcolor=0xFFD7A3:fontsize=27:x=45:y=h-180:shadowcolor=black@0.75:shadowx=2:shadowy=2`,
    "drawtext=fontfile='C\\:/Windows/Fonts/msyh.ttc':text='DabaoDB · 短视频方案':fontcolor=white@0.72:fontsize=18:x=45:y=h-115",
  ].join(',');
  const r = await run('ffmpeg', ['-y', '-v', 'error', '-ss', String(atSeconds), '-i', video,
    '-frames:v', '1', '-vf', filter, '-q:v', '2', dst]);
  return r.code === 0 && exists(dst) ? dst : null;
}

/** ffmpeg concat 拼接多镜成片 */
async function concatVideos(files, outFile, workDir) {
  const listFile = path.join(workDir, 'concat-list.txt');
  const body = files.map((f) => `file '${f.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n');
  await fsp.writeFile(listFile, body + '\n', 'utf8');
  const r = await run('ffmpeg', ['-y', '-v', 'error', '-f', 'concat', '-safe', '0',
    '-i', listFile, '-c', 'copy', outFile]);
  if (r.code === 0 && exists(outFile)) return { ok: true, out: outFile };
  const r2 = await run('ffmpeg', ['-y', '-v', 'error', '-f', 'concat', '-safe', '0',
    '-i', listFile, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-c:a', 'aac', outFile]);
  return { ok: r2.code === 0 && exists(outFile), out: outFile, log: r2.out };
}

/** 读 hermes 的 .env（Key 只从后端读，不进前端） */
function readHermesEnv() {
  const file = process.env.HERMES_ENV_FILE ||
    path.join(HOME, 'AppData', 'Local', 'hermes', '.env');
  const out = {};
  if (!exists(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

function fmtSize(bytes) {
  if (!bytes) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0, n = bytes;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${u[i]}`;
}

function nowIso() { return new Date().toISOString(); }
function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

module.exports = {
  HOME, run, runStream, extractJson, looseJson, ensureDir, safeName, exists,
  ffprobeMeta, shrinkImage, grabThumb, makeCover, concatVideos, readHermesEnv, fmtSize,
  nowIso, stamp, decode,
};
