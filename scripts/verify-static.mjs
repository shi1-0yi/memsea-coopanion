// 校验静态页：内嵌场景能被解析、边都指向存在的点、加载器已改成走内嵌数据。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const file = path.join(path.resolve(here, '..'), process.argv[2] || 'memory-sea.html');
const html = fs.readFileSync(file, 'utf8');

const marker = 'window.__SCENE__ = ';
const start = html.indexOf(marker);
if (start < 0) throw new Error('找不到内嵌场景');
const end = html.indexOf(';</script>', start);
const scene = JSON.parse(html.slice(start + marker.length, end));

const problems = [];
if (!scene.ok) problems.push('scene.ok 不是 true');
if (!Array.isArray(scene.points) || !scene.points.length) problems.push('没有点');
if (!Array.isArray(scene.edges)) problems.push('没有 edges 数组');
const ids = new Set(scene.points.map((p) => p.id));
if (ids.size !== scene.points.length) problems.push(`点 id 有重复：${scene.points.length - ids.size} 个`);
for (const edge of scene.edges) {
  if (!ids.has(edge.a) || !ids.has(edge.b)) problems.push(`边指向不存在的点：${edge.a} / ${edge.b}`);
  // 上游评分是 0.4*关键词 + 0.35*词面 + 0.25*同主题 + 0.05*邻近，上限 1.05
  if (!(edge.score >= 0 && edge.score <= 1.05)) problems.push(`边分数异常：${edge.score}`);
}
for (const point of scene.points.slice(0, 50)) {
  if (!(point.t > 0)) problems.push(`点没有时间戳：${point.id}`);
  if (!point.text) problems.push(`点没有文本：${point.id}`);
}
if (html.includes("if (rebuild) await fetch('/api/rebuild'")) problems.push('加载器没打补丁，双击打开时会去请求接口');
if (!html.includes('window.__SCENE__ ?? ')) problems.push('没有走内嵌数据的分支');

// 遗忘层：权重应该有梯度（日记/约定重，群聊碎话轻），而不是一刀切
const weights = scene.points.map((p) => Number(p.weight) || 0);
const distinct = new Set(weights).size;
if (distinct < 5) problems.push(`权重没有梯度（只有 ${distinct} 种取值），遗忘层可能没生效`);
if (Math.max(...weights) < 2.5) problems.push(`最重的点只有 ${Math.max(...weights)}，重要记忆没被抬高`);
if (scene.forget === undefined) problems.push('场景里没有 forget 摘要');

console.log(`点 ${scene.points.length} · 边 ${scene.edges.length} · 簇 ${Object.keys(scene.stats.byCluster).length}`);
console.log(`权重 ${Math.min(...weights)} → ${Math.max(...weights)}（${distinct} 种取值）`);
console.log(`跨度 ${new Date(scene.stats.span.from).toLocaleString('zh-CN')} → ${new Date(scene.stats.span.to).toLocaleString('zh-CN')}`);
console.log(`按类型 ${JSON.stringify(scene.stats.byKind)}`);
if (scene.forget) console.log(`遗忘 ${scene.forget.collected} → 留 ${scene.forget.kept}，忘 ${scene.forget.dropped}`);
console.log(problems.length ? `\n问题 ${problems.length} 个：\n- ${[...new Set(problems)].slice(0, 10).join('\n- ')}` : '\n校验通过：边全部闭合，加载器指向内嵌数据，权重有梯度。');
