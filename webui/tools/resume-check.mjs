// 验证：对失败任务按「续跑」→ 看它是否复用产物、自动剔除含真人图、并跑完整条线
const BASE = 'http://localhost:8899';

const boot = await (await fetch(`${BASE}/api/bootstrap`)).json();
console.log('历史任务：');
for (const j of boot.history) {
  console.log(`  ${j.id} ${j.status} ${j.productName || ''} ${j.resumeFrom ? '（续跑自 ' + j.resumeFrom + '）' : ''}`);
}
const target = process.argv[2] || boot.history.find((j) => j.status === 'failed')?.id;
if (!target) { console.log('没有失败任务可续跑'); process.exit(0); }
console.log(`\n续跑目标：${target}`);

const r = await fetch(`${BASE}/api/jobs/${target}/resume`, { method: 'POST' });
const res = await r.json();
console.log('续跑响应：', JSON.stringify(res));
if (!r.ok) process.exit(1);
const id = res.id;

let last = 0;
const t0 = Date.now();
while (Date.now() - t0 < 40 * 60 * 1000) {
  await new Promise((r) => setTimeout(r, 5000));
  const j = await (await fetch(`${BASE}/api/jobs/${id}`)).json();
  const job = j.job;
  const mins = ((Date.now() - t0) / 60000).toFixed(1);
  console.log(`[${mins}min] ${job.status} ${job.progress}% · ${job.stageName || ''}`);
  for (const l of j.logs.slice(last)) {
    if (l.raw) continue;
    console.log(`    ${l.level} [${l.stage}] ${l.text}`);
  }
  last = j.logs.length;
  if (['done', 'failed', 'cancelled'].includes(job.status)) {
    console.log('\n最终：', job.status, '| 成片:', job.outputPath || '无', '| 错误:', job.error || '无');
    break;
  }
}
