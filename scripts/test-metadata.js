// metadata.js 单元测试：构造合成 ID3v2/FLAC/Ogg/MP4/WAV 数据验证解析
const assert = require('assert');
const path = require('path');

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  ✓', name); }
  else { fail++; console.error('  ✗', name, extra !== undefined ? JSON.stringify(extra) : ''); }
}

function fileLike(u8, name = 'test.bin') {
  const blob = new Blob([u8]);
  return { name, size: u8.length, lastModified: 0, slice: (a, b) => blob.slice(a, b) };
}

// ---------- 构造工具 ----------
function atom(type, payload) {
  const buf = Buffer.alloc(8 + payload.length);
  buf.writeUInt32BE(8 + payload.length, 0);
  buf.write(type, 4, 'latin1');
  Buffer.from(payload).copy(buf, 8);
  return buf;
}
function id3Frame(id, payload) {
  const head = Buffer.alloc(10);
  head.write(id, 0, 'latin1');
  head.writeUInt32BE(payload.length, 4);
  return Buffer.concat([head, Buffer.from(payload)]);
}
function textFrame(id, enc, str) {
  const bytes = enc === 3 ? Buffer.from(str, 'utf8')
    : enc === 1 ? Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from(str, 'utf16le')])
      : enc === 0 ? Buffer.from(str, 'latin1') : Buffer.from(str, 'utf8');
  const body = Buffer.concat([Buffer.from([enc]), bytes]);
  return id3Frame(id, body);
}

async function main() {
  const M = await import(path.resolve(__dirname, '..', 'js', 'metadata.js').replace(/\\/g, '/').replace(/^/, 'file:///'));

  // ========== 1. ID3v2.3 UTF-8 + APIC + CBR 时长 ==========
  {
    const picData = Buffer.alloc(48, 0xAB);
    const apicBody = Buffer.concat([
      Buffer.from([0]),                      // latin1
      Buffer.from('image/png\0', 'latin1'),
      Buffer.from([3]),                      // front cover
      Buffer.from([0]),                      // empty desc
      picData,
    ]);
    const frames = Buffer.concat([
      textFrame('TIT2', 3, '测试标题'),
      textFrame('TPE1', 3, '李雷'),
      textFrame('TALB', 3, '测试专辑'),
      textFrame('TRCK', 3, '3/12'),
      textFrame('TYER', 3, '2001'),
      id3Frame('APIC', apicBody),
    ]);
    const size = Buffer.alloc(4);
    // synchsafe 编码
    const s = frames.length;
    size[0] = (s >> 21) & 0x7f; size[1] = (s >> 14) & 0x7f; size[2] = (s >> 7) & 0x7f; size[3] = s & 0x7f;
    const tagHead = Buffer.concat([Buffer.from('ID3', 'latin1'), Buffer.from([3, 0, 0]), size]);
    // MPEG1 Layer3 帧：128kbps 44100Hz
    const mpeg = Buffer.alloc(1000);
    mpeg[0] = 0xFF; mpeg[1] = 0xFB; mpeg[2] = 0x90; mpeg[3] = 0x00;
    const file = fileLike(Buffer.concat([tagHead, frames, mpeg]));
    const m = await M.parseTrackMeta(file, 'mp3', { wantPicture: true });
    ok(m.title === '测试标题', 'ID3v2.3 标题', m.title);
    ok(m.artist === '李雷', 'ID3v2.3 歌手', m.artist);
    ok(m.album === '测试专辑', 'ID3v2.3 专辑', m.album);
    ok(m.trackNo === 3, 'ID3v2.3 曲目号', m.trackNo);
    ok(m.year === 2001, 'ID3v2.3 年份', m.year);
    ok(m.picture && m.picture.type === 'image/png' && m.picture.size === 48, 'ID3v2.3 APIC 封面', m.picture && m.picture.size);
    const expectDur = ((1000 + 10 + frames.length) * 8) / 128000;
    ok(m.duration && Math.abs(m.duration - expectDur) < 0.05, 'ID3v2.3 CBR 时长', { got: m.duration, expect: expectDur });
  }

  // ========== 2. ID3v2.4 synchsafe + UTF-16 ==========
  {
    const f = Buffer.concat([
      textFrame('TIT2', 1, '十六标题'),
      textFrame('TPE1', 1, '韩梅梅'),
      textFrame('TDRC', 3, '2019-06-01'),
    ]);
    const s = f.length;
    const size = Buffer.from([(s >> 21) & 0x7f, (s >> 14) & 0x7f, (s >> 7) & 0x7f, s & 0x7f]);
    const head = Buffer.concat([Buffer.from('ID3', 'latin1'), Buffer.from([4, 0, 0]), size]);
    const m = await M.parseTrackMeta(fileLike(Buffer.concat([head, f, Buffer.alloc(64)])), 'mp3');
    ok(m.title === '十六标题', 'ID3v2.4 UTF-16 标题', m.title);
    ok(m.artist === '韩梅梅', 'ID3v2.4 UTF-16 歌手', m.artist);
    ok(m.year === 2019, 'ID3v2.4 TDRC 年份', m.year);
  }

  // ========== 3. latin1 标注的 GBK 中文 ==========
  {
    const gbkBytes = Buffer.from([0xD6, 0xDC, 0xBD, 0xDC, 0xC2, 0xD7]); // 周杰伦
    const f = textFrame('TPE1', 0, gbkBytes.toString('latin1'));
    const s = f.length;
    const size = Buffer.from([(s >> 21) & 0x7f, (s >> 14) & 0x7f, (s >> 7) & 0x7f, s & 0x7f]);
    const head = Buffer.concat([Buffer.from('ID3', 'latin1'), Buffer.from([3, 0, 0]), size]);
    const m = await M.parseTrackMeta(fileLike(Buffer.concat([head, f])), 'mp3');
    ok(m.artist === '周杰伦', 'GBK 兼容解码', m.artist);
  }

  // ========== 4. FLAC ==========
  {
    // STREAMINFO: sr 44100, total 220500 → 5s
    const si = Buffer.alloc(34);
    si.writeUInt16BE(4096, 0); si.writeUInt16BE(4096, 2);
    const v = BigInt(44100) << 44n | BigInt(1) << 41n | BigInt(15) << 36n | 220500n;
    for (let i = 0; i < 8; i++) si[10 + i] = Number((v >> BigInt((7 - i) * 8)) & 0xFFn);
    const vcBody = (() => {
      const parts = [];
      const vendor = Buffer.from('test', 'utf8');
      const vlen = Buffer.alloc(4); vlen.writeUInt32LE(vendor.length);
      parts.push(vlen, vendor);
      const entries = ['TITLE=歌曲一', 'ARTIST=王小虎', 'ALBUM=专辑A'];
      const cnt = Buffer.alloc(4); cnt.writeUInt32LE(entries.length);
      parts.push(cnt);
      for (const e of entries) {
        const b = Buffer.from(e, 'utf8');
        const l = Buffer.alloc(4); l.writeUInt32LE(b.length);
        parts.push(l, b);
      }
      return Buffer.concat(parts);
    })();
    const picData = Buffer.alloc(40, 0x77);
    const picBody = Buffer.concat([
      (() => { const b = Buffer.alloc(4); b.writeUInt32BE(3); return b; })(),
      (() => { const b = Buffer.alloc(4); b.writeUInt32BE(9); return b; })(), Buffer.from('image/png', 'latin1'),
      (() => { const b = Buffer.alloc(4); b.writeUInt32BE(0); return b; })(),
      (() => { const b = Buffer.alloc(16); b.writeUInt32BE(64, 0); b.writeUInt32BE(64, 4); return b; })(),
      (() => { const b = Buffer.alloc(4); b.writeUInt32BE(picData.length); return b; })(), picData,
    ]);
    const block = (type, body, last) => {
      const h = Buffer.alloc(4);
      h[0] = (last ? 0x80 : 0) | type;
      h[1] = (body.length >> 16) & 0xff; h[2] = (body.length >> 8) & 0xff; h[3] = body.length & 0xff;
      return Buffer.concat([h, Buffer.from(body)]);
    };
    const flac = Buffer.concat([
      Buffer.from('fLaC', 'latin1'),
      block(0, si, false),
      block(4, vcBody, false),
      block(6, picBody, true),
    ]);
    const m = await M.parseTrackMeta(fileLike(flac, 'a.flac'), 'flac', { wantPicture: true });
    ok(m.title === '歌曲一', 'FLAC 标题', m.title);
    ok(m.artist === '王小虎', 'FLAC 歌手', m.artist);
    ok(m.album === '专辑A', 'FLAC 专辑', m.album);
    ok(m.duration && Math.abs(m.duration - 5) < 0.01, 'FLAC 时长', m.duration);
    ok(m.picture && m.picture.type === 'image/png' && m.picture.size === 40, 'FLAC 封面', m.picture && m.picture.size);
  }

  // ========== 5. Ogg Opus ==========
  {
    function oggPage(granule, packets) {
      const segTable = packets.map(p => p.length >= 255 ? 255 : p.length); // 简化：包 < 255
      const head = Buffer.alloc(27 + segTable.length);
      head.write('OggS', 0, 'latin1');
      head.writeUInt32LE(granule, 6); // 只写低 32 位（测试粒度 3 秒内）
      head[26] = segTable.length;
      segTable.forEach((s2, i) => { head[27 + i] = s2; });
      return Buffer.concat([head, ...packets.map(p => Buffer.from(p))]);
    }
    const opusHead = Buffer.concat([
      Buffer.from('OpusHead', 'latin1'), Buffer.from([1]), Buffer.from([1]),
      (() => { const b = Buffer.alloc(2); b.writeUInt16LE(312); return b; })(),
      (() => { const b = Buffer.alloc(4); b.writeUInt32LE(48000); return b; })(),
      Buffer.alloc(3),
    ]);
    const tagsBody = (() => {
      const parts = [Buffer.from('OpusTags', 'latin1')];
      const vlen = Buffer.alloc(4); vlen.writeUInt32LE(0); parts.push(vlen);
      const cnt = Buffer.alloc(4); cnt.writeUInt32LE(2); parts.push(cnt);
      for (const e of ['TITLE=洋流', 'ARTIST=海洋声']) {
        const b = Buffer.from(e, 'utf8');
        const l = Buffer.alloc(4); l.writeUInt32LE(b.length); parts.push(l, b);
      }
      return Buffer.concat(parts);
    })();
    const ogg = oggPage(48000 * 10, [opusHead, tagsBody]);
    const m = await M.parseTrackMeta(fileLike(ogg, 'a.opus'), 'opus');
    ok(m.title === '洋流', 'Opus 标题', m.title);
    ok(m.artist === '海洋声', 'Opus 歌手', m.artist);
    ok(m.duration && Math.abs(m.duration - (48000 * 10 - 312) / 48000) < 0.01, 'Opus 时长(含预跳)', m.duration);
  }

  // ========== 6. MP4/M4A ==========
  {
    const data = (flags, payload) => atom('data', Buffer.concat([
      (() => { const b = Buffer.alloc(4); b.writeUInt32BE(flags); return b; })(), Buffer.alloc(4), Buffer.from(payload),
    ]));
    const intData = (payload) => atom('data', Buffer.concat([
      (() => { const b = Buffer.alloc(4); b.writeUInt32BE(0x15); return b; })(), Buffer.alloc(4), Buffer.from(payload),
    ]));
    const mvhd = Buffer.concat([
      Buffer.from([0, 0, 0, 0]), Buffer.alloc(8),
      (() => { const b = Buffer.alloc(4); b.writeUInt32BE(44100); return b; })(),
      (() => { const b = Buffer.alloc(4); b.writeUInt32BE(220500); return b; })(),
    ]);
    const ilst = atom('ilst', Buffer.concat([
      atom('©nam', data(1, '苹果标题')),
      atom('©ART', data(1, '苹果歌手')),
      atom('©alb', data(1, '苹果专辑')),
      atom('trkn', intData(Buffer.from([0, 0, 0, 5, 0, 0]))),
      atom('covr', (() => {
        const jp = Buffer.alloc(40, 0xEE);
        jp[0] = 0xFF; jp[1] = 0xD8;
        return atom('data', Buffer.concat([
          (() => { const b = Buffer.alloc(4); b.writeUInt32BE(13); return b; })(), Buffer.alloc(4), jp,
        ]));
      })()),
    ]));
    const mp4 = Buffer.concat([
      atom('ftyp', Buffer.from('M4A isom', 'latin1')),
      atom('moov', Buffer.concat([
        atom('mvhd', mvhd),
        atom('udta', atom('meta', Buffer.concat([Buffer.alloc(4), ilst]))),
      ])),
      atom('mdat', Buffer.alloc(64)),
    ]);
    const m = await M.parseTrackMeta(fileLike(mp4, 'a.m4a'), 'm4a', { wantPicture: true });
    ok(m.title === '苹果标题', 'MP4 标题', m.title);
    ok(m.artist === '苹果歌手', 'MP4 歌手', m.artist);
    ok(m.album === '苹果专辑', 'MP4 专辑', m.album);
    ok(m.trackNo === 5, 'MP4 曲目号', m.trackNo);
    ok(m.duration && Math.abs(m.duration - 5) < 0.001, 'MP4 时长', m.duration);
    ok(m.picture && m.picture.type === 'image/jpeg' && m.picture.size === 40, 'MP4 封面', m.picture && m.picture.size);
  }

  // ========== 7. WAV（LIST INFO 标签） ==========
  {
    const fmt = Buffer.concat([Buffer.from([1, 0]), Buffer.from([2, 0]),
      (() => { const b = Buffer.alloc(4); b.writeUInt32LE(44100); return b; })(),
      (() => { const b = Buffer.alloc(4); b.writeUInt32LE(44100 * 4); return b; })(),
      Buffer.from([4, 0]), Buffer.from([16, 0])]);
    const infoEntry = (id, val) => {
      const b = Buffer.from(val, 'utf8');
      const h = Buffer.alloc(8); h.write(id, 0, 'latin1'); h.writeUInt32LE(b.length, 4);
      const pad = b.length % 2 ? Buffer.from([0]) : Buffer.alloc(0);
      return Buffer.concat([h, b, pad]);
    };
    const list = Buffer.concat([Buffer.from('INFO', 'latin1'), infoEntry('INAM', '波形标题'), infoEntry('IART', '波形歌手'), infoEntry('IPRD', '波形专辑')]);
    const listHead = Buffer.alloc(8); listHead.write('LIST', 0, 'latin1'); listHead.writeUInt32LE(list.length, 4);
    const dataSize = 882000;
    const dataHead = Buffer.alloc(8); dataHead.write('data', 0, 'latin1'); dataHead.writeUInt32LE(dataSize, 4);
    const fmtHead = Buffer.alloc(8); fmtHead.write('fmt ', 0, 'latin1'); fmtHead.writeUInt32LE(16, 4);
    const riffBody = Buffer.concat([Buffer.from('WAVE', 'latin1'), fmtHead, fmt, listHead, list, dataHead, Buffer.alloc(64)]);
    const riff = Buffer.concat([Buffer.from('RIFF', 'latin1'), (() => { const b = Buffer.alloc(4); b.writeUInt32LE(riffBody.length); return b; })(), riffBody]);
    const m = await M.parseTrackMeta(fileLike(riff, 'a.wav'), 'wav');
    ok(m.title === '波形标题', 'WAV 标题', m.title);
    ok(m.artist === '波形歌手', 'WAV 歌手', m.artist);
    ok(m.album === '波形专辑', 'WAV 专辑', m.album);
    ok(m.duration && Math.abs(m.duration - 5) < 0.001, 'WAV 时长', m.duration);
  }

  console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
