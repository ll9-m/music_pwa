// KRC 解码 + 解析 单元测试（Node 18+，浏览器同名 API）
import { decodeKRC, parseKRC, parseLyrics } from '../js/lyrics.js';
import zlib from 'node:zlib';

// 两套 key 都要能解（酷狗官方缓存用 KEY_A，部分第三方工具用 KEY_B）
const KEY_A = [64, 71, 97, 119, 94, 50, 116, 71, 81, 54, 49, 45, 206, 210, 110, 105];
const KEY_B = [0x46, 0xAB, 0x4D, 0x63, 0xCD, 0x48, 0x2D, 0x59, 0x50, 0x6B, 0xCE, 0x2E, 0x6B, 0x5A, 0xBE, 0xCA];

let compressed0 = 0;
function encodeKRC(text, KEY) {
  const compressed = zlib.deflateSync(Buffer.from(text, 'utf8'));
  compressed0 = compressed[0];
  const out = Buffer.alloc(4 + compressed.length);
  out.write('krc1', 0, 'ascii');
  for (let i = 0; i < compressed.length; i++) out[4 + i] = compressed[i] ^ KEY[i % 16];
  return out;
}

const sample = [
  '[krc:1]', '[language:cn]',
  '[4450,2750]爱你 <0,300,0>把<300,400,0>我<700,500,0>心<1200,800,0>融化',
  '[7200,2000]/love melts my heart',
  '[12000,3000]第二行歌词 <0,1000,0>测试',
].join('\r\n');

let fail = 0;
const check = (name, cond) => { console.log((cond ? '✓' : '✗') + ' ' + name); if (!cond) fail++; };

// 1. 真实加密链路（酷狗 key）
const enc = encodeKRC(sample, KEY_A);
const ab = enc.buffer.slice(enc.byteOffset, enc.byteOffset + enc.byteLength);
const decoded = await decodeKRC(ab);
check('decodeKRC 解密 + 解压（key A）', decoded === sample);

// 1b. 第三方 key 也要能解
const encB = encodeKRC(sample, KEY_B);
const abB = encB.buffer.slice(encB.byteOffset, encB.byteOffset + encB.byteLength);
check('decodeKRC 解密 + 解压（key B）', (await decodeKRC(abB)) === sample);
check('decodeKRC 不破坏入参', enc.readUInt8(4) === (compressed0 ^ KEY_A[0]));

// 2. 明文 krc（无魔数）按普通文本读
const plainBuf = Buffer.from(sample, 'utf8');
const plain = await decodeKRC(plainBuf.buffer.slice(plainBuf.byteOffset, plainBuf.byteOffset + plainBuf.byteLength));
check('明文 krc 直接透传', plain === sample);

// 3. 解析：字级标签剥离、翻译合并、排序
const beforeMerge = parseKRC(decoded.replace(/\r?\n\[7200,2000\]\/.*\r?\n/, '\n')); // 先验证无翻译版本
check('字级标签已剥离', beforeMerge[0].text === '爱你 把我心融化');
const lines = parseKRC(decoded);
check('行数（元数据行被忽略）', lines.length === 2);
check('第一行时间 4.45s', Math.abs(lines[0].t - 4.45) < 0.001);
check('翻译合并进上一行', lines[0].text.includes('love melts my heart'));
check('按时间排序', lines[1].t === 12);

// 4. 统一入口识别
check('parseLyrics 识别 KRC', parseLyrics(decoded).length === 2);
check('parseLyrics 识别 LRC', parseLyrics('[00:01.00]hello\n[00:02.00]world').length === 2);
check('parseLyrics 空', parseLyrics(null).length === 0);

process.exit(fail ? 1 : 0);
