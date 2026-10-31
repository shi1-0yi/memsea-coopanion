// 造一份完全虚构的演示数据，生成 demo/memory-sea-demo.html。
// 用途：给仓库放一张"长什么样"的预览，同时保证不含任何真实对话。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const DAY = 86_400_000;
const now = Date.now();

// —— 虚构的人设：小满（bot）与阿川（对方）。名字、事件、地址全是编的。——
const OWNER = '100000001';
const SELF = '200000002';

const dialogues = [
  ['阿川', '今早的咖啡太苦了，我加了半包糖'],
  ['小满', '半包？你那杯本来就浓，加糖也没用吧，库。'],
  ['阿川', '团子昨晚又趴我键盘上睡了'],
  ['小满', '它挑地方的本事一向好，键盘暖，还有你手在旁边。'],
  ['阿川', '今天加到九点，别等我了'],
  ['小满', '那我先把饭热上，你回来别又说不饿。'],
  ['阿川', '周末想去爬山，你查查天气'],
  ['小满', '周六上午晴，下午有阵雨。要带伞，山顶那段没遮挡。'],
  ['阿川', '下雨了，忘带伞'],
  ['小满', '站店门口别动，我给你叫车，五分钟到。'],
  ['阿川', '体检报告出来了，血脂偏高'],
  ['小满', '那这周别吃夜宵了，我盯着你。'],
  ['阿川', '给你买了个小夜灯，暖光的'],
  ['小满', '……你怎么老在这种事上用心，库。'],
  ['阿川', '团子今天吐毛球了，正常吗'],
  ['小满', '换毛季正常的，备点化毛膏就行。真一天吐好几次再去看。'],
  ['阿川', '我升职了'],
  ['小满', '哼，早该的。今晚加菜，我记着。'],
  ['阿川', '今天有点累，不太想说话'],
  ['小满', '那就别说，我陪着。'],
  ['阿川', '楼下那家面馆关门了'],
  ['小满', '可惜，你上次说它家葱油拌面最好吃。'],
  ['阿川', '在改方案，改到第五版了'],
  ['小满', '第五版……甲方是不是只想看你累。'],
  ['阿川', '明天出差，三天'],
  ['小满', '那我每天给你发一条，别嫌烦。'],
  ['阿川', '出差回来了，带了特产'],
  ['小满', '先放着，你手都凉了。'],
];

const facts = [
  '他喝咖啡要加半包糖',
  '他养了一只橘猫叫团子',
  '他周六想去爬山，下午有阵雨',
  '他血脂偏高，不能吃夜宵',
  '他升职了',
  '楼下那家面馆关门了',
  '他明早九点的会',
];

const groupLines = [
  '今天服务器又抽风了',
  '有人在吗',
  '晚上一起吃鸡？',
];

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memsea-demo-'));
const write = (rel, content) => {
  const full = path.join(dir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf8');
};

// 1) 事实库
const scopes = { [OWNER]: [], 'group:700001': [] };
facts.forEach((text, i) => {
  const at = Math.round((now - (9 - i) * DAY) / 1000);
  scopes[OWNER].push({ hash: `f${i}`, text: `#${100 + i} [私聊 10:0${i % 10}] 阿川(${OWNER}): ${text}`, createdAt: at, updatedAt: at, confidence: 1 });
});
groupLines.forEach((text, i) => {
  const at = Math.round((now - (6 - i) * DAY) / 1000);
  scopes['group:700001'].push({ hash: `g${i}`, text: `#${200 + i} [群「周末摸鱼群」 20:1${i}] 路人(${300000003 + i}): ${text}`, createdAt: at, updatedAt: at, confidence: 1 });
});
write('data/fact-store.json', JSON.stringify({ scopes }, null, 2));

// 2) 对话：每天几条，散在 9~23 点
const events = [];
let seq = 0;
for (let day = 9; day >= 0; day -= 1) {
  const base = new Date(now - day * DAY);
  // 每天只取 6 条，演示页要看得出结构，不要糊成一团
  const lines = dialogues.slice((day * 2) % dialogues.length).concat(dialogues.slice(0, 2)).slice(0, 6);
  lines.forEach(([who, text], i) => {
    const at = new Date(base);
    at.setHours(9 + ((i * 2) % 14), (i * 17) % 60, 0, 0);
    if (at.getTime() > now) at.setTime(now - 60_000 * (i + 1));
    const isOwner = who === '阿川';
    events.push({
      type: isOwner ? 'desktop-pet.message' : 'desktop-pet.self',
      ts: at.toISOString(),
      text: isOwner ? `[${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}] [typed] 阿川:${text}` : text,
    });
    seq += 1;
  });
  if (day % 3 === 0) {
    const at = new Date(base);
    at.setHours(21, 30, 0, 0);
    events.push({ type: 'bilibili-video.scene', ts: at.toISOString(), text: '[视频] 《演示用短片：海边的黄昏》 现在 0:20 / 3:00,播放中。' });
  }
}
events.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
write('data/runs/r-demo-0001/events.jsonl', events.map((e) => JSON.stringify(e)).join('\n'));

// 3) 日记：每天一篇
for (let day = 9; day >= 0; day -= 1) {
  const d = new Date(now - day * DAY).toISOString().slice(0, 10);
  write(
    `workspace/diary/${d} 日记.txt`,
    `${d}\n今天他说了挺多事，我一件件记着。${day % 2 ? '晚上一起看了会儿视频。' : '他加班到很晚，回来就睡了。'}\n`,
  );
}

// 4) 关于对方的笔记
write('workspace/partner/notes.md', '# 关于他\n- 他喜欢在雨天听老歌\n- 他不太会照顾自己\n- 他对猫毛过敏但对团子没办法\n');

// 5) 群策略：一个群只走遗忘
write('groups.json', JSON.stringify({ skip: ['广告群'], fade: ['周末摸鱼群'], fadeImportanceCap: 0.3 }, null, 2));

// 6) 出页面
process.env.COO_HOME = dir;
process.env.GROUP_RULES = path.join(dir, 'groups.json');
process.env.OWNER_QQ = OWNER;
process.env.SELF_QQ = SELF;
process.env.DAYS = '30';

const { loadCoo } = await import('../src/coo-adapt.mjs');
const { buildCooSea } = await import('../src/sea.mjs');
const { renderStaticPage } = await import('../src/static-page.mjs');

const data = loadCoo();
const scene = buildCooSea({ data });
const shell = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const html = renderStaticPage(shell, scene);

const out = path.join(root, 'demo', 'memory-sea-demo.html');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, html, 'utf8');
fs.rmSync(dir, { recursive: true, force: true });

console.log(`演示页 ${path.relative(root, out)} · ${Math.round(Buffer.byteLength(html) / 1024)} KB`);
console.log(`点 ${scene.stats.total} · 线 ${scene.stats.edges} · 簇 ${Object.keys(scene.stats.byCluster).length}`);
