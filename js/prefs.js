// 用户偏好（localStorage），含默认值与迁移
const KEY = 'music-pwa-prefs';

export const DEFAULTS = {
  theme: 'light',            // light | dark | glass
  sortKey: 'title',          // title | artist | album | addedAt | playCount | lastPlayed | duration
  sortDir: 'asc',
  lyricsOn: true,
  visualizerOn: true,
  eqOn: false,
  eqGains: [0, 0, 0, 0, 0],  // dB, 频段 [60, 230, 910, 3600, 14000]
  volume: 0.9,
  muted: false,
  restoreOn: true,
  scanAtBoot: true,
  shuffleOn: false,
};

let _prefs = { ...DEFAULTS };

export function loadPrefs() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) _prefs = { ...DEFAULTS, ...JSON.parse(raw) };
  } catch { /* 损坏则重置 */ }
  if (!Array.isArray(_prefs.eqGains) || _prefs.eqGains.length !== 5) _prefs.eqGains = [...DEFAULTS.eqGains];
  return _prefs;
}

export function prefs() { return _prefs; }

export function setPref(key, val) {
  _prefs[key] = val;
  try { localStorage.setItem(KEY, JSON.stringify(_prefs)); } catch { /* 存储满时忽略 */ }
  return _prefs;
}

export function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  const colors = { light: '#f4f5f8', dark: '#0e1014', glass: '#cfd9ec' };
  let meta = document.querySelector('meta[name="theme-color"]');
  if (!meta) {
    meta = document.createElement('meta');
    meta.name = 'theme-color';
    document.head.appendChild(meta);
  }
  meta.content = colors[theme] || colors.light;
}
