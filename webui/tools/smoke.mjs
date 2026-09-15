// 联调脚本：上传素材 → 提交任务 → 轮询进度（不涉及任何 UI）
import fs from 'node:fs';
import path from 'node:path';

const BASE = 'http://localhost:8899';
const PROJ = 'D:/@kaifa/DabaoDB/projects/DabaoDB';

async function upload(kind, file) {
  const buf = fs.readFileSync(file);
  const res = await fetch(`${BASE}/api/upload?kind=${kind}&name=${encodeURIComponent(path.basename(file))}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: buf,
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`${file}: ${json.error || res.status}`);
  console.log(`  ↑ ${kind} ${json.name} ${json.sizeText}`);
  return json.path;
}

const ref = await upload('ref', `${PROJ}/refs/anhui-lejie-ref.mp4`);
const img1 = await upload('product', `${PROJ}/assets/product-45.jpg`);
const img2 = await upload('product', `${PROJ}/assets/product-folded.jpg`);
const img3 = await upload('product', `${PROJ}/assets/product-logo.jpg`);

const body = {
  productName: '爱优护轻便侠218',
  learn: { narration: true, dialogue: false, tone: true, speed: true, style: true, realLogo: true },
  spec: { model: 'mini', resolution: '720p', aspect: '9:16', shots: 1, shotDuration: 15, audio: true },
  refVideo: ref,
  productImages: [img1, img2, img3],
};
const r = await fetch(`${BASE}/api/start`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
const start = await r.json();
if (!r.ok) { console.log('提交失败：', start); process.exit(1); }
console.log(`\n任务已提交 id=${start.id}\n`);

let last = 0;
const t0 = Date.now();
while (Date.now() - t0 < 8 * 60 * 1000) {
  await new Promise((r) => setTimeout(r, 4000));
  const j = await (await fetch(`${BASE}/api/jobs/${start.id}`)).json();
  const job = j.job;
  console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s] ${job.status} ${job.progress}% · ${job.stageName || ''}`);
  for (const l of j.logs.slice(last)) console.log(`    ${l.level.padEnd(5)} [${l.stage}] ${l.text}`);
  last = j.logs.length;
  if (job.status === 'done' || job.status === 'failed' || job.status === 'cancelled') {
    console.log('\n最终状态：', job.status, job.error || '');
    console.log('成片：', job.outputPath || '(演练模式无成片)');
    break;
  }
}
