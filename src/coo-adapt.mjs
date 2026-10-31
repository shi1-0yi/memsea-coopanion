// 把 Coopanion 里 bot 的记忆目录读成 memory-sea 要的三段数组：
//   longTerm ← data/fact-store.json（事实库） + workspace/partner/*.md（关于主人的笔记）
//   messages ← workspace/handoffs/*.md（真实私聊原文） + workspace/log/*.md（她自己的月志）
//   diaries  ← workspace/diary/*.txt（她写的日记）
//
// 只读。不写、不改 Coopanion 的任何文件，也不产生任何副作用。
// 每条记录额外带一份 hints（来源 + 重要度），交给 forgetting.mjs 决定"记多久"。
//
// 环境变量：
//   COO_HOME  部署目录（必填），例如 D:/Coopanion/data/home/<部署名>
//   DAYS      只看最近多少天，默认 30
//   LT_MAX    长期记忆最多取多少条，默认 1200
//   SCOPE     owner（默认，只留和主人有关的）/ all（群友的也收）
//   OWNER_QQ  主人（对方）的 QQ 号，可选
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { guessTopic } from './mind-sea.js';
import { dedupeMemories } from './dedupe.mjs';
import { readRunEvents } from './runs.mjs';

const HOME = process.env.COO_HOME || ''; // 必填：Coopanion 的部署目录
const DAYS = Number(process.env.DAYS || 30);
const LT_MAX = Number(process.env.LT_MAX || 1200);
const SCOPE = (process.env.SCOPE || 'owner').toLowerCase();
const OWNER_QQ = process.env.OWNER_QQ || ''; // 你的 QQ；填了才按只留她和他过滤
const SELF_QQ = process.env.SELF_QQ || ''; // bot 自己的 QQ

// 读完一轮的计数，给 stats 用
const COUNTS = { system: 0, skippedByGroup: 0, filteredOthers: 0 };

// —— 群策略：哪个群整个不要、哪个群只走"慢慢遗忘" ——
// 配置文件默认是项目根目录的 groups.json，可以用 GROUP_RULES 指向别处。
const RULES_FILE = process.env.GROUP_RULES || fileURLToPath(new URL('../groups.json', import.meta.url));
const RULES = readJson(RULES_FILE) ?? {};
const normGroup = (name) => String(name ?? '').replace(/[｜|]/g, '|').replace(/\s+/g, '').toLowerCase();
const SKIP_GROUPS = (RULES.skip ?? []).map(normGroup).filter(Boolean);
const FADE_GROUPS = (RULES.fade ?? []).map(normGroup).filter(Boolean);

/** 这个群怎么处理：skip = 整群不要；fade = 进海但只按遗忘栏衰减；keep = 正常。 */
export function policyOf(group) {
  const name = normGroup(group);
  if (!name) return 'keep';
  if (SKIP_GROUPS.some((rule) => name.includes(rule))) return 'skip';
  if (FADE_GROUPS.some((rule) => name.includes(rule))) return 'fade';
  return 'keep';
}

// 用函数声明而不是 const 箭头：上面的 RULES 要在模块初始化时就调用 readJson（会撞 TDZ）
function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}
function readJson(file) {
  try {
    return JSON.parse(readText(file));
  } catch {
    return null;
  }
}
function listFiles(dir, filter) {
  try {
    return fs.readdirSync(dir).filter(filter).map((name) => path.join(dir, name));
  } catch {
    return [];
  }
}
/** 事实库里的时间戳是秒（1793016713.85），统一换成毫秒。 */
const toMs = (value) => {
  const n = Number(value) || 0;
  return n > 0 && n < 1e12 ? Math.round(n * 1000) : Math.round(n);
};

/** 事实库里一条，前缀形态有好几种（群聊/私聊/转发/带引用）：
 *    #271288509 [私聊 18:49] 主人(123456): 我给你加了个插件…
 *    #2090399157 [群「某服」 00:46] 主人(123456): [图片 …]
 *    某个群友(QQ:654321)：#1489763738 你说啥
 *    某服（群号 100000） 12:06】主人(QQ:123456)：#1482309092 晚上回来截图来得及不
 * 一律按 token 剥：先记下说话人的 QQ（用来判断是不是主人），再把前缀碎片去掉。 */
const SENDER_QQ = /[（(](?:QQ:)?(\d{5,12})[）)]/;
const MEDIA_TAG = /^\[(图片|表情|视频|语音|转发消息|合并转发|文件|动画表情|卡片)/;
// 捕获器里她自己叫「你」，主人叫「哥哥」；这两个词在前缀里，剥掉之前先认
const ROLE_SELF = /\]\s*你\s*[:：]/;
const ROLE_OWNER = /\]\s*(?:哥哥|主人)\s*[:：]/;

function parseFact(raw) {
  const text = String(raw ?? '').trim();
  const head0 = text.slice(0, 120);
  const senderQQ = SENDER_QQ.exec(head0)?.[1] ?? '';
  const role = ROLE_SELF.test(head0) ? 'self' : ROLE_OWNER.test(head0) ? 'owner' : '';
  // 场景标记只能从正文认：scope 名（纯数字 / group:… / bilibili-video）不可靠
  const isGroup = /\[群「|\[群[^\]]{0,40}\s\d{1,2}:\d{2}\]/.test(head0);
  const group = /\[群「([^」]{0,40})」/.exec(head0)?.[1] ?? '';
  const isDM = /\[私聊/.test(head0);
  const typed = /\[typed\]/.test(head0);
  const figure = /\[figure\]/.test(head0);

  // 前缀都在开头这一小段里，正文原样留住
  const head = text.slice(0, 200);
  const tail = text.slice(200);
  const cleaned = head
    .replace(/#\d+\s*/g, ' ') // 消息 id
    .replace(/\[(?:私聊|群)[^\]]{0,90}[\]】]\s*/g, ' ') // [私聊 23:21] / [群「…」 09:13】
    .replace(/\[[^\]]{0,48}[\]】]\s*/g, ' ') // [typed] / [10-30 周五 00:17] / [图片…]
    .replace(/（群号\s*\d+）\s*/g, ' ')
    .replace(/^\s*[^\s:：（(]{1,20}\s*[（(](?:QQ:)?\d{5,12}[）)]\s*[:：]?\s*/, ' ') // 昵称(QQ:123)：整段
    .replace(/^\s*(?:你|哥哥|主人|我)\s*[:：]\s*/, '')
    .replace(/^\s*[^\s:：]{1,16}\s*[:：]\s*/, '') // 昵称: / 你:
    .replace(/[（(](?:QQ:)?\d{5,12}[）)]\s*[:：]?/g, ' ') // 剩下的号码括注
    .replace(/\*\*/g, '')
    .concat(tail);

  const body = cleaned
    .replace(/\[blob [^\]]*\]/g, ' ')
    .replace(/\[reply\]@\d+/g, ' ')
    .replace(/「引用[^」]*」/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (body.length < 4) return null;
  if (MEDIA_TAG.test(body)) return null;
  if (/^\[系统\]/.test(body) || /已加入监听|已从监听移除/.test(body)) return null;
  if (/^#\s*交接笔记/.test(body)) return null; // 交接笔记的片段，不是她记下的事
  if (/^操作员/.test(body)) return null; // 浏览器自动化日志
  if (/你在转发里发的内容|合并转发|\[转发\]/.test(body)) return null; // 合并转发的壳，里面是谁的话都说不清
  if (/（操作者\s*\d+）/.test(body)) return null; // 「xxx 加入（操作者 …）」这类进群/退群回执
  if (/^[：:，,。、；;）)\]]/.test(body)) return null; // 前缀剥完只剩标点，说明本来就是个碎片
  if (body.length < 8 && !/[\u4e00-\u9fa5a-zA-Z]/.test(body)) return null; // 「57)。」这种残渣
  // 看视频的机器日志：画面 6 格 / 弹幕 0:02–0:09 / 播放完了(1:02) 这类，不是她记下的东西
  if (/画面\s*\d+\s*格|[0-9]\s*格\(|弹幕\s*\d+:\d+|播放完了|播放中|已打开视频页/.test(body)) return null;
  return { text: body, qq: senderQQ, role, group, isGroup, isDM, typed, figure };
}

// 这些 scope 装的是系统状态、知识库、视频日志，不是"她经历的事"，整域不进海
const SYSTEM_SCOPES = new Set([
  'bilibili-video', // 看视频的机器日志
  'persona', // 交接笔记碎片
  'qqbot',
  'deepseek-usage',
  'qq', // 引用未捕获之类的系统提示
  'desktop-pet.figure', // 换装状态
  'desktop-pet.voice',
]);
// 戳一戳 / 上下群 这类通知：群里发生的，但不算谁说了什么
const NOTICE = /戳了|拍了拍|加入了群聊|退出了群聊|撤回了一条消息|修改了群名|(加入|退出)群?(（操作者|（邀请人)/;

const KIND_PATTERNS = [
  ['promise', /答应|约好|说好|以后要|一定(要|得)?|必须|记得|别再|下次/],
  ['preference', /喜欢|讨厌|不爱|爱吃|怕|习惯|受不了|最爱/],
];

function kindOf(text) {
  for (const [kind, re] of KIND_PATTERNS) if (re.test(text)) return kind;
  return 'fact';
}

// —— 重要度：决定这条记忆能留多久 ——
// 来源本身就先分了一档（日记 > 关于他的笔记 > 私聊 > 月志 > 群聊），
// 再按内容加减：带情绪和约定的话更牢，公告/群号/链接这类更易散。
const EMOTION = /想你|想死你|喜欢你|爱你|答应|约好|说好|过敏|生日|名字|晚安|抱|亲|心疼|吃醋|生气|害怕|难过|纪念|习惯|回来|别走|等你|陪我/;
const NOISE = /群号|公告|下载|链接|http|管理|\d+倍/;

const IMPORTANCE_BASE = Object.freeze({
  diary: 0.92,
  note: 0.85,
  self: 0.55, // 她自己说的话（私聊里）
  'self-group': 0.42, // 她在群里说的话：比群友值钱，但不如私聊
  log: 0.55, // 她自己写下的月志：比群聊值钱，但不如日记与关于他的笔记
  watch: 0.45, // 每天一条"看了什么"的摘要
  private: 0.5,
  'group-owner': 0.38, // 主人在群里说的话
  group: 0.22, // 群里别人的话
  unknown: 0.35,
});

/** 一条事实记录属于哪个场景、算谁的。**scope 名不可靠**（有 per-person 桶、有 group: 前缀、
 *  还有 bilibili-video 这种知识域），所以场景以正文里的 [群「…」] / [私聊] / [typed] 标记为准。 */
export function classifyEntry(scope, parsed) {
  const s = String(scope);
  if (SYSTEM_SCOPES.has(s)) return { system: true };
  if (parsed.figure) return { system: true };
  if (NOTICE.test(parsed.text)) return { system: true };

  const isGroup = Boolean(parsed.isGroup || s.startsWith('group:'));
  const group = parsed.group || (s.startsWith('group:') ? `群 ${s.slice('group:'.length)}` : '');
  const isSelf = parsed.role === 'self' || (parsed.qq && parsed.qq === SELF_QQ);
  const isOwner = parsed.role === 'owner' || (parsed.qq && parsed.qq === OWNER_QQ);
  let proto;
  if (isSelf) proto = isGroup ? 'self-group' : 'self';
  else if (isOwner) proto = isGroup ? 'group-owner' : 'private';
  else proto = isGroup ? 'group' : 'private';
  if (s === 'main') proto = 'note'; // 这个桶里是她自己写的规矩与设定
  return { system: false, proto, scene: isGroup ? 'group' : 'direct', group, isSelf, isOwner };
}

function importanceOf(proto, text, kind) {
  let imp = IMPORTANCE_BASE[proto] ?? IMPORTANCE_BASE.unknown;
  if (kind === 'promise') imp = Math.max(imp, 0.8);
  if (kind === 'preference') imp = Math.max(imp, 0.7);
  imp += Math.min(0.12, Math.max(0, (text.length - 10) / 500)); // 说得越具体越不像碎话
  if (EMOTION.test(text)) imp += 0.18;
  if (NOISE.test(text)) imp -= 0.12;
  if (text.length < 6) imp -= 0.06;
  return Math.min(1, Math.max(0.05, Math.round(imp * 100) / 100));
}

/** 长期记忆：事实库 + 关于主人的笔记。默认只留她自己记下的、以及和主人有关的。 */
function readLongTerm(cutoff, hints) {
  const out = [];
  const seen = new Set();
  const push = (entry, proto, extra = {}) => {
    if (!entry || entry.t < cutoff) return;
    const key = entry.text.replace(/\s+/g, '').slice(0, 48);
    if (seen.has(key)) return;
    seen.add(key);
    hints[entry.id] = { proto, importance: importanceOf(proto, entry.text, entry.kind), ...extra };
    out.push(entry);
  };

  const store = readJson(path.join(HOME, 'data', 'fact-store.json'));
  const scopes = store?.scopes ?? {};
  let dropped = 0;
  let system = 0;
  let skipped = 0;
  for (const [scope, entries] of Object.entries(scopes)) {
    if (!Array.isArray(entries)) continue;
    for (const item of entries) {
      const parsed = parseFact(item?.text);
      if (!parsed) continue;
      const cls = classifyEntry(scope, parsed);
      if (cls.system) {
        system += 1;
        continue;
      }
      // 你在 groups.json 里标了 skip 的群，整群不要
      const policy = cls.scene === 'group' ? policyOf(cls.group) : 'keep';
      if (policy === 'skip') {
        skipped += 1;
        continue;
      }
      // 默认只留她和他：别人的私聊、群友的话都不进海
      if (SCOPE !== 'all' && !cls.isSelf && !cls.isOwner && cls.proto !== 'note') {
        dropped += 1;
        continue;
      }
      const t = toMs(item?.createdAt || item?.updatedAt);
      push(
        {
          id: `lt_${scope}_${String(item?.hash ?? '').slice(0, 10)}`,
          text: parsed.text,
          t,
          kind: kindOf(parsed.text),
          topic: guessTopic(parsed.text) || 'misc',
          confirmed: true,
          createdAt: t,
          lastMentionAt: toMs(item?.updatedAt) || t,
        },
        cls.proto,
        { scene: cls.scene, group: cls.group, fade: policy === 'fade' },
      );
    }
  }
  COUNTS.system = system;
  COUNTS.skippedByGroup += skipped;
  COUNTS.filteredOthers = dropped;
  if (SCOPE !== 'all') console.log(`[memsea-coo] 事实库：跳过系统域 ${system} 条，按群策略跳过 ${skipped} 条，过滤掉 ${dropped} 条别人的话`);

  // 关于主人的笔记：她自己整理的相处细节，一格一条
  for (const file of listFiles(path.join(HOME, 'workspace', 'partner'), (n) => n.endsWith('.md'))) {
    const t = Math.round(fs.statSync(file).mtimeMs);
    for (const line of readText(file).split(/\r?\n/)) {
      const m = /^\s*[-*]\s+(.+)$/.exec(line);
      if (!m) continue;
      const text = m[1].replace(/\*\*/g, '').replace(/\s+/g, ' ').trim();
      if (text.length < 4) continue;
      push(
        {
          id: `pt_${Buffer.from(text).toString('base64url').slice(0, 10)}`,
          text,
          t,
          kind: kindOf(text),
          topic: 'owner-profile',
          confirmed: true,
          createdAt: t,
          lastMentionAt: t,
        },
        'note',
      );
    }
  }

  out.sort((a, b) => b.t - a.t);
  return out.slice(0, LT_MAX).reverse();
}

/** 交接笔记里的真实私聊原文：#1527034186 [私聊 23:27] 某人(123456): 都是同一个姓…
 *  群消息长这样：#942967737 [群「某个群」 23:32] 某人(123456): …
 *  捕获组：1 私聊/群、2 群名（可空）、3 时、4 分、5 昵称、6 QQ、7 正文 */
const HANDOFF_LINE = /^#\d+\s+\[(私聊|群)(?:「([^」]{0,40})」)?[^\]]*?(\d{1,2}):(\d{2})[^\]]*\]\s*(.+?)[（(](\d+)[)）]\s*[:：]\s*(.+)$/;

/** 交接笔记在哪儿：新的在工作区，旧的会被 slim 扩展搬到 data/slim-archive/handoffs。
 *  两处都读，否则上下文清理（交接）之后，历史对话就从海里消失了。 */
function handoffFiles() {
  const dirs = [path.join(HOME, 'workspace', 'handoffs'), path.join(HOME, 'data', 'slim-archive', 'handoffs')];
  const seen = new Set();
  const files = [];
  for (const dir of dirs) {
    for (const file of listFiles(dir, (n) => n.endsWith('.md') && n !== 'DIGEST.md')) {
      const name = path.basename(file);
      if (seen.has(name)) continue; // 两处同名只读一次
      seen.add(name);
      files.push(file);
    }
  }
  return files;
}

function readHandoffMessages(cutoff, hints) {
  const out = [];
  let skipped = 0;
  for (const file of handoffFiles()) {
    const mtime = Math.round(fs.statSync(file).mtimeMs);
    const dayStart = new Date(mtime);
    dayStart.setHours(0, 0, 0, 0);
    for (const line of readText(file).split(/\r?\n/)) {
      const m = HANDOFF_LINE.exec(line.trim());
      if (!m) continue;
      const text = m[7].replace(/\s+/g, ' ').trim();
      if (text.length < 4 || MEDIA_TAG.test(text)) continue;
      let t = dayStart.getTime() + Number(m[3]) * 3600_000 + Number(m[4]) * 60_000;
      // 交接笔记是事后写的：私聊时间比文件时间还晚，就是跨过了零点
      if (t > mtime + 3600_000) t -= 86_400_000;
      if (t < cutoff) continue;
      const id = `ho_${m[6]}_${t}`;
      const inGroup = m[1] === '群';
      const group = inGroup ? m[2] || '某个群' : '';
      const policy = inGroup ? policyOf(group) : 'keep';
      if (policy === 'skip') {
        skipped += 1;
        continue;
      }
      const isSelf = m[6] === SELF_QQ;
      const isOwner = m[6] === OWNER_QQ;
      // 和事实库同一条规矩：默认只留她和他，群友的话不进海
      if (SCOPE !== 'all' && !isSelf && !isOwner) continue;
      const proto = isSelf ? (inGroup ? 'self-group' : 'self') : inGroup ? 'group-owner' : 'private';
      hints[id] = {
        proto,
        importance: importanceOf(proto, text, kindOf(text)),
        scene: inGroup ? 'group' : 'direct',
        group,
        fade: policy === 'fade',
      };
      out.push({ id, sender: m[5].trim(), isOwner: true, text, at: t });
    }
  }
  COUNTS.skippedByGroup += skipped;
  return out;
}

/** 她的月志：## 10-25 周日 下面一条一条 - 23:3x 干了什么。当她的自述进海。 */
const LOG_HEADER = /^##\s+(\d{2})-(\d{2})/;
const LOG_LINE = /^-\s+(.+)$/;

function readLogMessages(cutoff, hints) {
  const out = [];
  for (const file of listFiles(path.join(HOME, 'workspace', 'log'), (n) => n.endsWith('.md'))) {
    const ym = /^(\d{4})-(\d{2})/.exec(path.basename(file));
    if (!ym) continue;
    const year = Number(ym[1]);
    let month = Number(ym[2]);
    let day = 0;
    let seq = 0;
    let lastHour = null;
    for (const line of readText(file).split(/\r?\n/)) {
      const header = LOG_HEADER.exec(line.trim());
      if (header) {
        month = Number(header[1]);
        day = Number(header[2]);
        lastHour = null;
        continue;
      }
      const bullet = LOG_LINE.exec(line.trim());
      if (!bullet || !day) continue;
      const text = bullet[1].replace(/\*\*/g, '').replace(/\s+/g, ' ').trim();
      if (text.length < 8) continue;
      // 「23:3x」「04:5x」这种模糊时刻按 30/50 分算；没有时间就顺着排到晚上
      const clock = /^(\d{1,2}):([0-9]{1,2})(?:x|X|时|点)?/.exec(text);
      const hour = clock ? Math.min(23, Number(clock[1])) : 20;
      const minute = clock ? Math.min(59, Number(clock[2].replace(/[xX]/g, '0'))) : Math.min(59, seq * 3);
      // 月志按「## 10-25 周日（深夜）」分节，节里会出现 00:4x 这种下一日的时刻：
      // 时刻比上一条倒退半天以上，就说明跨过了零点，日期加一天。
      if (clock) {
        if (lastHour !== null && hour + 12 <= lastHour) day += 1;
        lastHour = hour;
      }
      const t = new Date(year, month - 1, day, hour, minute).getTime();
      seq += 1;
      if (!Number.isFinite(t) || t < cutoff) continue;
      const id = `log_${t}_${seq}`;
      hints[id] = { proto: 'log', importance: importanceOf('log', text, kindOf(text)), scene: 'direct', group: '' };
      out.push({ id, sender: '她', isSelf: true, text, at: t });
    }
  }
  return out;
}

/** 每天看过的视频：运行日志里一天几十条 bilibili-video 事件，压成"一天一条"。
 *  不压缩的话这些机器流水会把海冲淡；压缩之后她还能答「我哪天看了什么」。 */
function readWatchDigests(cutoff, hints) {
  const byDay = new Map();
  const runsRoot = path.join(HOME, 'data', 'runs');
  for (const run of listFiles(runsRoot, () => true)) {
    const file = path.join(run, 'events.jsonl');
    let raw = '';
    try {
      raw = readText(file);
    } catch {
      continue;
    }
    if (!raw) continue;
    for (const line of raw.split(/\r?\n/)) {
      if (!line || !line.includes('bilibili-video')) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (!String(event?.type ?? '').startsWith('bilibili-video')) continue;
      const raw = /《([^》]{2,50})》/.exec(String(event.text ?? ''))?.[1];
      const title = raw ? raw.replace(/[《》]/g, '').trim() : '';
      if (!title) continue;
      const at = Date.parse(event.ts ?? '');
      if (!Number.isFinite(at) || at < cutoff) continue;
      const key = new Date(at).toISOString().slice(0, 10); // UTC 分组够用：只影响跨零点的边角
      const day = byDay.get(key) ?? { titles: new Map(), last: 0 };
      day.titles.set(title, (day.titles.get(title) ?? 0) + 1);
      day.last = Math.max(day.last, at);
      byDay.set(key, day);
    }
  }

  const out = [];
  for (const [day, info] of [...byDay.entries()].sort()) {
    const titles = [...info.titles.keys()];
    if (!titles.length) continue;
    const shown = titles.slice(0, 3).map((t) => `《${t}》`).join('');
    const more = titles.length > 3 ? ` 等 ${titles.length} 个` : '';
    const date = day.slice(5).replace('-', '-');
    const text = `${date} 看了 ${titles.length} 个视频：${shown}${more}`;
    const id = `watch_${day}`;
    const entry = {
      id,
      text,
      t: info.last,
      kind: 'event',
      topic: 'video',
      confirmed: true,
      createdAt: info.last,
      lastMentionAt: info.last,
    };
    hints[id] = { proto: 'watch', importance: importanceOf('watch', text, 'event'), scene: 'direct', group: '' };
    out.push(entry);
  }
  return out;
}

/** 日记：文件名就是日期，2026-10-30 日记.txt；同一天写了两篇的，留长的那篇。 */
function readDiaries(cutoff, hints) {
  const byDate = new Map();
  for (const file of listFiles(path.join(HOME, 'workspace', 'diary'), (n) => /\.(txt|md)$/i.test(n))) {
    const date = /^(\d{4}-\d{2}-\d{2})/.exec(path.basename(file))?.[1];
    if (!date) continue;
    const at = new Date(`${date}T23:30:00`).getTime();
    if (!Number.isFinite(at) || at < cutoff) continue;
    const text = readText(file).replace(/\r?\n{3,}/g, '\n\n').trim();
    if (text.length < 20) continue;
    const prev = byDate.get(date);
    if (!prev || text.length > prev.text.length) byDate.set(date, { date, text, createdAt: at });
  }
  const out = [...byDate.values()].sort((a, b) => a.createdAt - b.createdAt);
  for (const diary of out) {
    hints[`diary_${diary.date}`] = {
      proto: 'diary',
      importance: importanceOf('diary', diary.text, 'conclusion'),
      scene: 'direct',
      group: '',
    };
  }
  return out;
}

/** 汇总一次。返回可以直接交给 buildCooSea 的 data + hints。 */
export function loadCoo() {
  if (!HOME) {
    throw new Error('请先设置 COO_HOME 环境变量，指向 Coopanion 的部署目录，例如 D:/Coopanion/data/home/default');
  }
  COUNTS.system = 0;
  COUNTS.skippedByGroup = 0;
  COUNTS.filteredOthers = 0;
  const cutoff = Date.now() - DAYS * 86_400_000;
  const hints = {};
  // 每天一条"看了什么"的摘要，跟长期记忆一起进海
  const watches = readWatchDigests(cutoff, hints);
  const longTerm = [...readLongTerm(cutoff, hints), ...watches].sort((a, b) => a.t - b.t);
  const diaries = readDiaries(cutoff, hints);

  // 消息的主要来源是运行日志（全量、真时间戳）；没有运行日志时才退回交接笔记
  const runs = readRunEvents(HOME, cutoff);
  const useRuns = runs.messages.length > 0;
  // 和事实库同一条规矩：默认只留她和他，群友的话不进海
  const baseMessages = useRuns
    ? runs.messages.filter((message) => SCOPE === 'all' || message.proto !== 'group')
    : readHandoffMessages(cutoff, hints);
  if (useRuns) {
    for (const message of baseMessages) {
      const policy = message.scene === 'group' ? policyOf(message.group) : 'keep';
      if (policy === 'skip') continue;
      hints[message.id] = {
        proto: message.proto,
        importance: importanceOf(message.proto, message.text, kindOf(message.text)),
        scene: message.scene,
        group: message.group,
        fade: policy === 'fade',
      };
    }
  }
  const rawMessages = [...baseMessages, ...readLogMessages(cutoff, hints)].sort((a, b) => a.at - b.at);

  // 同一条话被抓好几份（事实库一份、交接笔记一份）：留长期记忆那份，消息里的重复删掉
  const deduped = dedupeMemories({ longTerm, messages: rawMessages });
  const messages = deduped.messages;
  const alive = new Set([...longTerm.map((entry) => entry.id), ...messages.map((message) => message.id), ...diaries.map((d) => `diary_${d.date}`)]);
  for (const id of Object.keys(hints)) if (!alive.has(id)) delete hints[id];

  const times = [...messages.map((m) => m.at), ...diaries.map((d) => d.createdAt)];
  return {
    name: '记忆海',
    longTerm,
    messages,
    diaries,
    hints,
    stats: {
      home: HOME,
      days: DAYS,
      scope: SCOPE,
      skippedByGroup: COUNTS.skippedByGroup,
      systemScopes: COUNTS.system,
      filteredOthers: COUNTS.filteredOthers,
      groupRules: { skip: RULES.skip ?? [], fade: RULES.fade ?? [] },
      longTerm: longTerm.length,
      messages: messages.length,
      messagesBeforeDedupe: rawMessages.length,
      messageSource: useRuns ? 'runs' : 'handoffs',
      runFiles: runs.files,
      duplicates: {
        sameSource: deduped.dropped.messagesSameSource,
        crossSource: deduped.dropped.crossSource,
        examples: deduped.dropped.examples,
      },
      diaries: diaries.length,
      span: times.length ? { from: new Date(Math.min(...times)), to: new Date(Math.max(...times)) } : null,
    },
  };
}

// 出报表（群记忆清单）时复用同一套解析与判权，避免两份逻辑走偏
export { parseFact, importanceOf, kindOf, RULES as groupRules };
