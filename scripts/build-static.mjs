// 把场景直接内嵌进 public/index.html，产出一个双击就能看的静态页。
// 这样不需要常驻服务、不占端口，也不用管沙箱收子进程。
// 用法：ELECTRON_RUN_AS_NODE=1 Coopanion.exe scripts/build-static.mjs [输出文件名]
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadCoo, groupRules } from '../src/coo-adapt.mjs';
import { buildCooSea } from '../src/sea.mjs';
import { renderStaticPage } from '../src/static-page.mjs';
import { FORGET_DEFAULTS, strengthOf } from '../src/forgetting.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const outName = process.env.OUT || process.argv[2] || 'memory-sea.html';
// OUT 允许给绝对路径（桌面上的快捷脚本就靠这个把产物直接写到桌面）
const outFile = path.isAbsolute(outName) ? outName : path.join(root, outName);

const knobs = {
  ...FORGET_DEFAULTS,
  enabled: process.env.FORGET !== '0',
  ...(process.env.FLOOR ? { floor: Number(process.env.FLOOR) } : {}),
  ...(process.env.HALF_SCALE ? { halfScale: Number(process.env.HALF_SCALE) } : {}),
  ...(process.env.HALF_CURVE ? { halfCurve: Number(process.env.HALF_CURVE) } : {}),
  ...(process.env.TRIVIAL_CAP ? { trivialCap: Number(process.env.TRIVIAL_CAP) } : {}),
  ...(process.env.TRIVIAL_BELOW ? { trivialBelow: Number(process.env.TRIVIAL_BELOW) } : {}),
  ...(groupRules.fadeImportanceCap ? { fadeCap: Number(groupRules.fadeImportanceCap) } : {}),
};

const data = loadCoo();
const scene = buildCooSea({ data, knobs });

const shell = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const html = renderStaticPage(shell, scene);

fs.writeFileSync(outFile, html, 'utf8');

const kb = (n) => `${Math.round((n / 1024) * 10) / 10} KB`;
const f = scene.forget;
console.log(`[memsea-coo] 写出 ${path.basename(outFile)}（${kb(Buffer.byteLength(html))}）`);
console.log(
  `[memsea-coo] 点 ${scene.stats.total} · 线 ${scene.stats.edges} · 长期记忆 ${data.stats.longTerm} · 消息 ${data.stats.messages} · 日记 ${data.stats.diaries}`,
);
console.log(`[memsea-coo] 遗忘：${f.collected} 条里留下 ${f.kept}，忘掉 ${f.dropped}` + (f.dropped ? `（时间到 ${f.aged} · 装不下 ${f.capacity}；${Object.entries(f.byProto).map(([k, v]) => `${k} ${v}`).join(' · ')}）` : ''));
const dup = data.stats.duplicates;
console.log(
  `[memsea-coo] 去重：消息 ${data.stats.messagesBeforeDedupe} → ${data.stats.messages}` +
    `（同源重复 ${dup.sameSource} · 跨源重复 ${dup.crossSource}）`,
);
if (dup.examples.length) {
  console.log('[memsea-coo] 被合并的（前几条）：');
  for (const item of dup.examples) console.log(`           ${item.reason} · ${item.text}`);
}
if (f.examples.length) {
  console.log('[memsea-coo] 这轮忘掉的（前几条）：');
  for (const e of f.examples) console.log(`           ${e.reason === 'aged' ? '时间到' : '装不下'} · ${e.days} 天前 · 强度 ${e.strength} · ${e.proto} · ${e.text}`);
}
console.log(`[memsea-coo] 遗忘参数：${knobs.enabled ? '开' : '关'} · 门槛 ${knobs.floor} · 半衰期 ${knobs.halfScale}·e^(${knobs.halfCurve}×重要度) 天`);
const echoInfo = f.echoes;
console.log(
  `[memsea-coo] 回声：${echoInfo.revived} 条被后来的话复述过，共 ${echoInfo.totalMentions} 次` +
    (echoInfo.top.length ? `（最多的一条被提了 ${echoInfo.top[0].hits} 次）` : ''),
);

// 往后看：这个曲线在未来 1 天 / 3 天还会淡出多少（证明它在动，而不是一次性删）
if (knobs.enabled) {
  const now = Date.now();
  const willFade = (days) =>
    scene.points.filter((p) => {
      const echo = p.forget?.hits ? { hits: p.forget.hits, lastMentionAt: p.forget.revivedAt } : null;
      return strengthOf(p, p.forget?.importance ?? 0.4, now + days * 86_400_000, knobs, echo).strength < knobs.floor;
    }).length;
  console.log(`[memsea-coo] 接下来会淡出：24 小时内 ${willFade(1)} 条 · 3 天内 ${willFade(3)} 条（按现在这组记忆算）`);
}
console.log(`[memsea-coo] 来源 ${data.stats.home}（只读，最近 ${data.stats.days} 天）`);

// OPEN=1 时顺手用默认浏览器打开（双击「刷新记忆海.cmd」就是这条路）
if (process.env.OPEN === '1') {
  execFile('cmd.exe', ['/c', 'start', '', outFile], { windowsHide: true }, () => {});
}
