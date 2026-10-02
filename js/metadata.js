// 音频元数据解析：ID3v2.2/2.3/2.4 + ID3v1、FLAC、MP4/M4A、Ogg(Vorbis/Opus)、WAV
// 全部通过文件切片读取，不整文件载入内存。支持内嵌封面提取与中文 GBK 兼容。

const HEAD = 512 * 1024;   // 头部读取量
const HEAD_BIG = 2 * 1024 * 1024;
const TAIL = 128 * 1024;   // 尾部读取量（ID3v1 / Ogg 末页）

const tdLatin = new TextDecoder('latin1');
const tdUtf8 = new TextDecoder('utf-8');
const tdUtf8Strict = new TextDecoder('utf-8', { fatal: true });
const tdUtf16le = new TextDecoder('utf-16le');
const tdUtf16be = new TextDecoder('utf-16be');
const tdGbk = (() => { try { return new TextDecoder('gbk'); } catch { return null; } })();

const rd = (f, start, end) => f.slice(start, end).arrayBuffer().then(b => new Uint8Array(b));

// latin1 且含高位字节时判定真实编码：优先严格 UTF-8（含 CJK 才采用），其次 GBK，最后 latin1
function decodeMaybeGbk(bytes) {
  let hasHigh = false;
  for (const b of bytes) if (b > 0x7f) { hasHigh = true; break; }
  const latin = tdLatin.decode(bytes).replace(/\0+$/, '');
  if (!hasHigh) return latin;
  try {
    const u = tdUtf8Strict.decode(bytes).replace(/\0+$/, '');
    if (/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(u)) return u;
  } catch { /* 非 UTF-8 */ }
  if (tdGbk) {
    try {
      const gbk = tdGbk.decode(bytes).replace(/\0+$/, '');
      if (!gbk.includes('\uFFFD')) return gbk;
    } catch { /* fallthrough */ }
  }
  return latin;
}

function decodeText(bytes, enc) {
  if (!bytes || !bytes.length) return '';
  switch (enc) {
    case 0: return decodeMaybeGbk(bytes);
    case 1: {
      if (bytes[0] === 0xFF && bytes[1] === 0xFE) return tdUtf16le.decode(bytes.subarray(2));
      if (bytes[0] === 0xFE && bytes[1] === 0xFF) return tdUtf16be.decode(bytes.subarray(2));
      return tdUtf16le.decode(bytes);
    }
    case 2: return tdUtf16be.decode(bytes);
    default: return tdUtf8.decode(bytes);
  }
}
const stripNull = (s) => (s || '').replace(/\0/g, '').trim();

const syncsafe = (b, o) => ((b[o] & 0x7f) << 21) | ((b[o + 1] & 0x7f) << 14) | ((b[o + 2] & 0x7f) << 7) | (b[o + 3] & 0x7f);
const be32 = (b, o) => (b[o] << 24 | b[o + 1] << 16 | b[o + 2] << 8 | b[o + 3]) >>> 0;
const be24 = (b, o) => (b[o] << 16 | b[o + 1] << 8 | b[o + 2]) >>> 0;
const be16 = (b, o) => (b[o] << 8 | b[o + 1]) >>> 0;
const le32 = (b, o) => (b[o] | b[o + 1] << 8 | b[o + 2] << 16 | b[o + 3] << 24) >>> 0;
const le16 = (b, o) => (b[o] | b[o + 1] << 8) >>> 0;

function parseTrackNum(v) {
  if (!v) return undefined;
  const m = String(v).match(/\d+/);
  return m ? parseInt(m[0], 10) : undefined;
}
function parseYear(v) {
  if (!v) return undefined;
  const m = String(v).match(/\d{4}/);
  return m ? parseInt(m[0], 10) : undefined;
}

// 解析 vorbis comment 字节块（LE32 长度结构）
function parseVorbisComments(u8, pos) {
  const out = {};
  try {
    const vendorLen = le32(u8, pos); pos += 4 + vendorLen;
    const count = le32(u8, pos); pos += 4;
    for (let i = 0; i < count && pos + 4 <= u8.length; i++) {
      const len = le32(u8, pos); pos += 4;
      if (pos + len > u8.length) break;
      const kv = tdUtf8.decode(u8.subarray(pos, pos + len));
      pos += len;
      const eq = kv.indexOf('=');
      if (eq > 0) {
        const k = kv.slice(0, eq).toUpperCase();
        if (!out[k]) out[k] = kv.slice(eq + 1);
      }
    }
    return { ok: true, tags: out };
  } catch { return { ok: false, tags: out }; }
}

function flacPicture(u8, pos) {
  try {
    const type = be32(u8, pos); pos += 4;
    const mimeLen = be32(u8, pos); pos += 4;
    const mime = tdLatin.decode(u8.subarray(pos, pos + mimeLen)); pos += mimeLen;
    const descLen = be32(u8, pos); pos += 4 + descLen;
    pos += 16; // w,h,depth,colors
    const dataLen = be32(u8, pos); pos += 4;
    if (pos + dataLen > u8.length) return null;
    const data = u8.slice(pos, pos + dataLen);
    return { type, mime: mime.toLowerCase(), data };
  } catch { return null; }
}

// ---------------- ID3v2 ----------------
function parseID3v2(u8, wantPicture) {
  if (u8.length < 10 || u8[0] !== 0x49 || u8[1] !== 0x44 || u8[2] !== 0x33) return null;
  const ver = u8[3];
  const flags = u8[5];
  const size = syncsafe(u8, 6);
  let body = u8.subarray(10, Math.min(10 + size, u8.length));

  // 全局去同步化（v2.2/2.3）
  if (flags & 0x80 && ver < 4) {
    const out = new Uint8Array(body.length);
    let n = 0;
    for (let i = 0; i < body.length; i++) {
      out[n++] = body[i];
      if (body[i] === 0xFF && body[i + 1] === 0x00) i++;
    }
    body = out.subarray(0, n);
  }

  let pos = 0;
  // 扩展头
  if (flags & 0x40) {
    if (ver === 3) { const es = be32(body, 0); pos += es + 4; }
    else if (ver === 4) { pos += syncsafe(body, 0); }
  }

  const meta = {};
  let picture = null;
  const idLen = ver === 2 ? 3 : 4;

  while (pos + (ver === 2 ? 6 : 10) <= body.length) {
    const id = tdLatin.decode(body.subarray(pos, pos + idLen));
    if (!/^[A-Z0-9]{3,4}$/.test(id)) break; // 进入 padding
    let fsize, fflags = 0, fstart = pos + idLen;
    if (ver === 2) {
      fsize = (body[pos + 3] << 16) | (body[pos + 4] << 8) | body[pos + 5];
      fstart = pos + 6;
    } else {
      fsize = ver === 4 ? syncsafe(body, pos + 4) : be32(body, pos + 4);
      fflags = (body[pos + 8] << 8) | body[pos + 9];
      fstart = pos + 10;
    }
    if (fsize <= 0 || fstart + fsize > body.length) break;
    let data = body.subarray(fstart, fstart + fsize);
    pos = fstart + fsize;

    // v2.4 帧级去同步化 / 长度指示
    if (ver === 4) {
      if (fflags & 0x02) {
        const out = new Uint8Array(data.length);
        let n = 0;
        for (let i = 0; i < data.length; i++) {
          out[n++] = data[i];
          if (data[i] === 0xFF && data[i + 1] === 0x00) i++;
        }
        data = out.subarray(0, n);
      }
      if (fflags & 0x01) data = data.subarray(4);
    }

    const t = () => {
      if (data.length < 1) return '';
      return stripNull(decodeText(data.subarray(1), data[0]));
    };

    switch (id) {
      case 'TIT2': case 'TT2': if (!meta.title) meta.title = t(); break;
      case 'TPE1': case 'TP1': if (!meta.artist) meta.artist = t(); break;
      case 'TALB': case 'TAL': if (!meta.album) meta.album = t(); break;
      case 'TPE2': case 'TP2': if (!meta.albumArtist) meta.albumArtist = t(); break;
      case 'TRCK': case 'TRK': if (meta.trackNo == null) meta.trackNo = parseTrackNum(t()); break;
      case 'TPOS': case 'TPA': if (meta.discNo == null) meta.discNo = parseTrackNum(t()); break;
      case 'TDRC': case 'TYER': case 'TYE': if (meta.year == null) meta.year = parseYear(t()); break;
      case 'TCON': case 'TCO': if (!meta.genre) meta.genre = t(); break;
      case 'APIC': case 'PIC': {
        if (!wantPicture || picture) break;
        let p = 0;
        const enc = data[p]; p += 1;
        let mime;
        if (id === 'PIC') {
          mime = { PNG: 'image/png', JPG: 'image/jpeg', JPEG: 'image/jpeg' }[tdLatin.decode(data.subarray(p, p + 3)).toUpperCase()] || 'image/jpeg';
          p += 3;
        } else {
          let end = p;
          while (end < data.length && data[end] !== 0) end++;
          mime = (tdLatin.decode(data.subarray(p, end)) || 'image/jpeg').toLowerCase();
          p = end + 1;
        }
        p += 1; // picture type
        // 描述字段按编码定长结束符
        if (enc === 1 || enc === 2) { while (p + 1 < data.length && !(data[p] === 0 && data[p + 1] === 0)) p += 2; p += 2; }
        else { while (p < data.length && data[p] !== 0) p++; p += 1; }
        if (p < data.length) picture = { mime, type: 3, data: data.slice(p) };
        break;
      }
    }
    if (meta.title && meta.artist && meta.album && meta.trackNo != null && meta.year != null && (!wantPicture || picture)) break;
  }
  return { meta, picture, tagEnd: 10 + size };
}

function parseID3v1(u8) {
  if (u8.length < 128) return null;
  const off = u8.length - 128;
  if (tdLatin.decode(u8.subarray(off, off + 3)) !== 'TAG') return null;
  const cut = (s, o, l) => stripNull(decodeMaybeGbk(u8.subarray(o, o + l)));
  return {
    title: cut(0, off + 3, 30),
    artist: cut(0, off + 33, 30),
    album: cut(0, off + 63, 30),
    year: parseYear(cut(0, off + 93, 4)),
    trackNo: u8[off + 126] === 0 && u8[off + 127] !== 0 ? u8[off + 127] : undefined,
  };
}

// MP3 时长：Xing/VBRI 帧数或 CBR 估算
function mp3Duration(head, tail, fileSize, tagEnd) {
  const findFrame = (start) => {
    for (let i = start; i < Math.min(head.length - 4, start + 65536); i++) {
      if (head[i] === 0xFF && (head[i + 1] & 0xE0) === 0xE0) {
        const verBits = (head[i + 1] >> 3) & 3;   // 3=MPEG1, 2=MPEG2, 0=MPEG2.5
        const layer = (head[i + 1] >> 1) & 3;      // 1=Layer3
        if (layer !== 1 || verBits === 1) continue;
        const brIdx = (head[i + 2] >> 4) & 15;
        const srIdx = (head[i + 2] >> 2) & 3;
        if (brIdx === 0 || brIdx === 15 || srIdx === 3) continue;
        const srTab = verBits === 3 ? [44100, 48000, 32000] : verBits === 2 ? [22050, 24000, 16000] : [11025, 12000, 8000];
        const brTab = verBits === 3 ? [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320] : [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
        const samples = verBits === 3 ? 1152 : 576;
        return { i, bitrate: brTab[brIdx] * 1000, sampleRate: srTab[srIdx], samples, verBits };
      }
    }
    return null;
  };
  const fr = findFrame(tagEnd > 0 ? tagEnd : 0);
  if (!fr) return undefined;
  // Xing/Info/VBRI 头位于帧头 + 侧信息之后
  const cand = fr.verBits === 3 ? [fr.i + 4 + 32, fr.i + 4 + 17] : [fr.i + 4 + 17, fr.i + 4 + 9];
  for (const o of cand) {
    if (o + 16 > head.length) continue;
    const sig = tdLatin.decode(head.subarray(o, o + 4));
    if (sig === 'Xing' || sig === 'Info') {
      const flags2 = be32(head, o + 4);
      if (flags2 & 1) {
        const frames = be32(head, o + 8);
        if (frames > 0) return (frames * fr.samples) / fr.sampleRate;
      }
      break;
    }
  }
  const vbriOff = fr.i + 4 + 32;
  if (vbriOff + 18 <= head.length && tdLatin.decode(head.subarray(vbriOff, vbriOff + 4)) === 'VBRI') {
    const frames = be32(head, vbriOff + 14);
    if (frames > 0) return (frames * fr.samples) / fr.sampleRate;
  }
  if (fr.bitrate > 0) return ((fileSize - (tagEnd || 0)) * 8) / fr.bitrate;
  return undefined;
}

// ---------------- FLAC ----------------
function parseFLAC(u8, wantPicture) {
  if (u8.length < 8) return null;
  let pos = 4;
  const meta = {};
  let picture = null, duration;
  while (pos + 4 <= u8.length) {
    const b0 = u8[pos];
    const last = b0 & 0x80, type = b0 & 0x7f;
    const len = be24(u8, pos + 1);
    const start = pos + 4;
    if (start + len > u8.length) {
      if (!last) return { meta, picture, truncated: true };
      break;
    }
    if (type === 0 && len >= 18) { // STREAMINFO
      const sr = (u8[start + 10] << 12) | (u8[start + 11] << 4) | (u8[start + 12] >> 4);
      const hi = u8[start + 13] & 0x0F, lo = be32(u8, start + 14);
      const tot = hi * 4294967296 + lo;
      if (sr > 0 && tot > 0) duration = tot / sr;
    } else if (type === 4) { // VORBIS_COMMENT
      const { tags } = parseVorbisComments(u8, start);
      applyVorbis(meta, tags);
    } else if (type === 6 && wantPicture && !picture) {
      picture = flacPicture(u8, start);
    }
    pos = start + len;
    if (last) break;
  }
  return { meta, picture, duration };
}

function applyVorbis(meta, tags) {
  if (!meta.title && tags.TITLE) meta.title = tags.TITLE;
  if (!meta.artist && tags.ARTIST) meta.artist = tags.ARTIST;
  if (!meta.album && tags.ALBUM) meta.album = tags.ALBUM;
  if (!meta.albumArtist && (tags.ALBUMARTIST || tags['ALBUM ARTIST'])) meta.albumArtist = tags.ALBUMARTIST || tags['ALBUM ARTIST'];
  if (meta.trackNo == null && tags.TRACKNUMBER) meta.trackNo = parseTrackNum(tags.TRACKNUMBER);
  if (meta.discNo == null && tags.DISCNUMBER) meta.discNo = parseTrackNum(tags.DISCNUMBER);
  if (meta.year == null && (tags.DATE || tags.YEAR || tags['ORIGINAL DATE'])) meta.year = parseYear(tags.DATE || tags.YEAR || tags['ORIGINAL DATE']);
  if (!meta.genre && tags.GENRE) meta.genre = tags.GENRE;
}

// ---------------- Ogg (Vorbis / Opus) ----------------
function oggPages(u8) {
  // 返回前 N 个包（数据段拼接）
  const packets = [];
  let pos = 0;
  let cur = null;
  while (pos + 27 <= u8.length) {
    if (!(u8[pos] === 0x4f && u8[pos + 1] === 0x67 && u8[pos + 2] === 0x67 && u8[pos + 3] === 0x53)) {
      // 同步到下一个 OggS
      const idx = u8.indexOf(0x4f, pos + 1);
      if (idx < 0 || tdLatin.decode(u8.subarray(idx, idx + 4)) !== 'OggS') break;
      pos = idx;
    }
    const nsegs = u8[pos + 26];
    const segTable = u8.subarray(pos + 27, pos + 27 + nsegs);
    let payload = pos + 27 + nsegs;
    if (payload > u8.length) break;
    for (let s = 0; s < nsegs; s++) {
      const seg = u8.subarray(payload, Math.min(payload + segTable[s], u8.length));
      if (!cur) cur = [];
      cur.push(seg);
      payload += segTable[s];
      if (segTable[s] < 255) { // 包结束
        const total = cur.reduce((a, c) => a + c.length, 0);
        const buf = new Uint8Array(total);
        let o = 0;
        for (const c of cur) { buf.set(c, o); o += c.length; }
        packets.push(buf);
        cur = null;
        if (packets.length >= 3) return packets;
      }
    }
    pos = payload;
  }
  if (cur) {
    const total = cur.reduce((a, c) => a + c.length, 0);
    const buf = new Uint8Array(total);
    let o = 0;
    for (const c of cur) { buf.set(c, o); o += c.length; }
    packets.push(buf);
  }
  return packets;
}

function parseOgg(u8, tail, wantPicture) {
  if (u8.length < 4) return null;
  const meta = {};
  let duration;
  const packets = oggPages(u8);
  let sampleRate, preSkip = 0, isOpus = false, isVorbis = false;
  if (packets.length && startsWithStr(packets[0], 'OpusHead')) {
    isOpus = true;
    preSkip = le16(packets[0], 10);
  } else if (packets.length && packets[0][0] === 1 && startsWithStr(packets[0], '\x01vorbis', 1)) {
    isVorbis = true;
    sampleRate = le32(packets[0], 12);
  }
  if (packets.length >= 2) {
    const p1 = packets[1];
    let cStart = -1;
    if (startsWithStr(p1, '\x03vorbis', 1)) cStart = 7;
    else if (startsWithStr(p1, 'OpusTags')) cStart = 8;
    if (cStart >= 0) {
      const { ok, tags } = parseVorbisComments(p1, cStart);
      applyVorbis(meta, tags);
      // Ogg 内嵌图片（METADATA_BLOCK_PICTURE，base64）
      if (wantPicture && !meta.pictureDone) {
        const b64 = tags.METADATA_BLOCK_PICTURE;
        if (b64 && !b64.startsWith('http')) {
          try {
            const bin = atob(b64.replace(/\s/g, ''));
            const u = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
            meta._oggPicture = flacPicture(u, 0);
          } catch { /* 忽略 */ }
        }
      }
      if (!ok) meta._commentsTruncated = true;
    }
  }
  // 时长：最后一个 OggS 页的 granule
  const src = tail && tail.length > 1024 ? tail : u8;
  let last = -1;
  for (let i = src.length - 4; i >= 0; i--) {
    if (src[i] === 0x4f && src[i + 1] === 0x67 && src[i + 2] === 0x67 && src[i + 3] === 0x53) { last = i; break; }
  }
  if (last >= 0) {
    const granule = Number(src[last + 6] | src[last + 7] << 8 | src[last + 8] << 16 | src[last + 9] << 24) +
      (src[last + 10] | src[last + 11] << 8 | src[last + 12] << 16 | src[last + 13] << 24) * 4294967296;
    if (isOpus) duration = Math.max(0, (granule - preSkip) / 48000);
    else if (isVorbis && sampleRate) duration = granule / sampleRate;
  }
  return { meta, picture: meta._oggPicture || null, duration };
}
function startsWithStr(a, s, off = 0) {
  for (let i = 0; i < s.length; i++) if (a[off + i] !== s.charCodeAt(i)) return false;
  return true;
}

// ---------------- WAV ----------------
const validChunkId = (u8, o) =>
  o + 4 <= u8.length && /^[A-Za-z0-9 \-_]{4}$/.test(tdLatin.decode(u8.subarray(o, o + 4)));

function parseWAV(u8, wantPicture) {
  if (u8.length < 12 || tdLatin.decode(u8.subarray(0, 4)) !== 'RIFF' || tdLatin.decode(u8.subarray(8, 12)) !== 'WAVE') return null;
  const meta = {};
  let duration, picture = null;
  let pos = 12;
  let byteRate = 0;
  while (pos + 8 <= u8.length) {
    const id = tdLatin.decode(u8.subarray(pos, pos + 4));
    const size = le32(u8, pos + 4);
    const start = pos + 8;
    if (id === 'fmt ' && start + 16 <= u8.length) {
      byteRate = le32(u8, start + 8);
    } else if (id === 'data') {
      if (byteRate > 0) duration = size / byteRate;
    } else if (id === 'LIST' && start + size <= u8.length) {
      if (tdLatin.decode(u8.subarray(start, start + 4)) === 'INFO') {
        let p = start + 4;
        while (p + 8 <= start + size) {
          const sid = tdLatin.decode(u8.subarray(p, p + 4));
          const ssz = le32(u8, p + 4);
          const val = stripNull(decodeMaybeGbk(u8.subarray(p + 8, Math.min(p + 8 + ssz, u8.length))));
          if (sid === 'INAM' && !meta.title) meta.title = val;
          if (sid === 'IART' && !meta.artist) meta.artist = val;
          if (sid === 'IPRD' && !meta.album) meta.album = val;
          if (sid === 'ICRD' && meta.year == null) meta.year = parseYear(val);
          if (sid === 'IGNR' && !meta.genre) meta.genre = val;
          if (sid === 'ITRK' && meta.trackNo == null) meta.trackNo = parseTrackNum(val);
          p += 8 + ssz + (ssz % 2);
        }
      }
    } else if ((id === 'id3 ' || id === 'ID3 ') && !meta.title && start + 10 <= u8.length) {
      const r = parseID3v2(u8.subarray(start), wantPicture);
      if (r) { Object.assign(meta, r.meta); if (r.picture) picture = r.picture; }
    }
    // 步进到下一块；对缺少对齐填充的非常规文件做容错
    let next = start + size + (size % 2);
    if (!validChunkId(u8, next)) {
      if (validChunkId(u8, start + size)) next = start + size;
      else if (validChunkId(u8, next + 1)) next += 1;
    }
    pos = next;
    if (id === 'data') break;
  }
  // 兜底：步进脱轨时直接搜索 data 块
  if (duration == null && byteRate > 0) {
    for (let i = 12; i + 8 <= u8.length; i++) {
      if (u8[i] === 0x64 && u8[i + 1] === 0x61 && u8[i + 2] === 0x74 && u8[i + 3] === 0x61 && validChunkId(u8, i)) {
        const sz = le32(u8, i + 4);
        if (sz > 0 && sz <= u8.length) { duration = sz / byteRate; break; }
      }
    }
  }
  return { meta, picture, duration };
}

// ---------------- MP4 / M4A ----------------
const CONTAINERS = new Set(['moov', 'udta', 'trak', 'mdia', 'minf', 'stbl', 'ilst', 'meta']);

async function mp4Walk(file, opts) {
  const out = { tags: {}, mvhd: null, pictures: [] };
  const read = async (start, end) => new Uint8Array(await file.slice(start, end).arrayBuffer());

  async function walk(start, end, depth) {
    let pos = start;
    while (pos + 8 <= end && depth < 8) {
      const hdr = await read(pos, Math.min(pos + 16, end));
      if (hdr.length < 8) break;
      let size = be32(hdr, 0);
      const type = tdLatin.decode(hdr.subarray(4, 8));
      let hdrLen = 8;
      if (size === 1) {
        if (hdr.length < 16) break;
        size = Number((BigInt(hdr[8] & 0x7f) << 56n) | (BigInt(hdr[9]) << 48n) | (BigInt(hdr[10]) << 40n) | (BigInt(hdr[11]) << 32n) | (BigInt(hdr[12]) << 24n) | (BigInt(hdr[13]) << 16n) | (BigInt(hdr[14]) << 8n) | BigInt(hdr[15]));
        hdrLen = 16;
      } else if (size === 0) {
        size = end - pos;
      }
      if (size < hdrLen || pos + size > end + 1) break;
      const bodyStart = pos + hdrLen;
      const bodyEnd = Math.min(pos + size, end);

      if (type === 'meta') {
        await walk(bodyStart + 4, bodyEnd, depth + 1); // 跳过 version/flags
      } else if (CONTAINERS.has(type)) {
        await walk(bodyStart, bodyEnd, depth + 1);
      } else if (type === 'mvhd' && !out.mvhd) {
        const b = await read(bodyStart, Math.min(bodyStart + 32, bodyEnd));
        if (b.length >= 20) {
          if (b[0] === 0) out.mvhd = { timescale: be32(b, 12), duration: be32(b, 16) };
          else if (b.length >= 28) out.mvhd = { timescale: be32(b, 20), duration: Number(be64ish(b, 24)) };
        }
      } else if (type.startsWith('©') || /^[a-zA-Z0-9]{4}$/.test(type)) {
        // ilst 的条目：内部含 data 原子
        if (opts.ilst && opts.ilst.has(type)) {
          await readIlstItem(file, bodyStart, bodyEnd, type, out);
        }
      }
      pos += size;
      if (size === 0) break;
    }
  }

  async function readIlstItem(file2, start, end, itemType, out) {
    let pos = start;
    while (pos + 8 <= end) {
      const hdr = await read(pos, pos + 8);
      const size = be32(hdr, 0);
      const t = tdLatin.decode(hdr.subarray(4, 8));
      if (size < 8 || pos + size > end) break;
      if (t === 'data' && size >= 16) {
        const b = await read(pos + 8, pos + size);
        const flags = be32(b, 0) & 0xFFFFFF;
        const payload = b.subarray(8);
        if (itemType === 'covr') {
          const mime = flags === 14 ? 'image/png' : 'image/jpeg';
          out.pictures.push({ mime, type: 3, data: payload.slice() });
        } else {
          const val = flags === 1 ? tdUtf8.decode(payload) : intPayload(payload);
          out.tags[itemType] = out.tags[itemType] || val;
        }
      }
      pos += size;
    }
  }

  await walk(0, file.size, 0);
  return out;
}
function be64ish(b, o) { return (b[o] * 4294967296 + be32(b, o + 4)); }
function intPayload(p) {
  if (!p.length) return '';
  if (p.length === 2) return be16(p, 0);
  if (p.length >= 4) {
    if (p[0] === 0 && p[1] === 0) return be16(p, 2); // trkn/disc
    return be32(p, 0);
  }
  return p[0];
}
const MP4_KEYS = {
  '©nam': 'title', '©ART': 'artist', '©alb': 'album', 'aART': 'albumArtist',
  '©gen': 'genre', '©day': 'year', 'trkn': 'trackNo', 'disk': 'discNo', 'gnre': 'genre',
};

// ---------------- 统一入口 ----------------
function fromTags(meta) {
  return {
    title: meta.title || undefined,
    artist: meta.artist || undefined,
    album: meta.album || undefined,
    albumArtist: meta.albumArtist || undefined,
    trackNo: meta.trackNo ?? undefined,
    discNo: meta.discNo ?? undefined,
    year: meta.year ?? undefined,
    genre: meta.genre || undefined,
  };
}

export async function parseTrackMeta(file, ext, { wantPicture = false } = {}) {
  let head = await rd(file, 0, Math.min(file.size, HEAD));
  const magic = tdLatin.decode(head.subarray(0, 4));
  let result = { meta: {}, picture: null, duration: undefined, tagEnd: 0 };

  const rerunBig = async (fn) => {
    if (file.size > HEAD) {
      head = await rd(file, 0, Math.min(file.size, HEAD_BIG));
      return fn();
    }
    return null;
  };

  try {
    if (magic.startsWith('ID3')) {
      let r = parseID3v2(head, wantPicture);
      if (r) {
        result.meta = r.meta;
        result.picture = r.picture;
        result.tagEnd = r.tagEnd || 0;
        result.duration = mp3Duration(head, null, file.size, result.tagEnd);
        // 补 ID3v1
        if (file.size >= 128 && (!result.meta.title || !result.meta.artist)) {
          const tail = await rd(file, file.size - 128, file.size);
          const v1 = parseID3v1(tail);
          if (v1) {
            for (const k of ['title', 'artist', 'album', 'year', 'trackNo']) {
              if (result.meta[k] == null || result.meta[k] === '') result.meta[k] = v1[k];
            }
          }
        }
      }
    } else if (magic === 'fLaC') {
      let r = parseFLAC(head, wantPicture);
      if (r && (r.truncated || (!r.meta.title && !r.picture && file.size > HEAD))) {
        const r2 = await rerunBig(() => parseFLAC(head, wantPicture));
        if (r2) r = r2;
      }
      if (r) { result.meta = r.meta; result.picture = r.picture; result.duration = r.duration; }
    } else if (magic === 'OggS') {
      let tail = file.size > TAIL ? await rd(file, file.size - TAIL, file.size) : null;
      let r = parseOgg(head, tail, wantPicture);
      if (r && (r.meta._commentsTruncated || (!r.meta.title && file.size > HEAD))) {
        head = await rd(file, 0, Math.min(file.size, HEAD_BIG));
        r = parseOgg(head, tail, wantPicture);
      }
      if (r) { result.meta = r.meta; result.picture = r.picture; result.duration = r.duration; }
    } else if (magic === 'RIFF') {
      const r = parseWAV(head, wantPicture);
      if (r) { result.meta = r.meta; result.picture = r.picture; result.duration = r.duration; }
    } else if (tdLatin.decode(head.subarray(4, 8)) === 'ftyp') {
      const w = await mp4Walk(file, { ilst: new Set(Object.keys(MP4_KEYS).concat(['covr'])) });
      const meta = {};
      for (const [k, v] of Object.entries(w.tags)) {
        const field = MP4_KEYS[k];
        if (!field) continue;
        if (field === 'year') meta.year = parseYear(String(v));
        else if (field === 'trackNo') meta.trackNo = typeof v === 'number' ? v : parseTrackNum(String(v));
        else if (field === 'discNo') meta.discNo = typeof v === 'number' ? v : parseTrackNum(String(v));
        else if (field === 'genre') meta.genre = String(v).replace(/^\((\d+)\)$/, '') || undefined;
        else meta[field] = String(v);
      }
      if (w.mvhd && w.mvhd.timescale > 0 && w.mvhd.duration > 0) result.duration = w.mvhd.duration / w.mvhd.timescale;
      result.meta = meta;
      result.picture = w.pictures[0] || null;
    }
  } catch (e) {
    console.warn('metadata 解析失败', file.name, e);
  }

  const fields = fromTags(result.meta);
  if (wantPicture && result.picture && result.picture.data && result.picture.data.length > 32) {
    fields.picture = new Blob([result.picture.data], { type: result.picture.mime || 'image/jpeg' });
  } else if (wantPicture) {
    fields.picture = null;
  }
  fields.duration = isFinite(result.duration) && result.duration > 0 ? result.duration : undefined;
  return fields;
}

// 提取封面（供 art.js 使用）
export async function extractPicture(file, ext) {
  const m = await parseTrackMeta(file, ext, { wantPicture: true });
  return m.picture || null;
}
