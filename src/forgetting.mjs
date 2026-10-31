// 遗忘曲线：重要的越记越牢，琐碎的慢慢淡出。
//
// 两条规则叠在一起，才像真的记忆：
//   1) 时间衰减 —— 强度 = 重要度 × 0.5^(放了几天 / 半衰期)，半衰期由重要度决定。
//      强度低于门槛就从海里消失（真忘，不是变灰）；还在的按强度缩小、变暗。
//   2) 容量上限 —— 光靠时间不够：一周内发生的琐事都还"新"，但人也不会全记住。
//      所以低重要度（群聊这类）再按强度排序，只留最强的一批，其余记不住。
//
// 半衰期用指数而不是线性：群里一句「在吗」和一句「他答应过周日陪你去打针」，
// 不该按同一个速度衰减。
const DAY = 86_400_000;

export const FORGET_DEFAULTS = Object.freeze({
  enabled: true,
  /** 重要度 0 时的半衰期（天）；配合 halfCurve 决定整条曲线 */
  halfScale: 0.55,
  /** 曲线陡度：重要度每高 0.1，半衰期乘 e^0.48 */
  halfCurve: 4.8,
  /** 强度低于它就忘掉 */
  floor: 0.07,
  /** 重要度低于这条线算"琐碎"，要受容量上限约束 */
  trivialBelow: 0.4,
  /** 琐碎的最多留几条（0 = 不限） */
  trivialCap: 120,
  /** 标了 "只走遗忘栏" 的群：重要度封顶到这里，半衰期自然被压短 */
  fadeCap: 0.3,
  /** 回声：每被复述一次，半衰期乘 (1 + echoBoost) */
  echoBoost: 0.25,
  /** 复述带来的半衰期最长乘几倍 */
  maxHalfLifeBoost: 3,
});

/** 这条记忆放几天会淡一半。 */
export function halfLifeDays(importance, knobs = FORGET_DEFAULTS) {
  return knobs.halfScale * Math.exp(knobs.halfCurve * Math.max(0, Math.min(1, importance)));
}

/**
 * 一条记忆此刻的强度：0 已经忘了，1 跟刚发生一样。
 * echo = { hits, lastMentionAt }：被复述过就从"最后一次被提起"开始算，
 * 并且每提一次半衰期变长——这是间隔效应，提得越多越难忘。
 */
export function strengthOf(point, importance, now = Date.now(), knobs = FORGET_DEFAULTS, echo = null) {
  const created = Number(point?.t || now);
  const lastMention = Number(echo?.lastMentionAt || 0);
  const origin = Math.max(created, lastMention); // 回春：从最后一次被提起算起
  const hits = Math.max(0, Number(echo?.hits || 0));
  const boostMax = Number(knobs.maxHalfLifeBoost ?? FORGET_DEFAULTS.maxHalfLifeBoost);
  const boost = Math.min(boostMax, 1 + Number(knobs.echoBoost ?? FORGET_DEFAULTS.echoBoost) * hits);
  const ageDays = Math.max(0, (now - origin) / DAY);
  const half = halfLifeDays(importance, knobs) * boost;
  const retention = Math.pow(0.5, ageDays / half);
  return { importance, ageDays, halfLifeDays: half, retention, strength: importance * retention, hits, revivedAt: lastMention || 0 };
}

/** 强度 → 星的权重（决定半径与亮度）。留个下限，别忘了的还能看见一点。 */
export const weightOf = (strength) => Math.round(Math.min(3.55, 0.55 + 3 * strength) * 100) / 100;

/**
 * 给一批点算遗忘，返回留下的和被忘掉的（每条带 reason：aged 时间到 / capacity 装不下）。
 * hints 是 { [点 id]: { proto, importance } }，由适配层给出。
 */
export function applyForgetting(points, hints = {}, { now = Date.now(), knobs = FORGET_DEFAULTS } = {}) {
  const scored = points.map((point) => {
    const hint = hints[point.id] ?? {};
    const raw = Number(hint.importance ?? 0.4);
    // 「慢慢遗忘」栏：重要度封顶，半衰期跟着变短（0.3 → 约 2 天半衰）
    const importance = hint.fade ? Math.min(raw, knobs.fadeCap ?? FORGET_DEFAULTS.fadeCap) : raw;
    const echo = hint.hits ? { hits: hint.hits, lastMentionAt: hint.lastMentionAt } : null;
    return { point, proto: hint.proto ?? 'unknown', fade: Boolean(hint.fade), ...strengthOf(point, importance, now, knobs, echo) };
  });

  const dropped = [];
  const alive = [];
  for (const item of scored) {
    if (knobs.enabled && item.strength < knobs.floor) dropped.push({ ...item, reason: 'aged' });
    else alive.push(item);
  }

  // 容量：琐碎的按强度排队，只留前 trivialCap 条
  let keep = alive;
  if (knobs.enabled && knobs.trivialCap > 0) {
    const trivial = alive.filter((i) => i.importance < knobs.trivialBelow).sort((a, b) => b.strength - a.strength);
    const overflow = new Set(trivial.slice(knobs.trivialCap).map((i) => i.point.id));
    keep = [];
    for (const item of alive) {
      if (overflow.has(item.point.id)) dropped.push({ ...item, reason: 'capacity' });
      else keep.push(item);
    }
  }

  const kept = [];
  for (const item of keep) {
    item.point.weight = weightOf(item.strength);
    // 留一份可观测的遗忘状态，方便在页面上核对；不参与下游计算
    item.point.forget = {
      importance: Math.round(item.importance * 100) / 100,
      retention: Math.round(item.retention * 100) / 100,
      halfLifeDays: Math.round(item.halfLifeDays * 10) / 10,
      hits: item.hits || 0,
      ...(item.revivedAt ? { revivedAt: item.revivedAt } : {}),
    };
    kept.push(item.point);
  }

  return { kept, dropped };
}

/** 按"为什么忘 + 从哪来"汇总，用来在构建时打一行。 */
export function summarizeDropped(dropped) {
  const out = { aged: 0, capacity: 0, byProto: {} };
  for (const item of dropped) {
    out[item.reason] = (out[item.reason] ?? 0) + 1;
    out.byProto[item.proto] = (out.byProto[item.proto] ?? 0) + 1;
  }
  return out;
}
