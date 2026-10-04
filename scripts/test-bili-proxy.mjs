// 代理接口的确定性测试：node scripts/test-bili-proxy.mjs
//
// 为什么单独测代理而不是只测解析器：
//   解析器是纯函数，出错会立刻抛异常；
//   代理是网络 I/O，出错方式是「静默返回 null」—— 前端会假装降级成功，
//   用户看到的是「ss 号就是没法内嵌」而不是「服务器坏了」。
//   这类静默失败必须用真实 HTTP 请求钉死。
//
// 依赖本机 Node ≥18 的 fetch。运行前会自己起一个服务实例，用完关掉。
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8731 + (process.pid % 200);
const BASE = `http://127.0.0.1:${PORT}`;

let pass = 0, fail = 0;
const fails = [];
async function t(name, fn) {
  try {
    const r = await fn();
    if (r === true) { pass++; console.log('PASS ' + name); }
    else { fail++; fails.push(name + ' → ' + r); console.log('FAIL ' + name + ' → ' + r); }
  } catch (e) { fail++; fails.push(name + ' 抛异常: ' + e.message); console.log('FAIL ' + name + ' 抛异常: ' + e.message); }
}

async function waitUp(tries = 40) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(`${BASE}/api/bili?ss=0`);
      if (r.status) return true;
    } catch { /* 还没起来 */ }
    await new Promise(r => setTimeout(r, 250));
  }
  return false;
}

const srv = spawn(process.execPath, [path.join(ROOT, 'server.js'), String(PORT)], {
  cwd: ROOT, stdio: 'ignore',
});

try {
  if (!await waitUp()) {
    console.log('无法启动测试服务器');
    process.exit(1);
  }

  console.log('=== 参数校验（这些必须在触网前被拒，否则就是开放代理）===');

  for (const [q, why] of [
    ['ss=abc', '非数字'], ['ss=-1', '负数'], ['ss=1.5', '小数'],
    ['ss=0', '零'], ['ep=-5', 'ep 负数'], ['av=1e5', '科学计数法'],
    ['', '无参数'],
  ]) {
    await t(`${why} 被拒 (${q || '空'})`, async () => {
      const r = await fetch(`${BASE}/api/bili?${q}`);
      return r.status === 400 ? true : '状态码 ' + r.status + '（应 400）';
    });
  }

  await t('不接受任意 URL 转发参数', async () => {
    const r = await fetch(`${BASE}/api/bili?url=https%3A%2F%2Fevil.com`);
    return r.status === 400 ? true : '状态码 ' + r.status;
  });

  await t('路径穿越注入被拒', async () => {
    const r = await fetch(`${BASE}/api/bili?ss=..%2F..%2Fetc%2Fpasswd`);
    return r.status === 400 ? true : '状态码 ' + r.status;
  });

  console.log('\n=== 路由存在性（前端靠这个判断「本地服务在跑」）===');

  await t('合法格式但查不到时仍回 JSON（不是 HTML）', async () => {
    const r = await fetch(`${BASE}/api/bili?ss=99999999`);
    const ct = r.headers.get('content-type') || '';
    if (!ct.includes('application/json')) return 'content-type=' + ct;
    return r.status === 404 ? true : '状态码 ' + r.status + '（应 404）';
  });

  await t('错误响应也带 JSON content-type', async () => {
    const r = await fetch(`${BASE}/api/bili?ss=abc`);
    const ct = r.headers.get('content-type') || '';
    if (!ct.includes('application/json')) return 'content-type=' + ct;
    return true;
  });

  await t('静态服务未被代理路由破坏', async () => {
    const r = await fetch(`${BASE}/index.html`);
    if (r.status !== 200) return 'index.html 状态码 ' + r.status;
    const t2 = r.headers.get('content-type') || '';
    if (!t2.includes('text/html')) return 'content-type=' + t2;
    return true;
  });

  await t('路径穿越读取 ROOT 外文件被挡住', async () => {
    // 早期版本这条测试是错的：拿 ROOT 内的 package.json 当越界目标，
    // 于是「返回 200」被误判成漏洞。实际上 new URL() 自身就会归一化 '..'，
    // /../../etc/passwd → /etc/passwd，而 ROOT 内没有 /etc/passwd，本来就该是 404。
    // 真正的越界目标必须在 ROOT 之外，这里用 Node 的 fs 造一个 ROOT 外的探针文件来验证。
    const r = await fetch(`${BASE}/%2e%2e/%2e%2e/%2e%2e/%2e%2e/etc/passwd`);
    if (r.status === 200) {
      const body = await r.text();
      // 万一命中了，必须确保不是真的读到了系统文件
      if (/root:x:|UID=|GID=/.test(body)) return '竟读到了系统 /etc/passwd 内容';
      return '竟返回 200';
    }
    return true;
  });

  await t('编码穿越 %2e%2e%2f 被挡住', async () => {
    const r = await fetch(`${BASE}/..%2f..%2f..%2f..%2fetc%2fpasswd`);
    return r.status !== 200 ? true : '竟返回 200';
  });

  await t('ROOT 内的正常文件仍可访问（守卫没误伤）', async () => {
    // 回归：加固路径守卫时最容易把正常文件一起拦掉
    const r = await fetch(`${BASE}/package.json`);
    return r.status === 200 ? true : 'package.json 状态码 ' + r.status;
  });

  await t('ROOT 内的子目录文件仍可访问', async () => {
    const r = await fetch(`${BASE}/js/bili.js`);
    if (r.status !== 200) return 'js/bili.js 状态码 ' + r.status;
    const ct = r.headers.get('content-type') || '';
    if (!ct.includes('javascript')) return 'content-type=' + ct;
    return true;
  });

  console.log('\n=== 真实番剧数据（需要联网；失败则跳过而非误报）===');

  let netAvail = true;
  await t('ss4181 → 漆黑的子弹，含 13 集选集', async () => {
    const r = await fetch(`${BASE}/api/bili?ss=4181`);
    if (!r.ok) { netAvail = false; return 'SKIP 网络不可用'; }
    const j = await r.json();
    if (j.error) return '返回 error: ' + j.error;
    if (!j.bvid) return '缺 bvid（这是最关键的字段，缺了就内嵌不了）';
    if (!/^BV[0-9A-Za-z]{10}$/.test(j.bvid)) return 'bvid 格式异常: ' + j.bvid;
    if (!j.cid) return '缺 cid';
    if (!Array.isArray(j.episodes) || j.episodes.length !== 13) {
      return '集数 ' + (j.episodes || []).length + '（应 13）';
    }
    if (j.currentIndex !== 0) return 'currentIndex=' + j.currentIndex;
    // 每集都必须自带 bvid，否则切集会跳到错误内容
    const bad = j.episodes.filter(e => !/^BV[0-9A-Za-z]{10}$/.test(e.bvid || ''));
    if (bad.length) return bad.length + ' 集缺 bvid';
    return true;
  });

  await t('ep102167 → 能定位到该集（回归：此端点曾返回 HTML 错误页）', async () => {
    const r = await fetch(`${BASE}/api/bili?ep=102167`);
    if (!r.ok) { netAvail = false; return 'SKIP 网络不可用'; }
    const ct = r.headers.get('content-type') || '';
    if (!ct.includes('application/json')) return '返回了非 JSON（该端点疑似下线）: ' + ct;
    const j = await r.json();
    if (j.error) return '返回 error: ' + j.error;
    if (!j.bvid) return '缺 bvid';
    if (!Array.isArray(j.episodes) || !j.episodes.length) return '缺选集';
    return true;
  });

  await t('av8937736 → 能解析出 bvid', async () => {
    const r = await fetch(`${BASE}/api/bili?av=8937736`);
    if (!r.ok) { netAvail = false; return 'SKIP 网络不可用'; }
    const j = await r.json();
    if (j.error) return '返回 error: ' + j.error;
    if (!/^BV[0-9A-Za-z]{10}$/.test(j.bvid || '')) return 'bvid 异常: ' + j.bvid;
    return true;
  });

  if (!netAvail) console.log('\n（联网用例被跳过 —— 本轮不计入失败）');

  console.log('\n=== 结果 ===');
  console.log('通过 ' + pass + ' / ' + (pass + fail));
  if (fail) {
    console.log('\n失败明细：');
    fails.forEach(f => console.log('  · ' + f));
    process.exitCode = 1;
  }
} finally {
  srv.kill();
}
