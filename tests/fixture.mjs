// 造一个假的 Coopanion 部署目录，用来跑测试。全部内容都是虚构的。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DAY = 86_400_000;
const now = Date.now();
const ago = (days) => new Date(now - days * DAY);
const sec = (days) => Math.round((now - days * DAY) / 1000);
const iso = (days) => ago(days).toISOString();

/** 造目录：data/ 与 workspace/ 的最小可用结构 */
export function makeFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memsea-test-'));

  // 1) 事实库：主人的私聊、两个群
  const factStore = {
    scopes: {
      '111111111': [
        {
          hash: 'f1',
          text: '#100 [私聊 10:00] 主人(111111111): 我对芒果过敏',
          createdAt: sec(4),
          updatedAt: sec(4),
          confidence: 1,
        },
      ],
      'group:900001': [
        // 会被 skip 的群
        {
          hash: 'g1',
          text: '#200 [群「广告群」 12:00] 主人(111111111): 今天买它',
          createdAt: sec(2),
          updatedAt: sec(2),
          confidence: 1,
        },
      ],
      'group:900002': [
        // 只走遗忘栏的群
        {
          hash: 'g2',
          text: '#201 [群「闲聊群」 12:00] 我(222222222): 今天群里好安静',
          createdAt: sec(3),
          updatedAt: sec(3),
          confidence: 1,
        },
      ],
    },
  };
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'data', 'fact-store.json'), JSON.stringify(factStore, null, 2), 'utf8');

  // 2) 运行日志：一条气泡、一条 QQ、一条会被去重的重复、一条视频
  const run = 'r-test-0001';
  const runDir = path.join(dir, 'data', 'runs', run);
  fs.mkdirSync(runDir, { recursive: true });
  const events = [
    { type: 'desktop-pet.self', ts: iso(0.04), text: '喂，我在呢，库。' },
    {
      type: 'qq.self',
      ts: iso(0.05),
      text: '#300 [私聊 09:00] 你: 我对芒果过敏，别买芒果',
    },
    // 同一条话在一分钟后又出现一次：应该被去重掉
    {
      type: 'qq.self',
      ts: iso(0.04),
      text: '#300 [私聊 09:00] 你: 我对芒果过敏，别买芒果',
    },
    { type: 'bilibili-video.scene', ts: iso(0.1), text: '[视频] 《测试用视频标题》 现在 0:10 / 1:00,播放中。' },
    // 界面动作提示，应该被忽略
    { type: 'desktop-pet.self', ts: iso(0.1), text: '做了:end_turn', meta: { kind: 'activity' } },
  ];
  fs.writeFileSync(path.join(runDir, 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n'), 'utf8');

  // 3) 日记与笔记
  const today = new Date(now).toISOString().slice(0, 10);
  fs.mkdirSync(path.join(dir, 'workspace', 'diary'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'workspace', 'diary', `${today} 日记.txt`),
    `${today}\n今天他给我买了一杯奶茶，我说太甜了。\n`,
    'utf8',
  );
  fs.mkdirSync(path.join(dir, 'workspace', 'partner'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'workspace', 'partner', 'notes.md'), '# 笔记\n- 他喜欢猫\n', 'utf8');
  fs.mkdirSync(path.join(dir, 'workspace', 'log'), { recursive: true });
  const ym = today.slice(0, 7);
  fs.writeFileSync(
    path.join(dir, 'workspace', 'log', `${ym}.md`),
    `# ${ym}\n\n## ${today.slice(5)}\n- 09:00 早上聊了两句，他今天要上班。\n`,
    'utf8',
  );

  // 4) 群策略：一个整群不要，一个只遗忘
  const rules = path.join(dir, 'groups.json');
  fs.writeFileSync(
    rules,
    JSON.stringify({ skip: ['广告群'], fade: ['闲聊群'], fadeImportanceCap: 0.3 }, null, 2),
    'utf8',
  );

  return { dir, rules, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
