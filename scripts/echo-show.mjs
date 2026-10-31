// 看看回声具体命中了哪些记忆、被谁在哪天提起。
import { loadCoo } from '../src/coo-adapt.mjs';
import { collectPoints, pointFromDiary, MIND_SEA_DEFAULTS } from '../src/mind-sea.js';
import { inferEchoes } from '../src/echo.mjs';

const data = loadCoo();
const cfg = { ...MIND_SEA_DEFAULTS, textMax: 160 };
const points = [
  ...collectPoints({ longTerm: data.longTerm, messages: data.messages, cfg }),
  ...data.diaries.map((d) => pointFromDiary(d, { cfg, fullText: true, time: '23:30' })),
].filter(Boolean).sort((a, b) => a.t - b.t);

const echoes = inferEchoes(points);
const byId = new Map(points.map((p) => [p.id, p]));
const fmt = (t) => new Date(t).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });

console.log(`候选对 ${echoes.stats.candidates} · 判为重复跳过 ${echoes.stats.duplicates} · 算作提及 ${echoes.stats.mentions}\n`);
const rows = [...echoes.entries()].sort((a, b) => b[1].hits - a[1].hits);
console.log(`被复述过的记忆 ${rows.length} 条：\n`);
for (const [id, entry] of rows) {
  const point = byId.get(id);
  console.log(`「${point.text.slice(0, 46)}」`);
  console.log(`   首次 ${fmt(point.t)} · 被提 ${entry.hits} 次 · 最后一次 ${fmt(entry.lastMentionAt)}`);
  for (const mention of entry.mentions) console.log(`     ← ${fmt(mention.t)} (${mention.sim}) ${mention.text}`);
  console.log('');
}
