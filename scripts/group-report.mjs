// 把所有跟群有关的记忆列成表：进海的、被时间忘掉的、以及根本没让进海的群友消息。
// 只读 Coopanion 的记忆目录，只写两个文件（md + csv）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCoo, parseFact, classifyEntry, policyOf } from '../src/coo-adapt.mjs';
import { collectPoints, pointFromDiary, MIND_SEA_DEFAULTS } from '../src/mind-sea.js';
import { applyForgetting, strengthOf, FORGET_DEFAULTS } from '../src/forgetting.mjs';

const HOME = process.env.COO_HOME || '';
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const WHO = {
  'group-owner': '主人在群里',
  'self-group': '她（群里发言）',
  self: '她（私聊）',
  group: '群友',
  private: '主人私聊',
  log: '她的月志',
  note: '主人笔记',
  diary: '日记',
};

const pad = (n) => String(n).padStart(2, '0');
const fmt = (t) => {
  const d = new Date(t);
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const cell = (text, max = 60) => {
  const clean = String(text).replace(/\|/g, '｜').replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
};
const csv = (row) => row.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',');

const data = loadCoo();
const cfg = { ...MIND_SEA_DEFAULTS, textMax: 160 };
const points = [
  ...collectPoints({ longTerm: data.longTerm, messages: data.messages, cfg }),
  ...data.diaries.map((d) => pointFromDiary(d, { cfg, fullText: true, time: '23:30' })),
].filter(Boolean);

const { kept, dropped } = applyForgetting(points, data.hints);
const status = new Map();
for (const point of kept) status.set(point.id, '在');
for (const item of dropped) status.set(item.point.id, item.reason === 'aged' ? '时间到' : '装不下');

const now = Date.now();
const rows = [];
for (const point of points) {
  const hint = data.hints[point.id] ?? {};
  if (hint.scene !== 'group') continue;
  const rawImp = hint.importance ?? 0.4;
  const imp = hint.fade ? Math.min(rawImp, FORGET_DEFAULTS.fadeCap) : rawImp;
  const scored = strengthOf(point, imp, now, FORGET_DEFAULTS);
  rows.push({
    t: point.t,
    time: fmt(point.t),
    group: hint.group || '（未记群名）',
    policy: hint.fade ? '慢慢遗忘' : '保留',
    who: WHO[hint.proto] ?? hint.proto,
    text: point.text,
    importance: imp,
    half: Math.round(scored.halfLifeDays * 10) / 10,
    strength: Math.round(scored.strength * 1000) / 1000,
    state: status.get(point.id) ?? '未进海',
  });
}
rows.sort((a, b) => b.t - a.t);

// —— 没进海的：按群策略挡掉的 + 群友的话 ——
const store = JSON.parse(fs.readFileSync(path.join(HOME, 'data', 'fact-store.json'), 'utf8'));
const skippedByGroup = new Map();
const filteredByGroup = new Map();
const bump = (map, name, text) => {
  const bucket = map.get(name) ?? { n: 0, samples: [] };
  bucket.n += 1;
  if (bucket.samples.length < 2 && text.length > 8) bucket.samples.push(text);
  map.set(name, bucket);
};
for (const [scope, entries] of Object.entries(store.scopes ?? {})) {
  if (!Array.isArray(entries)) continue;
  for (const item of entries) {
    const parsed = parseFact(item?.text);
    if (!parsed) continue;
    const cls = classifyEntry(scope, parsed);
    if (cls.system) continue;
    const name = cls.group || `群 ${scope}`;
    if (cls.scene === 'group' && policyOf(cls.group) === 'skip') bump(skippedByGroup, name, parsed.text);
    else if (cls.proto === 'group') bump(filteredByGroup, name, parsed.text);
  }
}

const byWho = {};
for (const row of rows) byWho[row.who] = (byWho[row.who] ?? 0) + 1;
const byGroup = {};
for (const row of rows) byGroup[row.group] = (byGroup[row.group] ?? 0) + 1;
const filteredTotal = [...filteredByGroup.values()].reduce((a, b) => a + b.n, 0);
const skippedTotal = [...skippedByGroup.values()].reduce((a, b) => a + b.n, 0);

const out = [];
out.push('# 群记忆清单');
out.push('');
out.push(`数据源：\`${HOME}\`（只读）· 生成于 ${new Date().toLocaleString('zh-CN')}`);
out.push('');
out.push('## 概览');
out.push('');
out.push(`- 进表的群记忆：**${rows.length}** 条（其中在 ${rows.filter((r) => r.state === '在').length} · 被遗忘 ${rows.filter((r) => r.state !== '在').length}）`);
out.push(`- 按说话人：${Object.entries(byWho).map(([k, v]) => `${k} ${v}`).join(' · ')}`);
out.push(`- 涉及 ${Object.keys(byGroup).length} 个群`);
out.push(`- 按群策略挡掉 **${skippedTotal}** 条（整群不要）；另有 **${filteredTotal}** 条群友消息没进海（SCOPE=owner）`);
out.push('');
out.push('## 表 1：跟群有关的记忆（按时间倒序）');
out.push('');
out.push('| 时间 | 哪个群 | 策略 | 谁 | 内容 | 重要度 | 半衰期(天) | 强度 | 状态 |');
out.push('|---|---|---|---|---|---|---|---|---|');
for (const row of rows) {
  out.push(`| ${row.time} | ${cell(row.group, 22)} | ${row.policy} | ${row.who} | ${cell(row.text, 50)} | ${row.importance} | ${row.half} | ${row.strength} | ${row.state} |`);
}
out.push('');
out.push('## 表 2：按你的设置没进海的');
out.push('');
out.push('| 群 | 条数 | 原因 | 样本 |');
out.push('|---|---|---|---|');
for (const [name, bucket] of [...skippedByGroup.entries()].sort((a, b) => b[1].n - a[1].n)) {
  out.push(`| ${cell(name, 30)} | ${bucket.n} | 整群不要 | ${cell(bucket.samples[0] ?? '', 40)} |`);
}
for (const [name, bucket] of [...filteredByGroup.entries()].sort((a, b) => b[1].n - a[1].n)) {
  out.push(`| ${cell(name, 30)} | ${bucket.n} | 群友的话 | ${cell(bucket.samples[0] ?? '', 40)} |`);
}
out.push('');
out.push('> 策略在 `groups.json` 里改：`skip` 整群不要，`fade` 进海但只走遗忘栏（重要度压到 `fadeImportanceCap`）。');
out.push('> 「强度」= 重要度 × 0.5^(放了几天/半衰期)，低于 0.07 就忘掉。');

fs.writeFileSync(path.join(root, '群记忆清单.md'), out.join('\n') + '\n', 'utf8');
fs.writeFileSync(
  path.join(root, '群记忆清单.csv'),
  '\uFEFF' + [['时间', '哪个群', '策略', '谁', '内容', '重要度', '半衰期天', '强度', '状态'], ...rows.map((r) => [r.time, r.group, r.policy, r.who, r.text, r.importance, r.half, r.strength, r.state])].map(csv).join('\r\n'),
  'utf8',
);

console.log(`群记忆 ${rows.length} 条（在 ${rows.filter((r) => r.state === '在').length} · 遗忘 ${rows.filter((r) => r.state !== '在').length}）`);
console.log(`按人：${Object.entries(byWho).map(([k, v]) => `${k} ${v}`).join(' · ')}`);
console.log(`群个数：${Object.keys(byGroup).length}；按策略挡掉 ${skippedTotal} 条；群友的话 ${filteredTotal} 条`);
console.log('按群：' + Object.entries(byGroup).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(' · '));
