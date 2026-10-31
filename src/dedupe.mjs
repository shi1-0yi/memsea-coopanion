// 跨源去重：同一条话被 Cortico 抓了几份（事实库一份、交接笔记一份），
// 在海里就会变成几颗一模一样的星，回声也会把它算成"被提了好几次"。
//
// 判重不是比文本相等就完事：
//   - 归一化（去空白与标点、转小写）后相同
//   - 时间落在同一个窗口内（默认 30 分钟）——同一条消息的几份抓取最多差几分钟，
//     而隔了几天又说一遍同样的话，那是真的又说了一次，不该合并
// 冲突时以长期记忆为准：它带着 kind/topic/重要度，信息更全。
const WINDOW_MS = 30 * 60 * 1000;
const PUNCT = /[\s，。、；：？！…—－·"'“”‘’（）()【】\[\]《》<>~!?.,:;]/g;

/** 判重用的指纹：只留字，不留形。 */
export const dedupeKey = (text) => String(text ?? '').toLowerCase().replace(PUNCT, '').slice(0, 80);

/**
 * @param {{longTerm:any[], messages:any[]}} data
 * @returns {{longTerm:any[], messages:any[], dropped:{messagesSameSource:number, crossSource:number, examples:any[]}}}
 */
export function dedupeMemories({ longTerm = [], messages = [] }, { windowMs = WINDOW_MS } = {}) {
  const dropped = { messagesSameSource: 0, crossSource: 0, examples: [] };
  const note = (text, reason) => {
    if (dropped.examples.length < 5) dropped.examples.push({ reason, text: String(text).slice(0, 40) });
  };

  // 1) 消息自己内部的重复
  const keepMessages = [];
  const byKey = new Map();
  for (const message of [...messages].sort((a, b) => (a.at ?? 0) - (b.at ?? 0))) {
    const key = dedupeKey(message.text);
    if (!key) continue;
    const seen = byKey.get(key) ?? [];
    const duplicate = seen.some((t) => Math.abs(t - (message.at ?? 0)) <= windowMs);
    if (duplicate) {
      dropped.messagesSameSource += 1;
      note(message.text, '同源重复');
      continue;
    }
    seen.push(message.at ?? 0);
    byKey.set(key, seen);
    keepMessages.push(message);
  }

  // 2) 消息与长期记忆之间的重复：留长期记忆那份
  const longTermTimes = new Map();
  for (const entry of longTerm) {
    const key = dedupeKey(entry.text);
    if (!key) continue;
    const times = longTermTimes.get(key) ?? [];
    times.push(Number(entry.createdAt ?? entry.t) || 0);
    longTermTimes.set(key, times);
  }
  const keepAfterCross = [];
  for (const message of keepMessages) {
    const key = dedupeKey(message.text);
    const times = key ? longTermTimes.get(key) : undefined;
    if (times && times.some((t) => Math.abs(t - (message.at ?? 0)) <= windowMs)) {
      dropped.crossSource += 1;
      note(message.text, '跨源重复');
      continue;
    }
    keepAfterCross.push(message);
  }

  return { longTerm, messages: keepAfterCross, dropped };
}
