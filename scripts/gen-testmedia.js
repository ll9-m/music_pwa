// 生成浏览器端到端测试用的媒体文件（真实可播放的 WAV + LRC）
'use strict';
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', 'testmedia');
fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(path.join(OUT, 'EP'), { recursive: true });

// WAV: RIFF + fmt + LIST INFO + data（16bit PCM 单声道正弦波，带淡入淡出避免爆音）
function wav({ seconds, freq, sampleRate = 22050, tags = {} }) {
  const n = Math.floor(seconds * sampleRate);
  const dataBytes = n * 2;
  const infoParts = [];
  const entry = (id, val) => {
    const b = Buffer.from(val, 'utf8');
    const h = Buffer.alloc(8);
    h.write(id, 0, 'latin1');
    h.writeUInt32LE(b.length, 4);
    const pad = b.length % 2 ? Buffer.from([0]) : Buffer.alloc(0);
    return Buffer.concat([h, b, pad]);
  };
  if (tags.title) infoParts.push(entry('INAM', tags.title));
  if (tags.artist) infoParts.push(entry('IART', tags.artist));
  if (tags.album) infoParts.push(entry('IPRD', tags.album));
  if (tags.year) infoParts.push(entry('ICRD', tags.year));
  if (tags.genre) infoParts.push(entry('IGNR', tags.genre));
  const info = infoParts.length ? Buffer.concat([Buffer.from('INFO', 'latin1'), ...infoParts]) : null;

  const chunks = [];
  const chunk = (id, body) => {
    const h = Buffer.alloc(8);
    h.write(id, 0, 'latin1');
    h.writeUInt32LE(body.length, 4);
    const pad = body.length % 2 ? Buffer.from([0]) : Buffer.alloc(0);
    return Buffer.concat([h, body, pad]);
  };
  const fmtBody = Buffer.alloc(16);
  fmtBody.writeUInt16LE(1, 0);           // PCM
  fmtBody.writeUInt16LE(1, 2);           // mono
  fmtBody.writeUInt32LE(sampleRate, 4);
  fmtBody.writeUInt32LE(sampleRate * 2, 8); // byteRate
  fmtBody.writeUInt16LE(2, 12);          // blockAlign
  fmtBody.writeUInt16LE(16, 14);         // bits
  chunks.push(chunk('fmt ', fmtBody));
  if (info) chunks.push(chunk('LIST', info));

  const pcm = Buffer.alloc(dataBytes);
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const fade = Math.min(1, i / (sampleRate * 0.5), (n - i) / (sampleRate * 0.5));
    let v = 0;
    v += Math.sin(2 * Math.PI * freq * t) * 0.55;
    v += Math.sin(2 * Math.PI * freq * 1.5 * t) * 0.2;
    v *= fade;
    pcm.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v * 32767 * 0.8))), i * 2);
  }
  chunks.push(chunk('data', pcm));

  const body = Buffer.concat([Buffer.from('WAVE', 'latin1'), ...chunks]);
  const riff = Buffer.concat([Buffer.from('RIFF', 'latin1'), (() => { const b = Buffer.alloc(4); b.writeUInt32LE(body.length, 0); return b; })(), body]);
  return riff;
}

const files = [
  { p: '01 - 晨光.wav', wav: { seconds: 25, freq: 440, tags: { title: '晨光', artist: '晨曦乐队', album: '破晓', year: '2023', genre: 'Post Rock' } } },
  { p: '02 - 午后.wav', wav: { seconds: 18, freq: 523.25, tags: { title: '午后', artist: '晨曦乐队', album: '破晓', year: '2023', genre: 'Post Rock' } } },
  { p: '夜曲.wav', wav: { seconds: 24, freq: 349.23, tags: {} } },
  { p: 'EP/03 - 独白.wav', wav: { seconds: 15, freq: 293.66, tags: { title: '独白', artist: '晨曦乐队', album: '细语 EP', year: '2024' } } },
];
for (const f of files) {
  fs.writeFileSync(path.join(OUT, f.p), wav(f.wav));
  console.log('生成', f.p);
}

fs.writeFileSync(path.join(OUT, '夜曲.lrc'), `[ti:夜曲]
[ar:未知]
[offset:0]
[00:00.50]夜色淹没了窗台
[00:04.20]灯光在纸上摇摆
[00:08.10]写下这一段独白
[00:12.00]寄给不存在的海
[00:16.30]风把名字吹散开
[00:20.10]只剩旋律还在
`);
console.log('生成 夜曲.lrc');
