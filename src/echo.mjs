// 回声：一条老记忆后来又被提起，等于被复述了一次。
//
// 为什么需要这一层：Coopanion 的事实库是"每条消息一个独立条目"，
// 从来不会把"同一件事又被说了一遍"合并回旧条目（实测 updatedAt 全等于 createdAt）。
// 所以"被提起"必须自己从语料里推：后来的某条消息/日记，跟某条老记忆说得上同一件事 → 算一次提及。
//
// 三条判据都是拿这份数据标定过的，不是拍脑袋：
//   1) 关键词要"稀有"：出现在几十个点以上的词（「今天」「群里」）不当作依据；
//   2) 近重复要排除：相似度 ≥0.8 基本是同一条话被抓了两遍，不算"又提起"；
//   3) 真正的复用相似度不高（实测 0.3 上下），所以门槛定在 0.3，靠"共享稀有词 ≥2"兜底。
const NORM_RE = /[\s，。、；：？！…—－·"'“”‘’（）()【】\[\]《》<>~!?.,:;]/g;

/** 中文没有分词，用字符 bigram 的集合当指纹；预计算一次，避免两两比较时反复切。 */
function gramsOf(text) {
  const clean = String(text ?? '').toLowerCase().replace(NORM_RE, '');
  const set = new Set();
  for (let i = 0; i + 1 < clean.length; i += 1) set.add(clean.slice(i, i + 2));
  return set;
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const g of a) if (b.has(g)) inter += 1;
  return inter / (a.size + b.size - inter);
}

export const ECHO_DEFAULTS = Object.freeze({
  /** 至少共享几个"稀有"关键词才算候选 */
  minShared: 2,
  /** 相似度门槛：低于它就不算同一件事 */
  minSim: 0.3,
  /** 高于它基本是同一条消息被抓了两遍，排除 */
  duplicateSim: 0.8,
  /** 间隔下限：半小时内重复抓到的同一条，不算复述 */
  minGapMs: 30 * 60 * 1000,
  /** 只有这类点会被复述（长期记忆与日记才有"被想起来"这回事） */
  recallableTypes: ['longterm', 'diary'],
  /** 关键词出现在多少个点以上就算"太常见"，不拿来当依据 */
  rareDf: 40,
});

/**
 * 扫一遍时间线，给每条可被复述的记忆记下「被提起过几次、最后一次是什么时候」。
 * @returns {Map<string, {hits:number, lastMentionAt:number, mentions:{t:number,sim:number,text:string}[]}>}
 */
export function inferEchoes(points, opts = {}) {
  const cfg = { ...ECHO_DEFAULTS, ...opts };
  const list = (points || []).filter((p) => p && p.text);
  const prep = list.map((point) => ({ point, grams: gramsOf(point.text), keywords: point.keywords ?? [] }));

  // 关键词的文档频率：太常见的词不做依据
  const df = new Map();
  for (const item of prep) for (const keyword of new Set(item.keywords)) df.set(keyword, (df.get(keyword) ?? 0) + 1);
  const isRare = (keyword) => (df.get(keyword) ?? 0) <= cfg.rareDf;

  const byKeyword = new Map();
  prep.forEach((item, index) => {
    for (const keyword of item.keywords) {
      if (!isRare(keyword)) continue;
      const bucket = byKeyword.get(keyword);
      if (bucket) bucket.push(index);
      else byKeyword.set(keyword, [index]);
    }
  });

  const echoes = new Map();
  const stats = { candidates: 0, duplicates: 0, mentions: 0 };

  for (let i = 0; i < prep.length; i += 1) {
    const older = prep[i];
    if (!cfg.recallableTypes.includes(older.point.source?.type)) continue;

    const shared = new Map();
    for (const keyword of older.keywords) {
      if (!isRare(keyword)) continue;
      for (const j of byKeyword.get(keyword) ?? []) {
        if (j === i) continue;
        shared.set(j, (shared.get(j) ?? 0) + 1);
      }
    }

    for (const [j, count] of shared) {
      if (count < cfg.minShared) continue;
      const later = prep[j];
      if (later.point.t - older.point.t < cfg.minGapMs) continue;
      stats.candidates += 1;
      const sim = jaccard(older.grams, later.grams);
      if (sim >= cfg.duplicateSim) {
        stats.duplicates += 1; // 同一条话被抓了两遍，不算复述
        continue;
      }
      if (sim < cfg.minSim) continue;
      stats.mentions += 1;

      const entry = echoes.get(older.point.id) ?? { hits: 0, lastMentionAt: 0, mentions: [], seen: new Set() };
      // 同一个时间点被抓好几份的，只算一次提及（Cortico 的抓取会重复）
      const bucket = `${Math.floor(later.point.t / 60_000)}`;
      if (entry.seen.has(bucket)) continue;
      entry.seen.add(bucket);
      entry.hits += 1;
      if (later.point.t > entry.lastMentionAt) entry.lastMentionAt = later.point.t;
      if (entry.mentions.length < 8) {
        entry.mentions.push({ t: later.point.t, sim: Math.round(sim * 100) / 100, text: later.point.text.slice(0, 40) });
      }
      echoes.set(older.point.id, entry);
    }
  }

  echoes.stats = stats;
  return echoes;
}
