// WebAudio：5 段均衡器 + 频谱分析（惰性接入，避免 autoplay 限制问题）
import { prefs, setPref } from './prefs.js';

export const BANDS = [60, 230, 910, 3600, 14000];

let ctx = null;
let source = null;
let filters = [];
let analyser = null;
let hooked = false;

export function ensureGraph(audio) {
  if (hooked) { if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => { }); return; }
  try {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    source = ctx.createMediaElementSource(audio);
    filters = BANDS.map((f, i) => {
      const q = ctx.createBiquadFilter();
      q.type = i === 0 ? 'lowshelf' : i === BANDS.length - 1 ? 'highshelf' : 'peaking';
      q.frequency.value = f;
      q.Q.value = 1.0;
      q.gain.value = 0;
      return q;
    });
    analyser = ctx.createAnalyser();
    analyser.fftSize = 128;
    analyser.smoothingTimeConstant = 0.82;
    let node = source;
    for (const f of filters) { node.connect(f); node = f; }
    node.connect(analyser);
    analyser.connect(ctx.destination);
    applyGains(prefs().eqGains, prefs().eqOn);
    hooked = true;
  } catch (e) {
    console.warn('WebAudio 初始化失败，将直接播放', e);
  }
}

export function applyGains(gains, enabled) {
  filters.forEach((f, i) => {
    f.gain.value = enabled ? (gains[i] || 0) : 0;
  });
}

export function setEqOn(on) {
  setPref('eqOn', on);
  if (hooked) applyGains(prefs().eqGains, on);
}
export function setGain(i, db) {
  const g = [...prefs().eqGains];
  g[i] = db;
  setPref('eqGains', g);
  if (hooked) applyGains(g, prefs().eqOn);
}

export function getAnalyser() { return hooked ? analyser : null; }
export function resumeCtx() { if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => { }); }

// ---------- 频谱绘制 ----------
export function drawSpectrum(canvas, accent) {
  const an = getAnalyser();
  if (!an) return false;
  const dpr = Math.min(2, devicePixelRatio || 1);
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
    canvas.width = Math.max(1, w * dpr);
    canvas.height = Math.max(1, h * dpr);
  }
  const g = canvas.getContext('2d');
  g.clearRect(0, 0, canvas.width, canvas.height);
  const n = 28;
  const data = new Uint8Array(an.frequencyBinCount);
  an.getByteFrequencyData(data);
  const bw = canvas.width / n;
  for (let i = 0; i < n; i++) {
    // 对数取样，低频占比过高时更均衡
    const idx = Math.floor(Math.pow(i / n, 1.6) * data.length * 0.9);
    const v = data[idx] / 255;
    const bh = Math.max(2 * dpr, v * canvas.height * 0.92);
    g.fillStyle = accent;
    g.globalAlpha = 0.35 + v * 0.65;
    const x = i * bw + bw * 0.18;
    const bwi = bw * 0.64;
    const r = Math.min(bwi / 2, 2 * dpr);
    g.beginPath();
    g.roundRect(x, canvas.height - bh, bwi, bh, [r, r, 0, 0]);
    g.fill();
  }
  g.globalAlpha = 1;
  return true;
}
