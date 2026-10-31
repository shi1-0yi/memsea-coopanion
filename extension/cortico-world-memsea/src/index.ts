// 记忆海 · 检索 World
//
// 只做一件事：给她一个 memsea_recall 工具，让她在上下文被清掉之后，
// 还能从「记忆海」的原始数据里把旧事捞回来。
//
// 三条设计约束：
//   1) 只读。不写她的记忆，不改任何文件——所以清理上下文永远不会波及这里。
//   2) 现读现算。没有常驻进程、没有索引文件，用的永远是磁盘上最新的东西。
//   3) 不 import 任何 cortico 的类型/工具函数，只依赖 node 内置模块，
//      这样宿主的内部路径怎么变都不会因为 resolve 失败而起不来。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 环境提示词模板就在本文件旁边（ENV_PROMPT.md）。 */
const PROMPT_PATH = fileURLToPath(new URL('./ENV_PROMPT.md', import.meta.url));

export const id = 'memsea';
export const label = '记忆海';
export const defaults = (): { enabled: boolean } => ({ enabled: false });

/** 取成"人说的话"的事件类型。其余（系统提示、视频日志、戳一戳）不参与检索。 */
const KEEP = new Set([
  'qq.message',
  'qq.self',
  'desktop-pet.self',
  'desktop-pet.message',
  'desktop-pet.speech',
  'desktop-pet.answer',
  'console.message',
]);

const PUNCT = /[\s，。、；：？！…—－·"'“”‘’（）()【】\[\]《》<>~!?.,:;]/g;
const QQ_PREFIX = /^(?:【QQ(?:群|私聊)[^】]{0,80}】\s*[:：]?\s*)?#\d+\s*\[[^\]]{0,90}[\]】]\s*/;
const PET_PREFIX = /^\[\d{1,2}:\d{2}(?::\d{2})?\]\s*(?:\[[a-z]+\]\s*)?/i;
const SPEAKER = /^(哥哥|主人|你|我|控制台)\s*[:：]\s*/;
/** 事实库里还夹着这种时间戳与标签：[10-30 周五 00:17] [typed] 哥哥: —— 开头的括号块一律剥掉 */
const STAMP = /^(?:\[[^\]\n]{0,40}\]\s*)+/;

const norm = (text: string): string => String(text ?? '').replace(PUNCT, '').toLowerCase();

/** 中文没有分词：用字符 bigram 集合当指纹。 */
function grams(text: string): Set<string> {
  const clean = norm(text);
  const out = new Set<string>();
  for (let i = 0; i + 1 < clean.length; i += 1) out.add(clean.slice(i, i + 2));
  return out;
}

function overlap(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let hit = 0;
  for (const g of a) if (b.has(g)) hit += 1;
  return hit / a.size; // 以查询为分母：查得越具体越准
}

/** 近义词表：她问「屏幕」，原始记录里写的是「桌面」「窗口」。缺了这层，字面检索必漏。 */
const SYNONYMS: Record<string, string[]> = {
  屏幕: ['桌面', '窗口', '显示器'],
  甩: ['摔', '扔', '甩出去'],
  摔: ['甩', '落地', '晕'],
  语音: ['声音', '嗓音', 'sovits'],
  日记: ['本子', '日记本'],
  余额: ['钱', '充值', '花费'],
  表情包: ['表情', '梗图', '贴纸'],
  群: ['群里', '群聊'],
  戳: ['摸', '拎', '点'],
  说: ['喊', '讲', '回'],
  电脑: ['机器', '本子', '桌面'],
};

/** 把查询拆成词：她要查的往往是几个关键词，而不是一整句。
 *  返回带权重的词：字面词 1，近义词 1.15（近义词更"值钱"，否则会被字面撞车压过去），单字 0.8。 */
function tokens(query: string): { text: string; w: number }[] {
  const parts = String(query ?? '')
    .split(/[\s,，。、；;|/]+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 1);
  const weights = new Map<string, number>();
  const bump = (text: string, w: number) => {
    if (!text) return;
    weights.set(text, Math.max(weights.get(text) ?? 0, w));
  };
  for (const part of parts) {
    bump(part, 1);
    // 长词再拆成 2 字片段，避免"第一次看屏幕"整体当一格
    if (part.length > 4) {
      for (let i = 0; i + 2 <= part.length; i += 2) bump(part.slice(i, i + 2), 1);
    }
    if (part.length <= 2) for (const ch of part) bump(ch, 0.8);
  }
  // 近义词要对"每一个切出来的词"都展开，否则「第一次看屏幕」拆出的「屏幕」不会带出「桌面」
  for (const token of [...weights.keys()]) {
    for (const syn of SYNONYMS[token] ?? []) bump(syn, 1.15);
  }
  return [...weights.entries()].map(([text, w]) => ({ text, w }));
}

type Memory = {
  t: number;
  text: string;
  who: string;
  where: string;
  grams: Set<string>;
};

/** 剥前缀要反复来：一条记录可能同时套着【QQ私聊 …】、#id、[私聊 00:51]、昵称(QQ:号)：好几层。 */
const stripQQ = (text: string): string => {
  let s = String(text ?? '').trim();
  for (let i = 0; i < 4; i += 1) {
    const before = s;
    s = s
      .replace(/^【QQ(?:群|私聊)[^】]{0,80}】\s*[:：]?\s*/, '')
      .replace(/^[：:\s]*#\d+\s*/, '')
      .replace(/^[：:\s]*\[[^\]\n]{0,90}[\]】]\s*/, '')
      .replace(STAMP, '')
      .replace(/^[：:\s]+/, '');
    if (s === before) break;
  }
  return s
    .replace(/^[^:：（(]{1,20}[（(](?:QQ:)?\d{5,12}[)）]\s*[:：]\s*/, '')
    .replace(SPEAKER, '')
    .replace(/\s+/g, ' ')
    .trim();
};

const stripPet = (text: string): string => String(text ?? '').replace(PET_PREFIX, '').replace(STAMP, '').replace(SPEAKER, '').replace(/\s+/g, ' ').trim();

/** 谁说的：主人 / 她 / 群友。看原文里的称呼和 QQ 号，不看事件类型。 */
/** 谁说的：主人 / 她 / 群友。
 *  优先看正文里的称呼（你、哥哥、主人），其次看 QQ 号——号码从环境变量取，不写死。 */
function whoOf(raw: string, fallback: string): string {
  const text = String(raw ?? '');
  const ownerQQ = process.env.COOPANION_OWNER_QQ || '';
  const selfQQ = process.env.COOPANION_SELF_QQ || '';
  if (/(?:^|\]\s*)你\s*[:：]/.test(text)) return '她';
  if (/(?:^|\]\s*)(?:哥哥|主人)\s*[:：]/.test(text)) return '哥哥';
  if (ownerQQ && text.includes(`(QQ:${ownerQQ})`)) return '哥哥';
  if (ownerQQ && text.includes(`(${ownerQQ})`)) return '哥哥';
  if (selfQQ && text.includes(`(QQ:${selfQQ})`)) return '她';
  if (selfQQ && text.includes(`(${selfQQ})`)) return '她';
  return fallback;
}

/** 扫一遍部署目录：消息走运行日志，事实库与日记各读一次。 */
function loadCorpus(botDir: string, sinceMs: number, limit = 40000): Memory[] {
  const out: Memory[] = [];
  const push = (t: number, text: string, who: string, where: string) => {
    if (!Number.isFinite(t) || t < sinceMs) return;
    const clean = text.length > 240 ? `${text.slice(0, 240)}…` : text;
    if (clean.length < 4) return;
    out.push({ t, text: clean, who, where, grams: grams(clean) });
  };

  // 1) 对话：data/runs/<run>/events.jsonl
  const runsDir = path.join(botDir, 'data', 'runs');
  let runs: string[] = [];
  try {
    runs = fs.readdirSync(runsDir).filter((name) => name.startsWith('r-')).sort();
  } catch {
    runs = [];
  }
  for (const run of runs) {
    let raw = '';
    try {
      raw = fs.readFileSync(path.join(runsDir, run, 'events.jsonl'), 'utf8');
    } catch {
      continue;
    }
    for (const line of raw.split(/\r?\n/)) {
      if (!line) continue;
      let event: any;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (!KEEP.has(event?.type)) continue;
      if (event.meta?.kind === 'activity') continue;
      if (/^送达了\s*#\d+/.test(String(event.text ?? ''))) continue; // 界面回执，不是她说过的话
      const t = Date.parse(event.ts ?? '');
      if (!Number.isFinite(t) || t < sinceMs) continue;

      const isQQ = String(event.type).startsWith('qq.');
      const text = isQQ ? stripQQ(event.text) : stripPet(event.text);
      if (!text) continue;
      const inGroup = /\[群|【QQ群/.test(String(event.text ?? ''));
      const isSelf = event.type === 'qq.self' || event.type === 'desktop-pet.self';
      const where = inGroup ? '群' : isQQ ? 'QQ 私聊' : event.type === 'console.message' ? '控制台' : '桌宠';
      push(t, text, whoOf(event.text, isSelf ? '她' : inGroup ? '群友' : '哥哥'), where);
      if (out.length >= limit) break;
    }
    if (out.length >= limit) break;
  }

  // 2) 事实库：data/fact-store.json
  try {
    const store = JSON.parse(fs.readFileSync(path.join(botDir, 'data', 'fact-store.json'), 'utf8'));
    for (const [scope, entries] of Object.entries(store?.scopes ?? {}) as [string, any[]][]) {
      if (!Array.isArray(entries)) continue;
      const ownerQQ = process.env.COOPANION_OWNER_QQ || '';
      const ownerScope = scope === 'main' || (ownerQQ && new RegExp(`^(qq:|private:)?${ownerQQ}$`).test(scope));
      for (const item of entries) {
        const rawText = String(item?.text ?? '');
        // 换装状态、链接卡片、视频日志是机器产物，不是"说过的话"
        if (/\[(?:figure|卡片|视频|系统)[：\]]/.test(rawText.slice(0, 80))) continue;
        const raw = Number(item?.createdAt) || 0;
        const t = raw > 0 ? raw * (raw < 1e12 ? 1000 : 1) : 0;
        const text = stripQQ(item?.text ?? '');
        if (text.length < 4) continue;
        push(t, text, whoOf(item?.text ?? '', ownerScope ? '哥哥' : '她'), '事实库');
      }
    }
  } catch {
    /* 没有事实库就不读 */
  }

  // 3) 日记：workspace/diary/*.txt
  try {
    const dir = path.join(botDir, 'workspace', 'diary');
    for (const file of fs.readdirSync(dir)) {
      if (!/\.(txt|md)$/i.test(file)) continue;
      const date = /^(\d{4}-\d{2}-\d{2})/.exec(file)?.[1];
      if (!date) continue;
      const t = Date.parse(`${date}T23:30:00`);
      const text = fs.readFileSync(path.join(dir, file), 'utf8').replace(/\s+/g, ' ').trim();
      if (text.length < 20) continue;
      push(t, text, '她写的', '日记');
    }
  } catch {
    /* 没有日记目录就不读 */
  }

  // 4) 每天看过的视频：一天几十条流水，压成"一天一条"，否则会淹没别的记忆
  try {
    const byDay = new Map<string, { titles: Set<string>; last: number }>();
    for (const run of runs) {
      let raw = '';
      try {
        raw = fs.readFileSync(path.join(runsDir, run, 'events.jsonl'), 'utf8');
      } catch {
        continue;
      }
      for (const line of raw.split(/\r?\n/)) {
        if (!line || !line.includes('bilibili-video')) continue;
        let event: any;
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }
        if (!String(event?.type ?? '').startsWith('bilibili-video')) continue;
        const found = /《([^》]{2,50})》/.exec(String(event.text ?? ''))?.[1];
        if (!found) continue;
        const at = Date.parse(event.ts ?? '');
        if (!Number.isFinite(at) || at < sinceMs) continue;
        const key = new Date(at).toISOString().slice(0, 10);
        const day = byDay.get(key) ?? { titles: new Set<string>(), last: 0 };
        day.titles.add(found.replace(/[《》]/g, '').trim());
        day.last = Math.max(day.last, at);
        byDay.set(key, day);
      }
    }
    for (const [day, info] of byDay) {
      const titles = [...info.titles];
      if (!titles.length) continue;
      const shown = titles.slice(0, 3).map((t) => `《${t}》`).join('');
      const more = titles.length > 3 ? ` 等 ${titles.length} 个` : '';
      push(info.last, `${day.slice(5)} 看了 ${titles.length} 个视频：${shown}${more}`, '她', '看视频');
    }
  } catch {
    /* 没有运行日志就没有观看记录 */
  }

  return out;
}

// 扫盘不便宜（50 个 run、五千多条），一轮对话里可能问好几次：缓存两分钟。
const corpusCache = new Map<string, { builtAt: number; corpus: Memory[] }>();
function corpusFor(botDir: string): Memory[] {
  const hit = corpusCache.get(botDir);
  if (hit && Date.now() - hit.builtAt < 120_000) return hit.corpus;
  const corpus = loadCorpus(botDir, Date.now() - 365 * 86_400_000);
  corpusCache.set(botDir, { builtAt: Date.now(), corpus });
  return corpus;
}

const fmt = (t: number): string => {
  const d = new Date(t);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

const TOOL = {
  name: 'memsea_recall',
  description:
    'Search the long-term memory sea for things that were said or written before — earlier conversations, promises, facts about the person, diary entries. ' +
    'Use this whenever you need to remember something that may have been cleared from the current context; the sea is built from the raw logs and never forgets on its own. ' +
    'Read-only. Returns matches with their timestamps and who said them, most relevant first.',
  tags: ['read'] as const,
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      query: { type: 'string', description: 'What to look for, in Chinese. Keywords work better than a whole question.' },
      k: { type: 'number', description: 'How many memories to return. Default 8, max 30.' },
      days: { type: 'number', description: 'How far back to look, in days. Default 30, max 365.' },
    },
    required: ['query'],
  },
  async handler(args: Record<string, unknown>): Promise<string> {
    const query = String(args.query ?? '').trim();
    if (!query) return '记忆海：需要一个查询词。';
    const k = Math.min(30, Math.max(1, Number(args.k) || 8));
    const days = Math.min(365, Math.max(1, Number(args.days) || 30));
    const botDir = (globalThis as any).__memseaBotDir__ || process.env.COOPANION_BOT_DIR || defaultBotDir();
    const since = Date.now() - days * 86_400_000;

    let corpus: Memory[] = [];
    try {
      corpus = corpusFor(botDir);
    } catch (error: any) {
      return `记忆海：读不到 ${botDir}（${error?.message ?? error}）。`;
    }
    if (!corpus.length) return `记忆海：没有可检索的记录（目录 ${botDir}）。`;

    // 按词查，不按整句查：查询里每个词单独算分，取最高的那个
    const literal = norm(query);
    // 最近 15 分钟的话还在上下文里，把"刚问出口的问题"检索出来只会答非所问
    const fresh = Date.now() - 15 * 60 * 1000;
    const pool = corpus.filter((m) => m.t >= since && m.t <= fresh);

    // 词越少见越值钱：「控制台」比「冒充」更能定位到那一条记忆
    const texts = pool.map((m) => norm(m.text));
    const N = Math.max(1, texts.length);
    const toks = tokens(query).map((t) => {
      const needle = norm(t.text);
      const df = texts.reduce((n, s) => n + (s.includes(needle) ? 1 : 0), 0);
      const idf = 1 + 0.25 * Math.log(N / Math.max(1, df)); // 不设上限：只出现几次的词要比出现上百次的词重得多
      return { ...t, grams: t.text.length > 1 ? grams(t.text) : null, idf };
    });

    const scored = pool
      .map((m) => {
        let best = 0;
        let matched = 0;
        for (const tok of toks) {
          // 单字只做包含判断（bigram 对单字没意义）
          const raw = tok.grams ? overlap(tok.grams, m.grams) : norm(m.text).includes(tok.text) ? 0.3 : 0;
          const hit = raw * tok.w * tok.idf; // 近义词、稀有词更值钱，避免被常见词的撞车压过去
          if (hit > 0.4) matched += 1;
          if (hit > best) best = hit;
        }
        const bonus = literal.length >= 2 && norm(m.text).includes(literal) ? 0.35 : 0;
        const support = Math.min(3, matched) * 0.08; // 多个词都对上，更可信
        const ageDays = (Date.now() - m.t) / 86_400_000;
        const recency = 0.03 * Math.max(0, 1 - ageDays / days);
        // 她刚问出口的问题本身也会被存进事实库，词面比原始记录还像；
        // 那不是"回忆"，是"提问"，必须压下去，否则检索会答非所问
        const question = /[？?]\s*$/.test(m.text.trim()) ? 0.45 : 1;
        return { m, base: best + support, score: (best + support + bonus + recency) * question };
      })
      .sort((a, b) => b.score - a.score);

    // 同一条话常在事实库和聊天里各存一份：按归一化文本去重，留分高的那条
    const dedupe = (rows: typeof scored, limit: number) => {
      const out: typeof scored = [];
      const seen = new Set<string>();
      for (const row of rows) {
        const key = norm(row.m.text).slice(0, 60);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(row);
        if (out.length >= limit) break;
      }
      return out;
    };

    // 先按正常门槛挑；一条都没有，就退一步给"最接近的"，并且如实标注不确定
    let picked = dedupe(scored.filter((row) => row.base > 0.15), k);
    let weak = false;
    if (!picked.length) {
      picked = dedupe(scored.filter((row) => row.base > 0.05), Math.min(3, k));
      weak = true;
    }
    if (!picked.length) {
      return `记忆海：最近 ${days} 天里没找到跟「${query}」有关的记录。可以换个词再试（比如把「屏幕」换成「桌面」「窗口」）。`;
    }

    const lines = picked.map((row, index) => {
      const m = row.m;
      return `${index + 1}. [${fmt(m.t)} · ${m.where} · ${m.who}] ${m.text}`;
    });
    const scanned = corpus.filter((m) => m.t >= since).length;
    const head = weak
      ? `记忆海里没有很确定的匹配，这几条最接近（查询「${query}」，范围 ${days} 天，扫了 ${scanned} 条）；引用前先确认：`
      : `记忆海里找到 ${picked.length} 条（查询「${query}」，范围 ${days} 天，扫了 ${scanned} 条）：`;
    return `${head}\n${lines.join('\n')}`;
  },
};

/** 没拿到部署目录时的兜底：Coopanion 的默认位置。 */
function defaultBotDir(): string {
  return process.env.COOPANION_BOT_DIR || '';
}

class MemseaWorld {
  readonly id = id;
  private readonly ctx: any;

  constructor(ctx: any) {
    this.ctx = ctx;
    // 装配层给的是部署目录（botDir）；只给了 dataDir 时取它的上一层
    const dir = ctx?.botDir || (ctx?.dataDir ? path.dirname(String(ctx.dataDir)) : '');
    if (dir) (globalThis as any).__memseaBotDir__ = dir;
  }

  /** 环境提示词模板：告诉它什么时候该来查、怎么查。模板里没有占位符，返回空对象即可整篇保留。 */
  webUi(_language?: string): any {
    return {
      promptDocs: [
        {
          key: 'worlds.memsea.envPrompt',
          title: '记忆海 · 环境提示词',
          description: '什么时候该去记忆海里找旧事，以及怎么查。',
          path: PROMPT_PATH,
          role: 'envPrompt',
        },
      ],
    };
  }

  envPromptVars(): Record<string, string> | null {
    return {}; // 空对象 = 保留模板全文；null 会让整段消失
  }

  tools(): any[] {
    return [{ ...TOOL }];
  }

  async start(_host: any): Promise<void> {
    /* 没有外部连接要建：工具是纯本地只读 */
  }

  async stop(): Promise<void> {
    /* 没有连接要断 */
  }
}

export function create(ctx: any): MemseaWorld {
  return new MemseaWorld(ctx);
}

export const describe = {
  tools: [
    {
      name: TOOL.name,
      description: TOOL.description,
      parameters: TOOL.parameters,
      tags: TOOL.tags,
      summary: {
        zh: '在记忆海里按关键词找以前的对话、约定、事实和日记（只读，不受上下文清理影响）。',
        en: 'Searches the memory sea for earlier conversations, promises, facts and diary entries. Read-only.',
      },
    },
  ],
  events: [] as any[],
};

export const MEMSEA_WORLD = { id, label, defaults, create, describe };
export default MEMSEA_WORLD;
