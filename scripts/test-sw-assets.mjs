// Service Worker 缓存清单完整性检查：node scripts/test-sw-assets.mjs
//
// 为什么需要它：sw.js 的 ASSETS 列表是**手写**的，
// 漏一个被 import 的模块不会报任何错 —— 只在离线（或缓存命中）时
// 表现为「整个应用白屏」，因为 ES module 加载失败会中断整条 import 链。
//
// 也就是说：本地开发（网络优先、SW 未激活）一切正常，
// 用户装成 PWA 断网后才炸，且错误信息与病因相隔极远。
// 这个脚本把「import 链」与「ASSETS 清单」做机器比对，杜绝漏项。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let pass = 0, fail = 0;
const fails = [];
function t(name, fn) {
  try {
    const r = fn();
    if (r === true) { pass++; console.log('PASS ' + name); }
    else { fail++; fails.push(name + ' → ' + r); console.log('FAIL ' + name + ' → ' + r); }
  } catch (e) { fail++; fails.push(name + ' 抛异常: ' + e.message); console.log('FAIL ' + name + ' 抛异常: ' + e.message); }
}

const sw = read('sw.js');
const m = sw.match(/const ASSETS = \[([\s\S]*?)\];/);
if (!m) { console.log('未找到 ASSETS 列表'); process.exit(1); }
// 必须先剥注释 —— 第一版直接按行 split，把 ASSETS 里的注释行
// 当成了清单项，报出「// 番剧库… 路径格式不对」这种假失败。
const listed = m[1]
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\/\/.*$/gm, '')
  .split('\n')
  .map(l => l.trim())
  .filter(l => l && l !== './')
  // 顺序要紧：先整体去掉两端引号与尾逗号（"'./x.js'," → "./x.js"），
  // 逐条只剥开头引号会留下 "./x.js'" 这种尾巴，害得所有条目都对不上。
  .map(l => l.replace(/,$/, '').trim().replace(/^['"]|['"]$/g, ''));

// ---- 1. 递归收集 js/ 下的真实模块 ----
function collect(dir, out = []) {
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = dir + '/' + e.name;
    if (e.isDirectory()) collect(rel, out);
    else if (e.name.endsWith('.js')) out.push('./' + rel);
  }
  return out;
}
const onDisk = collect('js');

console.log('=== 模块是否都在缓存清单里 ===');
console.log('  磁盘上 js/ 共 ' + onDisk.length + ' 个模块，清单里 ' + listed.length + ' 项\n');

for (const mod of onDisk) {
  t(mod + ' 已预缓存', () => listed.includes(mod) || '清单里没有 → 离线时 import 失败会导致全站白屏');
}

console.log('\n=== 清单里是否有磁盘上不存在的文件 ===');
// 这条同样重要：清单里写错路径，install 时的 addAll 会整体失败，
// 结果是**一个文件都没缓存**，症状同样是「离线全白」，但原因完全不同。
for (const item of listed) {
  if (item === './') continue;
  if (!item.startsWith('./')) { fails.push(item + ' 路径格式不对（应 ./ 开头）'); continue; }
  t(item + ' 在磁盘上存在', () => fs.existsSync(path.join(ROOT, item)) || '清单指向不存在的文件 → SW install 的 addAll 会整体失败');
}

console.log('\n=== 缓存版本 ===');
t('缓存版本号存在', () => /const CACHE = '.*-v\d+'/.test(sw) || '未找到版本号');

t('新增模块时版本号已升过（bili.js 对应 v3）', () => {
  const v = sw.match(/const CACHE = '.*-v(\d+)'/);
  if (!v) return '未找到版本号';
  if (Number(v[1]) < 3) return '版本仍是 v' + v[1] + '，新增 bili.js 后必须升版，否则用户继续用旧缓存';
  return true;
});

console.log('\n=== 结果 ===');
console.log('通过 ' + pass + ' / ' + (pass + fail));
if (fail) {
  console.log('\n失败明细：');
  fails.forEach(f => console.log('  · ' + f));
  process.exit(1);
}
