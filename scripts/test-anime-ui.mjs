// 番剧库 UI 的端到端验证：node scripts/test-anime-ui.mjs
//
// 为什么用 jsdom 而不是纯静态检查：
//   本项目坚持零运行时依赖，但**测试**可以用工作区里已有的 jsdom
//   （通过 NODE_PATH 借用，不写进 package.json，不影响产品）。
//   番剧页的真实风险全在「异步读库 → 渲染 → 点击 → 补全 → 切集」这条链上，
//   静态 grep 查不出「await 漏了导致永远是空列表」这类问题。
//
// 运行：
//   NODE_PATH=<workbuddy>/node_modules node scripts/test-anime-ui.mjs
//
// 注意：jsdom 必须用 createRequire 显式加载。
// ESM 的 import 不走 NODE_PATH（那只对 CommonJS 生效），
// 直接 `import { JSDOM } from 'jsdom'` 会报 ERR_MODULE_NOT_FOUND。
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let JSDOM;
try {
  ({ JSDOM } = require('jsdom'));
} catch {
  console.error('找不到 jsdom。请用 NODE_PATH 指向含 jsdom 的 node_modules 后重试。');
  process.exit(2);
}

let pass = 0, fail = 0;
const fails = [];
async function t(name, fn) {
  try {
    const r = await fn();
    if (r === true) { pass++; console.log('PASS ' + name); }
    else { fail++; fails.push(name + ' → ' + r); console.log('FAIL ' + name + ' → ' + r); }
  } catch (e) { fail++; fails.push(name + ' 抛异常: ' + e.message); console.log('FAIL ' + name + ' 抛异常: ' + e.message); }
}

// ---------- 搭一个够用的 DOM 环境 ----------
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const dom = new JSDOM(html, { url: 'https://local.test/', pretendToBeVisual: true });
const { window } = dom;

// index.html 里的 script 是 type=module 且 src 形式，jsdom 不执行；
// 这里手动注入需要的模块。核心是 views.js 的渲染链。
//
// IndexedDB 桩的正确写法：真实 API 是「调用方先挂 onsuccess/oncomplete，
// 库随后异步触发事件」。第一版写成同步返回对象，结果 openDB() 的 Promise
// 永不 resolve，测试直接卡死在 unsettled top-level await。
// 所以下面所有事件都用 queueMicrotask 异步派发。
const store = new Map();

/**
 * 造一个 IDBRequest 桩。
 * 关键：结果必须在**调用瞬间**求出并固定，不能等到 onsuccess 触发时才求。
 * 第一版写成 `queueMicrotask(() => { req.result = getResult(); ... })`，
 * 于是「delete 之后立刻 getAll」拿到的是求值时刻的 store 快照 ——
 * 症状是「删除后剩 2 条」，看起来像 deleteAnime 有 bug，其实是桩的求值时机错了。
 */
function makeReq(getResult) {
  const req = { onsuccess: null, onerror: null, result: undefined };
  const value = typeof getResult === 'function' ? getResult() : getResult;
  queueMicrotask(() => {
    if (req.onsuccess) { req.result = value; req.onsuccess(); }
  });
  return req;
}

const fakeDB = {
  objectStoreNames: { contains: () => true },
  transaction() {
    const t = {
      oncomplete: null, onerror: null, onabort: null,
      objectStore() {
        return {
          get: (k) => makeReq(() => store.get(k)),
          getAll: () => makeReq(() => [...store.values()]),
          put: (v) => makeReq(() => { store.set(v.id ?? v.k ?? v.rel, v); return v.id ?? v.k ?? v.rel; }),
          delete: (k) => makeReq(() => { store.delete(k); return undefined; }),
          clear: () => makeReq(() => { store.clear(); return undefined; }),
          getAllKeys: () => makeReq(() => [...store.keys()]),
        };
      },
    };
    // 事务完成事件同样异步，且排在所有请求之后
    queueMicrotask(() => queueMicrotask(() => { if (t.oncomplete) t.oncomplete(); }));
    return t;
  },
};

window.indexedDB = {
  open() {
    const req = { onupgradeneeded: null, onsuccess: null, onerror: null, result: fakeDB };
    queueMicrotask(() => { if (req.onsuccess) req.onsuccess(); });
    return req;
  },
};

const errors = [];
window.addEventListener('error', (e) => errors.push(e.message));
const origErr = window.console.error;
window.console.error = (...a) => { errors.push(a.join(' ')); origErr(...a); };

// 把浏览器全局注入主 realm。
// 原因：ESM 的 import 会让模块在**主 realm**（Node）里执行，
// 而 ui.js 等模块直接用裸全局（addEventListener / document / indexedDB…）。
// 浏览器里这些是 window 的属性，Node 里不是 —— 不注入就会
// 「ReferenceError: addEventListener is not defined」。
// 这是测试环境问题，不该为了迎合测试去改产品代码。
for (const k of ['addEventListener', 'removeEventListener', 'document', 'indexedDB',
                 'MouseEvent', 'Event', 'KeyboardEvent', 'HTMLElement', 'Node',
                 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame',
                 'localStorage', 'crypto', 'fetch', 'AbortController', 'DOMParser']) {
  const v = window[k];
  if (v === undefined) continue;
  try { globalThis[k] = typeof v === 'function' && /^[A-Z]/.test(k) ? v.bind(window) : v; }
  catch { /* 只读全局，忽略 */ }
}
globalThis.window = window;
// Node 21+ 把 navigator 变成只读 getter，直接赋值会抛 TypeError。
// 用 defineProperty 并容错：不是所有全局都需要覆盖。
try { globalThis.navigator = window.navigator; }
catch { try { Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true }); } catch { /* 忽略 */ } }
// crypto.randomUUID 需要 crypto.subtle 级别的环境，jsdom 已带 crypto
if (!globalThis.crypto || !globalThis.crypto.randomUUID) {
  globalThis.crypto = { ...(globalThis.crypto || {}), randomUUID: () => 'id-' + Math.random().toString(16).slice(2) };
}

// jsdom 不实现 IntersectionObserver（封面懒加载用它）。
// 补一个最小桩：observe/unobserve/disconnect 都是空操作。
// 番剧库测试不依赖封面懒加载行为，只要模块能加载完即可。
class IOStub {
  constructor(cb) { this.cb = cb; }
  observe() {} unobserve() {} disconnect() {} takeRecords() { return []; }
}
window.IntersectionObserver = IOStub;
globalThis.IntersectionObserver = IOStub;

// jsdom 不实现 matchMedia（prefs.js 的主题检测用）
if (!window.matchMedia) {
  const mm = (q) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent() { return false; } });
  window.matchMedia = mm;
  globalThis.matchMedia = mm;
}

// crypto.randomUUID：jsdom 未必带，补一个确定性实现
if (!globalThis.crypto || !globalThis.crypto.randomUUID) {
  const stub = { ...(globalThis.crypto || {}), randomUUID: () => 'id-' + Math.random().toString(16).slice(2) };
  try { globalThis.crypto = stub; } catch { /* 只读则忽略，测试里 id 允许重复 */ }
}

// 加载模块（views.js 会 import 一串依赖）
const views = await import(pathToFileURL(path.join(ROOT, 'js/views.js')).href);
const bili = await import(pathToFileURL(path.join(ROOT, 'js/bili.js')).href);
const db = await import(pathToFileURL(path.join(ROOT, 'js/db.js')).href);

const SS = 'https://www.bilibili.com/bangumi/play/ss4181';
const BV = 'https://www.bilibili.com/video/BV1kx411k7VB';

/**
 * 造一条番剧记录，**id 固定**。
 * 不能用 makeRecord 的随机 UUID：详情页靠 id 定位记录，
 * 而 animeList 是模块内缓存 —— 测试中途换数据后若 id 对不上，
 * renderAnimeDetail 会走「番剧不存在」分支回落到列表页，
 * 症状是「详情页用例全挂」，看起来像功能坏了。
 */
function rec(title, url, extra) {
  return Object.assign({ id: 'a1', title, url, kind: 'x', bvid: '', cid: 0, episodes: [], addedAt: 1 }, extra || {});
}

/**
 * 写库并渲染列表页。
 * animeList 是 views.js 的模块级缓存，产品代码只在 loadAnime() 时重读。
 * 测试要换数据就得让缓存失效 —— 正规做法是加一个导出，但那是为测试污染产品 API。
 * 这里改用「每次都用同一个 id a1，且先 render 一次让缓存建立，
 * 之后直接 mutate 同一个对象」的方式：对象是同一引用，缓存自动跟着变。
 */
async function seedAndRender(list, tab = 'anime') {
  store.clear();
  for (const a of list) store.set(a.id, a);
  views.nav.tab = tab;
  views.nav.detail = null;
  views.nav.search = '';
  // 第一次 render 会建立缓存；之后靠同引用 mutate 保持同步
  await views.render();
  // 把缓存里的对象与 store 里的对齐（同 id 覆盖）
  return list;
}

/** 详情页用例：确保列表已渲染（缓存已建立），再设 detail。 */
async function gotoDetail(id = 'a1', title = '') {
  views.nav.tab = 'anime';
  views.nav.detail = { type: 'anime', key: id, title: title || '番剧' };
  await views.render();
}

// 必须先 init()：views.js 把 rootEl/navEl/headerEl 等 DOM 引用缓存成模块级变量，
// 不初始化它们全是 undefined，render() 第一行就抛
// "Cannot set properties of undefined (setting 'innerHTML')"。
// 第一版测试漏了这一步，15 个渲染用例全挂 —— 看起来像功能坏了，其实是测试没起跑。
views.init();

console.log('=== 存储层 ===');

await t('anime 表可读回刚写入的记录', async () => {
  // 先种一条再读 —— 存储层用例必须自己负责备数据，
  // 不能依赖后面的列表页用例先跑（第一版把这两个放在 seed 之前，全挂）。
  await seedAndRender([rec('漆黑的子弹', SS, { kind: 'ss', seasonId: 4181 })]);
  const list = await db.getAllAnime();
  if (list.length !== 1) return '数量 ' + list.length;
  if (list[0].title !== '漆黑的子弹') return 'title=' + list[0].title;
  return true;
});

await t('番剧记录与音乐记录互不干扰（独立表、独立 keyPath）', async () => {
  // 语义验证：anime 表 keyPath 是 id，与 tracks 表的 rel 无关，
  // 所以「重新扫描音乐文件夹」不会删掉番剧。
  await seedAndRender([rec('漆黑的子弹', SS, { kind: 'ss', seasonId: 4181 })]);
  const a = await db.getAnime('a1');
  if (!a || !a.id) return '按 id 取不到';
  if ('rel' in a) return '番剧记录不应有 rel 字段';
  return true;
});

await t('删除番剧不影响其他记录', async () => {
  await seedAndRender([
    rec('第一部', SS, { kind: 'ss', seasonId: 4181 }),
    Object.assign(rec('第二部', BV, { kind: 'bvid', bvid: 'BV1kx411k7VB' }), { id: 'a2' }),
  ]);
  await db.deleteAnime('a1');
  const left = await db.getAllAnime();
  if (left.length !== 1) return '删除后剩 ' + left.length + ' 条';
  if (left[0].id !== 'a2') return '删错了记录: ' + left[0].id;
  return true;
});

console.log('\n=== 列表页 ===');

await t('番剧入口出现在导航中', async () => {
  await seedAndRender([rec('漆黑的子弹', SS, { kind: 'ss', seasonId: 4181 })]);
  const btn = document.querySelector('[data-tab="anime"]');
  if (!btn) return '导航里没有番剧入口';
  const label = btn.querySelector('.nl');
  if (!label || label.textContent !== '番剧') return '标签文案异常: ' + (label && label.textContent);
  return true;
});

await t('列表页渲染出番剧卡片', async () => {
  await seedAndRender([rec('漆黑的子弹', SS, { kind: 'ss', seasonId: 4181 })]);
  const card = document.querySelector('.anime-card');
  if (!card) return '没有渲染 .anime-card';
  const ti = card.querySelector('.ac-title');
  if (!ti || ti.textContent !== '漆黑的子弹') return '标题异常: ' + (ti && ti.textContent);
  return true;
});

await t('ss 号被如实标注为「点开跳官网」（不谎称可内嵌）', async () => {
  await seedAndRender([rec('漆黑的子弹', SS, { kind: 'ss', seasonId: 4181 })]);
  const txt = document.querySelector('.anime-card .ac-sub').textContent;
  if (!txt.includes('ss4181')) return '未显示 ss 号: ' + txt;
  if (!txt.includes('点开跳官网')) return '未标注降级: ' + txt;
  return true;
});

await t('BV 号被标注为「可内嵌」', async () => {
  await seedAndRender([rec('可内嵌的番', BV, { kind: 'bvid', bvid: 'BV1kx411k7VB' })]);
  const txt = document.querySelector('.anime-card .ac-sub').textContent;
  if (!txt.includes('可内嵌')) return '实际: ' + txt;
  return true;
});

await t('有选集时显示集数', async () => {
  await seedAndRender([rec('漆黑的子弹', SS, {
    kind: 'ss', seasonId: 4181, bvid: 'BV1kx411k7VB', cid: 14753412,
    episodes: [
      { ep: 102167, title: '1', bvid: 'BV1kx411k7VB', cid: 14753412 },
      { ep: 102168, title: '2', bvid: 'BV1W3411t7dW', cid: 14753413 },
    ],
  })]);
  const txt = document.querySelector('.anime-card .ac-sub').textContent;
  if (!txt.includes('2 集')) return '未显示集数: ' + txt;
  return true;
});

console.log('\n=== 详情页：ss 号降级（不白屏）===');

await t('ss 号详情页显示降级面板而非空 iframe', async () => {
  await seedAndRender([rec('漆黑的子弹', SS, { kind: 'ss', seasonId: 4181 })]);
  await gotoDetail('a1', '漆黑的子弹');
  if (document.querySelector('iframe')) return '竟渲染出了空 iframe（必然白屏）';
  const none = document.querySelector('.ap-none');
  if (!none) return '没有显示降级面板';
  return true;
});

await t('降级面板说明需要本地服务（给出可执行的下一步）', async () => {
  const txt = document.querySelector('.ap-none').textContent;
  if (!txt.includes('node server.js')) return '未提示: ' + txt.slice(0, 80);
  return true;
});

await t('降级面板提供「在 B 站打开」按钮', async () => {
  const btn = document.querySelector('#apGo');
  if (!btn) return '缺少跳转按钮';
  if (!btn.textContent.includes('B 站')) return '按钮文案异常: ' + btn.textContent;
  return true;
});

await t('降级面板提供「尝试补全」按钮（本地服务可用时可自愈）', async () => {
  const btn = document.querySelector('#apTry');
  if (!btn) return '缺少补全按钮';
  return true;
});

console.log('\n=== 详情页：可内嵌 ===');

await t('BV 号详情页渲染出内嵌播放器', async () => {
  await seedAndRender([rec('可内嵌的番', BV, { kind: 'bvid', bvid: 'BV1kx411k7VB' })]);
  await gotoDetail('a1', '可内嵌的番');
  const f = document.querySelector('.ap-frame iframe');
  if (!f) return '没有 iframe';
  if (!f.src.includes('player.bilibili.com')) return 'src 指向异常: ' + f.src;
  if (!f.src.includes('bvid=BV1kx411k7VB')) return '缺 bvid: ' + f.src;
  if (document.querySelector('.ap-none')) return '同时显示了降级面板（互斥失败）';
  return true;
});

await t('播放器带 allowfullscreen（移动端看番需要全屏）', async () => {
  const f = document.querySelector('.ap-frame iframe');
  if (!f.hasAttribute('allowfullscreen')) return '缺 allowfullscreen';
  return true;
});

await t('播放器关闭弹幕（音乐播放器旁边的窗口不该被弹幕盖住）', async () => {
  const f = document.querySelector('.ap-frame iframe');
  if (!f.src.includes('danmaku=0')) return '未关弹幕: ' + f.src;
  return true;
});

await t('可内嵌时详情页仍有「在 B 站打开」（内嵌失效时的唯一退路）', async () => {
  const btn = document.querySelector('#adOpen');
  if (!btn) return '缺少顶部跳转按钮';
  if (!btn.textContent.includes('B 站')) return '文案异常';
  return true;
});

console.log('\n=== 选集切换 ===');

const EPS = [
  { ep: 102167, title: '1', bvid: 'BV1kx411k7VB', cid: 14753412 },
  { ep: 102168, title: '2', bvid: 'BV1W3411t7dW', cid: 14753413 },
  { ep: 102169, title: '3', bvid: 'BV12R4y1x7GL', cid: 14753414 },
];

await t('有选集时渲染集数按钮且首集为当前', async () => {
  await seedAndRender([rec('漆黑的子弹', SS, {
    kind: 'ss', seasonId: 4181, bvid: 'BV1kx411k7VB', cid: 14753412, episodes: EPS,
  })]);
  await gotoDetail('a1', '漆黑的子弹');
  const eps = document.querySelectorAll('.ap-ep');
  if (eps.length !== 3) return '集数按钮 ' + eps.length + ' 个（应 3）';
  if (!eps[0].classList.contains('on')) return '第 1 集未标记为当前';
  return true;
});

await t('点击第 2 集切换到对应 bvid 与 cid', async () => {
  const eps = document.querySelectorAll('.ap-ep');
  eps[1].dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await new Promise(r => setTimeout(r, 40));
  const f = document.querySelector('.ap-frame iframe');
  if (!f) return '播放器消失了';
  if (!f.src.includes('BV1W3411t7dW')) return '未切到第 2 集 bvid: ' + f.src;
  if (f.src.includes('BV1kx411k7VB')) return '仍指向第 1 集';
  if (!f.src.includes('cid=14753413')) return '未带第 2 集 cid: ' + f.src;
  return true;
});

await t('切集后当前集标记跟随移动', async () => {
  const eps = document.querySelectorAll('.ap-ep');
  if (!eps[1].classList.contains('on')) return '第 2 集未标记为当前';
  if (eps[0].classList.contains('on')) return '第 1 集仍是当前（标记未更新）';
  return true;
});

console.log('\n=== 空态与搜索 ===');

await t('空库时给出引导并说明支持哪些链接', async () => {
  await seedAndRender([]);
  const e = document.querySelector('.empty');
  if (!e) return '没有空态';
  const txt = e.textContent;
  if (!txt.includes('B 站')) return '未说明: ' + txt.slice(0, 60);
  if (!txt.includes('ss') || !txt.includes('BV')) return '未列举支持的链接形态';
  return true;
});

await t('搜索无结果时给出「无匹配」而不是空白页', async () => {
  await seedAndRender([rec('漆黑的子弹', SS, { kind: 'ss', seasonId: 4181 })]);
  views.nav.search = '不存在的番剧xyz';
  await views.render();
  const e = document.querySelector('.empty');
  if (!e) return '没有空态';
  if (!e.textContent.includes('没有匹配')) return '文案异常: ' + e.textContent.slice(0, 40);
  views.nav.search = '';
  return true;
});

await t('搜索按标题命中并过滤', async () => {
  await seedAndRender([
    rec('漆黑的子弹', SS, { kind: 'ss', seasonId: 4181 }),
    Object.assign(rec('某某物语', BV, { kind: 'bvid', bvid: 'BV1W3411t7dW' }), { id: 'a2' }),
  ]);
  views.nav.search = '漆黑';
  await views.render();
  const cards = document.querySelectorAll('.anime-card');
  views.nav.search = '';
  if (cards.length !== 1) return '命中 ' + cards.length + ' 张（应 1）';
  return true;
});

await t('多条记录都能渲染（新增后不重复不丢失）', async () => {
  await seedAndRender([
    rec('漆黑的子弹', SS, { kind: 'ss', seasonId: 4181 }),
    Object.assign(rec('某某物语', BV, { kind: 'bvid', bvid: 'BV1W3411t7dW' }), { id: 'a2' }),
    Object.assign(rec('第三部', 'https://b23.tv/xxx', { kind: 'short' }), { id: 'a3' }),
  ]);
  const cards = document.querySelectorAll('.anime-card');
  if (cards.length !== 3) return '渲染 ' + cards.length + ' 张（应 3）';
  return true;
});

console.log('\n=== 控制台 ===');

await t('全程无 console.error', () => {
  if (errors.length) return errors.slice(0, 3).join(' | ');
  return true;
});

console.log('\n=== 结果 ===');
console.log('通过 ' + pass + ' / ' + (pass + fail));
if (fail) {
  console.log('\n失败明细：');
  fails.forEach(f => console.log('  · ' + f));
  process.exit(1);
}
