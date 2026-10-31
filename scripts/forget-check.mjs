// 看一眼各来源的年龄分布与强度，好把遗忘曲线调到位。只算不画。
import { loadCoo } from '../src/coo-adapt.mjs';
import { collectPoints, pointFromDiary, MIND_SEA_DEFAULTS } from '../src/mind-sea.js';
import { strengthOf, halfLifeDays } from '../src/forgetting.mjs';

const data = loadCoo();
const cfg = { ...MIND_SEA_DEFAULTS, textMax: 160 };
const points = [
  ...collectPoints({ longTerm: data.longTerm, messages: data.messages, cfg }),
  ...data.diaries.map((d) => pointFromDiary(d, { cfg, fullText: true, time: '23:30' })),
].filter(Boolean);

const now = Date.now();
const byProto = new Map();
for (const point of points) {
  const hint = data.hints[point.id] ?? { proto: 'unknown', importance: 0.4 };
  const scored = strengthOf(point, hint.importance, now);
  const row = byProto.get(hint.proto) ?? { n: 0, ages: [], strengths: [], halves: [] };
  row.n += 1;
  row.ages.push(scored.ageDays);
  row.strengths.push(scored.strength);
  row.halves.push(scored.halfLifeDays);
  byProto.set(hint.proto, row);
}

const stat = (list, p) => {
  const s = [...list].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
};

console.log('来源      条数   年龄(天) 中位/最大   强度 中位/最低   半衰期(天)');
for (const [proto, row] of [...byProto.entries()].sort((a, b) => b[1].n - a[1].n)) {
  console.log(
    `${proto.padEnd(9)} ${String(row.n).padStart(4)}   ${stat(row.ages, 0.5).toFixed(1)} / ${Math.max(...row.ages).toFixed(1)}`.padEnd(28) +
      `${stat(row.strengths, 0.5).toFixed(3)} / ${Math.min(...row.strengths).toFixed(3)}`.padEnd(18) +
      `${stat(row.halves, 0.5).toFixed(1)}`,
  );
}

console.log('\n不同门槛下会忘掉多少（按当前时间）：');
for (const floor of [0.04, 0.06, 0.08, 0.1, 0.12]) {
  const dropped = {};
  for (const point of points) {
    const hint = data.hints[point.id] ?? { proto: 'unknown', importance: 0.4 };
    if (strengthOf(point, hint.importance, now).strength < floor) dropped[hint.proto] = (dropped[hint.proto] ?? 0) + 1;
  }
  const total = Object.values(dropped).reduce((a, b) => a + b, 0);
  console.log(`  门槛 ${floor.toFixed(2)} → 忘 ${String(total).padStart(3)} 条  ${JSON.stringify(dropped)}`);
}
console.log(`\n（当前默认：半衰期 = 0.9·e^(4.2·重要度) 天）`);
