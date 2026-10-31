// 最小测试：拿假数据跑一遍「读 → 去重 → 回声 → 遗忘 → 成海」，把关键不变式钉住。
//   node tests/run.mjs
import assert from 'node:assert/strict';
import { makeFixture } from './fixture.mjs';

const fixture = makeFixture();
process.env.COO_HOME = fixture.dir;
process.env.GROUP_RULES = fixture.rules;
process.env.OWNER_QQ = '111111111';
process.env.SELF_QQ = '222222222';
process.env.DAYS = '30';

// 环境变量是在模块加载时读的，所以必须先设再 import
const { loadCoo } = await import('../src/coo-adapt.mjs');
const { buildCooSea } = await import('../src/sea.mjs');
const { FORGET_DEFAULTS, strengthOf, halfLifeDays } = await import('../src/forgetting.mjs');
const { dedupeMemories } = await import('../src/dedupe.mjs');
const { inferEchoes } = await import('../src/echo.mjs');

const results = [];
function test(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
    console.log(`  ok  ${name}`);
  } catch (error) {
    results.push({ name, ok: false, error });
    console.log(`FAIL  ${name}\n      ${error.message}`);
  }
}

const data = loadCoo();

console.log('\n数据层');

test('事实库读到了那条私聊', () => {
  const hit = data.longTerm.find((e) => e.text.includes('芒果'));
  assert.ok(hit, '没读到「我对芒果过敏」');
  assert.equal(hit.kind, 'fact');
});

test('关于对方的笔记按一条一条读进来', () => {
  assert.ok(data.longTerm.some((e) => e.text === '他喜欢猫' && e.topic === 'owner-profile'));
});

test('运行日志的消息读进来了（气泡 + QQ）', () => {
  assert.ok(data.messages.some((m) => m.text.includes('我在呢')), '气泡台词没读到');
  assert.ok(data.messages.some((m) => m.text.includes('芒果')), 'QQ 消息没读到');
});

test('同一条话抓两遍只留一条', () => {
  const same = data.messages.filter((m) => m.text.includes('别买芒果'));
  assert.equal(same.length, 1, `应该是 1 条，实际 ${same.length}`);
});

test('界面动作（做了:end_turn）不进海', () => {
  assert.ok(!data.messages.some((m) => m.text.includes('end_turn')));
});

test('日记读到了', () => {
  assert.equal(data.diaries.length, 1);
  assert.ok(data.diaries[0].text.includes('奶茶'));
});

test('每天看过的视频压成一条带日期的摘要', () => {
  const watch = data.longTerm.find((e) => e.id.startsWith('watch_'));
  assert.ok(watch, '没有生成观看摘要');
  assert.match(watch.text, /看了 1 个视频：《测试用视频标题》/);
});

console.log('\n群策略');

test('skip 的群整群不要', () => {
  assert.ok(!data.longTerm.some((e) => e.text.includes('今天买它')), '广告群的话漏进来了');
  assert.ok(!data.messages.some((m) => m.text.includes('今天买它')));
});

test('fade 的群还在，但被标成只遗忘', () => {
  const faded = data.longTerm.find((e) => e.text.includes('群里好安静'));
  assert.ok(faded, '闲聊群的话应该留下');
  assert.equal(data.hints[faded.id].fade, true);
});

console.log('\n遗忘与回声');

test('半衰期随重要度变长', () => {
  const low = halfLifeDays(0.2, FORGET_DEFAULTS);
  const high = halfLifeDays(0.9, FORGET_DEFAULTS);
  assert.ok(high > low * 5, `高重要度的半衰期应远大于低的：${low} vs ${high}`);
});

test('越旧强度越低', () => {
  const point = { t: Date.now() - 3 * 86_400_000 };
  const fresh = strengthOf({ t: Date.now() }, 0.5, Date.now(), FORGET_DEFAULTS);
  const old = strengthOf(point, 0.5, Date.now(), FORGET_DEFAULTS);
  assert.ok(old.strength < fresh.strength);
});

test('fade 的群重要度被压到上限', () => {
  const sea = buildCooSea({ data });
  const faded = sea.points.find((p) => p.text.includes('群里好安静'));
  assert.ok(faded, 'fade 的点应该在场景里');
  assert.ok(faded.forget.importance <= 0.3 + 1e-9, `重要度应被压到 0.3，实际 ${faded.forget.importance}`);
});

test('后来提到旧事，算一次复述', () => {
  const echoes = inferEchoes(
    [
      { id: 'a', t: Date.now() - 4 * 86_400_000, text: '我对芒果过敏', keywords: ['芒果', '过敏'], source: { type: 'longterm' } },
      { id: 'b', t: Date.now() - 60 * 60 * 1000, text: '我对芒果过敏，别买芒果', keywords: ['芒果', '过敏'], source: { type: 'message' } },
    ],
    { minGapMs: 60 * 1000 },
  );
  assert.equal(echoes.get('a')?.hits, 1, '应该记到 1 次复述');
});

test('同一条话被抓两遍不算复述', () => {
  const at = Date.now() - 4 * 86_400_000;
  const echoes = inferEchoes(
    [
      { id: 'a', t: at, text: '我对芒果过敏', keywords: ['芒果', '过敏'], source: { type: 'longterm' } },
      { id: 'b', t: at + 2 * 60 * 60 * 1000, text: '我对芒果过敏', keywords: ['芒果', '过敏'], source: { type: 'message' } },
    ],
    { minGapMs: 60 * 1000 },
  );
  assert.equal(echoes.get('a'), undefined, '近重复不该算复述');
});

console.log('\n场景');

const sea = buildCooSea({ data });

test('点非空、边都闭合', () => {
  assert.ok(sea.points.length > 3, `点太少：${sea.points.length}`);
  const ids = new Set(sea.points.map((p) => p.id));
  for (const edge of sea.edges) {
    assert.ok(ids.has(edge.a) && ids.has(edge.b), `边指向不存在的点：${edge.a}/${edge.b}`);
  }
});

test('权重有梯度（不是一刀切）', () => {
  const weights = new Set(sea.points.map((p) => p.weight));
  assert.ok(weights.size >= 3, `权重只有 ${weights.size} 种取值`);
});

test('日记的权重高于闲聊群的话', () => {
  const diary = sea.points.find((p) => p.diary);
  const chat = sea.points.find((p) => p.text.includes('群里好安静'));
  assert.ok(diary && chat, '缺对比样本');
  assert.ok(diary.weight > chat.weight, `日记 ${diary.weight} 应高于闲聊 ${chat.weight}`);
});

console.log('\n去重单元');

test('超过窗口的同文不合并', () => {
  const out = dedupeMemories({
    messages: [
      { id: '1', text: '在吗', at: 1_000_000 },
      { id: '2', text: '在吗', at: 1_000_000 + 3 * 60 * 60 * 1000 },
    ],
  });
  assert.equal(out.messages.length, 2);
});

fixture.cleanup();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
if (failed.length) {
  process.exitCode = 1;
}
