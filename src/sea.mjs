// Coo 的记忆 → 一片海，中间穿过遗忘曲线，再叠一层"被提起就想起"的回声。
// createSceneService 是上游"不过滤"的胶水；这里换成自己的四步：
//   1) 收集点   2) 推回声（谁被后来的话复述过）   3) 按重要度与时间衰减   4) 连边成场景
import { collectPoints, pointFromDiary, buildScene, MIND_SEA_DEFAULTS } from './mind-sea.js';
import { applyForgetting, FORGET_DEFAULTS, summarizeDropped } from './forgetting.mjs';
import { inferEchoes, ECHO_DEFAULTS } from './echo.mjs';

/**
 * @param {object} opts
 * @param {object} opts.data     loadCoo() 的返回值（含 hints）
 * @param {number} [opts.now]    把"现在"钉在某个时刻，方便复现
 * @param {object} [opts.knobs]  覆盖 FORGET_DEFAULTS
 * @param {object} [opts.echo]   覆盖 ECHO_DEFAULTS（也可以传 false 关掉回声）
 * @param {object} [opts.cfg]    覆盖 MIND_SEA_DEFAULTS
 */
export function buildCooSea({ data, now = Date.now(), knobs = FORGET_DEFAULTS, echo = {}, cfg = {} } = {}) {
  const seaCfg = { ...MIND_SEA_DEFAULTS, textMax: 160, ...cfg };

  const base = collectPoints({ longTerm: data.longTerm ?? [], messages: data.messages ?? [], cfg: seaCfg, now });
  const diaryPoints = (data.diaries ?? [])
    .filter((d) => d && d.text)
    .map((d) => pointFromDiary(d, { cfg: seaCfg, fullText: true, time: '23:30' }));

  const points = [...base, ...diaryPoints].filter(Boolean).sort((a, b) => a.t - b.t);

  // 回声：后来的话里提到了它，就从那一刻重新计时，并且越提越牢
  const hints = { ...(data.hints ?? {}) };
  const echoes = echo === false ? new Map() : inferEchoes(points, { ...ECHO_DEFAULTS, ...echo });
  for (const [id, entry] of echoes) {
    hints[id] = { ...(hints[id] ?? {}), hits: entry.hits, lastMentionAt: entry.lastMentionAt };
  }

  const { kept, dropped } = applyForgetting(points, hints, { now, knobs });
  const scene = buildScene({ points: kept, cfg: seaCfg, now });
  const summary = summarizeDropped(dropped);
  const byId = new Map(points.map((p) => [p.id, p]));
  const revived = Object.entries(hints)
    .filter(([, hint]) => hint.hits > 0)
    .map(([id, hint]) => ({ id, hits: hint.hits, lastMentionAt: hint.lastMentionAt, text: byId.get(id)?.text ?? '' }))
    .sort((a, b) => b.hits - a.hits);

  return {
    ok: true,
    name: data.name ?? 'memory-sea',
    ...scene,
    forget: {
      collected: points.length,
      kept: kept.length,
      dropped: dropped.length,
      aged: summary.aged,
      capacity: summary.capacity,
      byProto: summary.byProto,
      echoes: {
        revived: revived.length,
        totalMentions: revived.reduce((sum, item) => sum + item.hits, 0),
        candidates: echoes.stats?.candidates ?? 0,
        duplicatesSkipped: echoes.stats?.duplicates ?? 0,
        top: revived.slice(0, 5),
      },
      examples: dropped.slice(0, 6).map((d) => ({
        proto: d.proto,
        reason: d.reason,
        days: Math.round(d.ageDays * 10) / 10,
        strength: Math.round(d.strength * 1000) / 1000,
        text: d.point.text.slice(0, 40),
      })),
    },
  };
}
