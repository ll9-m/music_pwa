// js/bili.js 的确定性单测。运行：node scripts/test-bili.mjs
// 不依赖 jsdom（该模块无 DOM 依赖），因此可在纯 Node 下跑。
import { parseBiliURL, embedURL, makeRecord, canEmbed, watchURL } from '../js/bili.js';

let pass = 0, fail = 0;
const fails = [];
function t(name, fn) {
  try {
    const r = fn();
    if (r === true) { pass++; console.log('PASS ' + name); }
    else { fail++; fails.push(name + ' → ' + r); console.log('FAIL ' + name + ' → ' + r); }
  } catch (e) { fail++; fails.push(name + ' 抛异常: ' + e.message); console.log('FAIL ' + name + ' 抛异常: ' + e.message); }
}

console.log('=== 用户实际会粘的链接 ===');

// 用户在需求里给的这一条，必须原样可用
t('ss4181 番剧链接 → 判定为 ss + 可跳转', () => {
  const r = parseBiliURL('https://www.bilibili.com/bangumi/play/ss4181?spm_id_from=333.337.0.0');
  if (!r.ok) return '解析失败';
  if (r.kind !== 'ss') return 'kind=' + r.kind;
  if (r.bvid !== '') return '不应有 bvid，实际=' + r.bvid;
  if (r.embeddable !== false) return 'ss 号不应声称可内嵌';
  if (r.needFetch !== true) return 'ss 号应标记需补全';
  if (r.watchURL !== 'https://www.bilibili.com/bangumi/play/ss4181') return 'watchURL=' + r.watchURL;
  return true;
});

console.log('\n=== 可立即内嵌的形态 ===');

t('BV 完整视频链接 → 可内嵌', () => {
  const r = parseBiliURL('https://www.bilibili.com/video/BV1kx411k7VB');
  if (!r.ok || r.kind !== 'bvid') return JSON.stringify(r);
  if (!r.embeddable) return '应可内嵌';
  if (r.bvid !== 'BV1kx411k7VB') return 'bvid=' + r.bvid;
  return true;
});

t('裸 BV 号 → 可内嵌', () => {
  const r = parseBiliURL('BV1kx411k7VB');
  if (!r.ok || r.bvid !== 'BV1kx411k7VB' || !r.embeddable) return JSON.stringify(r);
  return true;
});

t('带 cid 参数时取出 cid（清晰度/选集要用）', () => {
  const r = parseBiliURL('https://player.bilibili.com/player.html?bvid=BV1kx411k7VB&cid=14753412');
  if (r.cid !== 14753412) return 'cid=' + r.cid;
  return true;
});

t('同时含 bvid 与 ss 时以 bvid 为准', () => {
  const r = parseBiliURL('https://www.bilibili.com/bangumi/play/ss4181?bvid=BV1kx411k7VB');
  if (r.kind !== 'bvid' || !r.embeddable) return JSON.stringify(r);
  return true;
});

console.log('\n=== 需联网补全的形态（本地解不出，必须如实标记） ===');

t('ep 号 → needFetch + 不可内嵌', () => {
  const r = parseBiliURL('https://www.bilibili.com/bangumi/play/ep102167');
  if (r.kind !== 'ep' || !r.needFetch || r.embeddable) return JSON.stringify(r);
  if (r.epId !== 102167) return 'epId=' + r.epId;
  return true;
});

t('av 号 → needFetch', () => {
  const r = parseBiliURL('https://www.bilibili.com/video/av8937736');
  if (r.kind !== 'av' || r.aid !== 8937736 || !r.needFetch) return JSON.stringify(r);
  return true;
});

t('b23.tv 短链 → 不假装能内嵌，只给跳转', () => {
  const r = parseBiliURL('https://b23.tv/xxxxxx');
  if (r.kind !== 'short' || r.embeddable) return JSON.stringify(r);
  return true;
});

console.log('\n=== 必须拒绝的输入（安全边界） ===');

t('javascript: 协议被拒', () => {
  const r = parseBiliURL('javascript:alert(1)');
  if (r.ok) return '竟通过了';
  return true;
});

t('非 B 站域名被拒', () => {
  const r = parseBiliURL('https://evil.com/video/BV1kx411k7VB');
  if (r.ok) return '竟通过了';
  return true;
});

t('空内容被拒', () => {
  if (parseBiliURL('').ok) return '竟通过了';
  if (parseBiliURL('   ').ok) return '空白竟通过了';
  return true;
});

t('认不出的字符串被拒且给出原因', () => {
  const r = parseBiliURL('随便一段文字');
  if (r.ok) return '竟通过了';
  if (!r.reason) return '缺少失败原因';
  return true;
});

t('b23.tv 的 http 变体不被误判为需代理', () => {
  const r = parseBiliURL('http://b23.tv/abc');
  if (!r.ok || r.kind !== 'short') return JSON.stringify(r);
  return true;
});

console.log('\n=== embedURL 构造 ===');

t('基础地址含 bvid 且默认不自动播放', () => {
  const u = embedURL('BV1kx411k7VB');
  if (!u.startsWith('https://player.bilibili.com/player.html?')) return u;
  if (!u.includes('bvid=BV1kx411k7VB')) return '缺 bvid';
  if (!u.includes('autoplay=0')) return '应默认不自动播放';
  if (!u.includes('danmaku=0')) return '应关弹幕';
  return true;
});

t('无 bvid 时返回空串而不是坏地址', () => {
  if (embedURL('') !== '') return '应返回空串';
  if (embedURL(null) !== '') return 'null 应返回空串';
  return true;
});

t('传 cid 与 autoplay 时正确带上', () => {
  const u = embedURL('BV1kx411k7VB', { cid: 14753412, autoplay: true });
  if (!u.includes('cid=14753412')) return '缺 cid';
  if (!u.includes('autoplay=1')) return '缺 autoplay';
  return true;
});

console.log('\n=== 记录与派生值 ===');

t('makeRecord 归一化用户输入', () => {
  const r = makeRecord({ title: '  漆黑的子弹 ', url: 'https://www.bilibili.com/bangumi/play/ss4181', note: '  op ' });
  if (r.title !== '漆黑的子弹') return 'title 未 trim: ' + JSON.stringify(r.title);
  if (r.kind !== 'ss' || !r.seasonId) return 'kind=' + r.kind;
  if (!r.id) return '缺 id';
  return true;
});

t('canEmbed 依据 bvid 而非 kind', () => {
  if (!canEmbed(makeRecord({ url: 'BV1kx411k7VB' }))) return 'BV 应可内嵌';
  if (canEmbed(makeRecord({ url: 'https://www.bilibili.com/bangumi/play/ss4181' }))) return 'ss 不该可内嵌';
  return true;
});

t('watchURL 优先用用户原始链接（保证跳到用户给的那一页）', () => {
  const r = makeRecord({ url: 'https://www.bilibili.com/bangumi/play/ss4181?spm_id_from=333.337.0.0' });
  if (watchURL(r) !== 'https://www.bilibili.com/bangumi/play/ss4181') return watchURL(r);
  return true;
});

t('watchURL 对只有 bvid 的记录也能生成', () => {
  if (watchURL({ url: '', bvid: 'BV1kx411k7VB' }) !== 'https://www.bilibili.com/video/BV1kx411k7VB') return '异常';
  return true;
});

t('watchURL 对空记录返回空串', () => {
  if (watchURL(null) !== '') return '异常';
  if (watchURL({ url: '' }) !== '') return '异常';
  return true;
});

console.log('\n=== 结果 ===');
console.log('通过 ' + pass + ' / ' + (pass + fail));
if (fail) {
  console.log('\n失败明细：');
  fails.forEach(f => console.log('  · ' + f));
  process.exit(1);
}
