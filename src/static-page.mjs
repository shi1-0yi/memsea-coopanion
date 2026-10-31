// 把场景内嵌进 public/index.html，产出一个双击就能看的单文件页面。
// build-static 和 make-demo 都走这里，避免两份逻辑。
const LOADER = `      if (rebuild) await fetch('/api/rebuild', { method: 'POST' });
      const res = await fetch('/api/scene');
      const data = await res.json();`;
const PATCHED = `      const data = window.__SCENE__ ?? (await (await fetch('/api/scene')).json());
      if (window.__SCENE__ && rebuild) { ingest(window.__SCENE__); return; }`;

/**
 * @param {string} shell  public/index.html 的原文
 * @param {object} scene  buildCooSea() 的返回值
 * @returns {string} 可以直接写盘的单文件 HTML
 */
export function renderStaticPage(shell, scene) {
  if (!shell.includes(LOADER)) {
    throw new Error('index.html 的加载器变了：static-page.mjs 里的替换块需要跟着改');
  }
  const inline = `<script>window.__SCENE__ = ${JSON.stringify(scene).replace(/</g, '\\u003c')};</script>\n`;
  return shell.replace(LOADER, PATCHED).replace('<script>', `${inline}<script>`);
}
