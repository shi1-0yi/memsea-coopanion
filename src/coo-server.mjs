// Coopanion × memory-sea：把 Coo 的记忆读进来，起一个本地页面。
//   GET  /api/scene    → 星海（点 / 边 / 统计 / 遗忘摘要）
//   POST /api/rebuild  → 重新读一遍 Coo 的记忆目录，再算一遍（时间推进，忘掉的自然就没了）
//   GET  /api/health   → 点数与数据源摘要
// 数据来源见 coo-adapt.mjs，遗忘曲线见 forgetting.mjs；这里只管服务，不写任何文件。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCoo, groupRules } from './coo-adapt.mjs';
import { buildCooSea } from './sea.mjs';
import { FORGET_DEFAULTS } from './forgetting.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || '127.0.0.1';

const knobs = {
  ...FORGET_DEFAULTS,
  enabled: process.env.FORGET !== '0',
  ...(process.env.FLOOR ? { floor: Number(process.env.FLOOR) } : {}),
  ...(process.env.HALF_SCALE ? { halfScale: Number(process.env.HALF_SCALE) } : {}),
  ...(process.env.HALF_CURVE ? { halfCurve: Number(process.env.HALF_CURVE) } : {}),
  ...(groupRules.fadeImportanceCap ? { fadeCap: Number(groupRules.fadeImportanceCap) } : {}),
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

let snapshot = loadCoo();
let scene = buildCooSea({ data: snapshot, knobs });

const summary = (s) =>
  `点 ${s.stats.total} · 线 ${s.stats.edges} · 忘掉 ${s.forget.dropped}/${s.forget.collected}` +
  (snapshot.stats.span
    ? ` · ${snapshot.stats.span.from.toISOString().slice(0, 10)} → ${snapshot.stats.span.to.toISOString().slice(0, 10)}`
    : '');

function json(res, body, status = 200) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || host}`);

  if (url.pathname === '/api/scene') {
    const focusIds = (url.searchParams.get('focus') || '').split(',').filter(Boolean);
    const limit = Number(url.searchParams.get('limit') || 0);
    const points = limit > 0 ? scene.points.slice(-limit) : scene.points;
    const ids = new Set(points.map((p) => p.id));
    return json(res, {
      ...scene,
      points,
      edges: scene.edges.filter((e) => ids.has(e.a) && ids.has(e.b)),
      focusIds,
    });
  }
  if (url.pathname === '/api/rebuild' && req.method === 'POST') {
    snapshot = loadCoo();
    scene = buildCooSea({ data: snapshot, knobs });
    console.log(`[memsea-coo] 重建：${summary(scene)}`);
    return json(res, { ok: true, points: scene.stats.total, builtAt: Date.now() });
  }
  if (url.pathname === '/api/health') {
    return json(res, { ok: true, points: scene.stats.total, forget: scene.forget, source: snapshot.stats });
  }

  const rel = url.pathname === '/' ? 'public/index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
  const file = path.resolve(root, rel);
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end('Not found');
  }
  res.writeHead(200, {
    'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'cache-control': 'no-cache',
  });
  fs.createReadStream(file).pipe(res);
});

server.listen(port, host, () => {
  console.log(`[memsea-coo] http://${host}:${port}`);
  console.log(`[memsea-coo] ${summary(scene)}`);
  console.log(`[memsea-coo] 来源：${snapshot.stats.home}（只读，最近 ${snapshot.stats.days} 天）`);
});
