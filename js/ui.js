// 图标、toast、菜单、对话框、通用工具
export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function fmtTime(sec) {
  if (!isFinite(sec) || sec < 0) return '--:--';
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

export function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

export function el(tag, cls, html) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html != null) n.innerHTML = html;
  return n;
}

// ---------- 图标（24x24, stroke=currentColor） ----------
const P = {
  play: '<polygon points="7 4 19 12 7 20" fill="currentColor" stroke="none"/>',
  pause: '<rect x="6" y="4.5" width="4" height="15" rx="1.3" fill="currentColor" stroke="none"/><rect x="14" y="4.5" width="4" height="15" rx="1.3" fill="currentColor" stroke="none"/>',
  next: '<path d="M5 5l9 7-9 7z" fill="currentColor" stroke="none"/><line x1="18.5" y1="5" x2="18.5" y2="19"/>',
  prev: '<path d="M19 5l-9 7 9 7z" fill="currentColor" stroke="none"/><line x1="5.5" y1="5" x2="5.5" y2="19"/>',
  shuffle: '<path d="M16 4h4v4"/><path d="M4 20L20 4"/><path d="M16 20h4v-4"/><path d="M4 4l5 5"/><path d="M15 15l5 5"/>',
  repeat: '<path d="M17 2l4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="M7 22l-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/>',
  heart: '<path d="M20.8 5.6a5.3 5.3 0 0 0-7.6 0L12 6.8l-1.2-1.2a5.3 5.3 0 0 0-7.6 7.6L12 22l8.8-8.8a5.3 5.3 0 0 0 0-7.6z"/>',
  search: '<circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.5" y2="16.5"/>',
  settings: '<line x1="4" y1="7" x2="20" y2="7"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="17" x2="20" y2="17"/><circle cx="9" cy="7" r="2.2" fill="var(--card, #fff)" stroke="currentColor"/><circle cx="15" cy="12" r="2.2" fill="var(--card, #fff)" stroke="currentColor"/><circle cx="7" cy="17" r="2.2" fill="var(--card, #fff)" stroke="currentColor"/>',
  more: '<circle cx="5" cy="12" r="1.7" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.7" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.7" fill="currentColor" stroke="none"/>',
  plus: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
  x: '<line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/>',
  check: '<polyline points="4.5 12.5 9.5 17.5 19.5 6.5"/>',
  back: '<polyline points="14.5 5 7.5 12 14.5 19"/>',
  chevronDown: '<polyline points="6 9.5 12 15.5 18 9.5"/>',
  volume: '<polygon points="11 5 6.5 9 3 9 3 15 6.5 15 11 19" fill="currentColor" stroke="none"/><path d="M14.5 9.2a4 4 0 0 1 0 5.6"/><path d="M17.3 6.6a8 8 0 0 1 0 10.8"/>',
  mute: '<polygon points="11 5 6.5 9 3 9 3 15 6.5 15 11 19" fill="currentColor" stroke="none"/><line x1="15" y1="9.5" x2="20" y2="14.5"/><line x1="20" y1="9.5" x2="15" y2="14.5"/>',
  music: '<circle cx="6.5" cy="17.8" r="3"/><circle cx="18" cy="15.8" r="3"/><path d="M9.5 17.8V5.6L21 3.6v12.2"/>',
  note: '<circle cx="7" cy="18" r="2.6"/><path d="M9.6 18V5.2l8.8-1.8V15"/><circle cx="15.8" cy="15" r="2.6"/>',
  list: '<line x1="9" y1="6.5" x2="20" y2="6.5"/><line x1="9" y1="12" x2="20" y2="12"/><line x1="9" y1="17.5" x2="20" y2="17.5"/><circle cx="5" cy="6.5" r="1.3" fill="currentColor" stroke="none"/><circle cx="5" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="5" cy="17.5" r="1.3" fill="currentColor" stroke="none"/>',
  disc: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2.6"/>',
  mic: '<circle cx="12" cy="8" r="4"/><path d="M4.5 20.5c1.6-3.4 4.3-5 7.5-5s5.9 1.6 7.5 5"/>',
  folder: '<path d="M3.5 6.5a2 2 0 0 1 2-2h4l2.3 2.6h6.7a2 2 0 0 1 2 2v8.4a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/>',
  trash: '<polyline points="4 7 20 7"/><path d="M6.5 7l1 12.2a1.8 1.8 0 0 0 1.8 1.6h5.4a1.8 1.8 0 0 0 1.8-1.6L17.5 7"/><path d="M9.5 7V5a1.5 1.5 0 0 1 1.5-1.5h2A1.5 1.5 0 0 1 14.5 5v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/>',
  edit: '<path d="M14.5 5.5l4 4L8 20H4v-4z"/><path d="M12.5 7.5l4 4"/>',
  clock: '<circle cx="12" cy="12" r="9"/><polyline points="12 6.5 12 12 15.5 14"/>',
  sort: '<path d="M8 5v14"/><polyline points="4.5 15.5 8 19 11.5 15.5"/><path d="M16 19V5"/><polyline points="12.5 8.5 16 5 19.5 8.5"/>',
  queueAdd: '<line x1="10" y1="6.5" x2="21" y2="6.5"/><line x1="10" y1="12" x2="21" y2="12"/><line x1="10" y1="17.5" x2="14" y2="17.5"/><circle cx="5" cy="6.5" r="1.3" fill="currentColor" stroke="none"/><circle cx="5" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="5" cy="17.5" r="1.3" fill="currentColor" stroke="none"/><line x1="18" y1="15.5" x2="18" y2="21.5"/><line x1="15" y1="18.5" x2="21" y2="18.5"/>',
  lyrics: '<line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="11" x2="16" y2="11"/><line x1="4" y1="16" x2="20" y2="16"/><line x1="4" y1="21" x2="13" y2="21"/>',
  playlist: '<circle cx="6" cy="18" r="2.6"/><path d="M8.6 18V5.5l11-2V16"/><circle cx="17" cy="16" r="2.6"/>',
  queue: '<line x1="4" y1="6" x2="14" y2="6"/><line x1="4" y1="11" x2="14" y2="11"/><line x1="4" y1="16" x2="14" y2="16"/><line x1="20" y1="4" x2="20" y2="20"/><path d="M14 20c0-2 2.5-2.5 6-2.5"/>',
  grab: '<circle cx="9" cy="6" r="1.2" fill="currentColor" stroke="none"/><circle cx="15" cy="6" r="1.2" fill="currentColor" stroke="none"/><circle cx="9" cy="12" r="1.2" fill="currentColor" stroke="none"/><circle cx="15" cy="12" r="1.2" fill="currentColor" stroke="none"/><circle cx="9" cy="18" r="1.2" fill="currentColor" stroke="none"/><circle cx="15" cy="18" r="1.2" fill="currentColor" stroke="none"/>',
  wifiOff: '<line x1="4" y1="4" x2="20" y2="20"/><path d="M8.5 11.5a6 6 0 0 1 5-1.4"/><path d="M5 8.5a11 11 0 0 1 4-2.3"/><path d="M15.5 6.6a11 11 0 0 1 3.5 1.9"/><path d="M12 15.5h.01"/><path d="M9.5 18.2a3.6 3.6 0 0 1 5 0"/>',
  refresh: '<path d="M20 11a8 8 0 1 0-2.3 6.3"/><polyline points="20 4 20 11 13 11"/>',
  download: '<path d="M12 3v11"/><polyline points="7 9.5 12 14.5 17 9.5"/><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/>',
  expand: '<polyline points="8 4 4 4 4 8"/><polyline points="16 4 20 4 20 8"/><polyline points="8 20 4 20 4 16"/><polyline points="16 20 20 20 20 16"/>',
  swap: '<path d="M7 4v13"/><polyline points="3.5 13.5 7 17 10.5 13.5"/><path d="M17 20V7"/><polyline points="13.5 10.5 17 7 20.5 10.5"/>',
  eq: '<line x1="5" y1="4" x2="5" y2="20"/><line x1="12" y1="4" x2="12" y2="20"/><line x1="19" y1="4" x2="19" y2="20"/><circle cx="5" cy="14" r="2.4" fill="var(--card,#fff)"/><circle cx="12" cy="8" r="2.4" fill="var(--card,#fff)"/><circle cx="19" cy="16" r="2.4" fill="var(--card,#fff)"/>',
  drop: '<path d="M12 3s6.5 7 6.5 11.5a6.5 6.5 0 0 1-13 0C5.5 10 12 3 12 3z"/>',
  sun: '<circle cx="12" cy="12" r="4.5"/><line x1="12" y1="2.5" x2="12" y2="5"/><line x1="12" y1="19" x2="12" y2="21.5"/><line x1="2.5" y1="12" x2="5" y2="12"/><line x1="19" y1="12" x2="21.5" y2="12"/><line x1="5.3" y1="5.3" x2="7" y2="7"/><line x1="17" y1="17" x2="18.7" y2="18.7"/><line x1="5.3" y1="18.7" x2="7" y2="17"/><line x1="17" y1="7" x2="18.7" y2="5.3"/>',
  moon: '<path d="M20 13.5A8.5 8.5 0 0 1 10.5 4 8.5 8.5 0 1 0 20 13.5z"/>',
  info: '<circle cx="12" cy="12" r="9"/><line x1="12" y1="11" x2="12" y2="16.5"/><circle cx="12" cy="7.8" r="1.1" fill="currentColor" stroke="none"/>',
  playNext: '<path d="M4 5l8 5-8 5z" fill="currentColor" stroke="none"/><line x1="16" y1="5" x2="16" y2="15"/><line x1="4" y1="19.5" x2="20" y2="19.5"/>',
  // 番剧库用：外链（跳官方）与片库（番剧入口）
  external: '<path d="M14 4h6v6"/><line x1="20" y1="4" x2="11" y2="13"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  screen: '<rect x="2.5" y="4" width="19" height="13" rx="2"/><line x1="8" y1="20.5" x2="16" y2="20.5"/><line x1="12" y1="17" x2="12" y2="20.5"/>',
};

export function icon(name, cls) {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ${cls ? `class="${cls}"` : ''} aria-hidden="true">${P[name] || ''}</svg>`;
}

// 占位封面：基于字符串的稳定渐变
const GRADS = [
  ['#667eea', '#764ba2'], ['#f093fb', '#f5576c'], ['#4facfe', '#00f2fe'],
  ['#43e97b', '#38f9d7'], ['#fa709a', '#fee140'], ['#a18cd1', '#fbc2eb'],
  ['#30cfd0', '#330867'], ['#5b5bd6', '#8b5cf6'], ['#f77062', '#fe5196'],
];
export function gradFor(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  const [a, b] = GRADS[h % GRADS.length];
  return `linear-gradient(135deg, ${a}, ${b})`;
}
export function placeholder(rel, albumKey, iconName = 'note') {
  const g = gradFor(albumKey || rel || '?');
  return `<div class="thumb ph" style="background:${g}">${icon(iconName)}</div>`;
}

// ---------- Toast ----------
export function toast(msg, ms = 2400) {
  let host = document.getElementById('toasts');
  if (!host) { host = el('div'); host.id = 'toasts'; document.body.appendChild(host); }
  const t = el('div', 'toast', esc(msg));
  host.appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .3s'; setTimeout(() => t.remove(), 320); }, ms);
}

// ---------- 菜单 ----------
let _menu = null;
export function closeMenu() { if (_menu) { _menu.remove(); _menu = null; } }
export function showMenu(items, x, y) {
  closeMenu();
  const m = el('div', 'menu');
  const add = (list) => {
    for (const it of list) {
      if (it === '-') { m.appendChild(el('div', 'sep-h')); continue; }
      if (it.label && it.children) {
        const b = el('button', '', `${icon(it.icon || 'chevronDown')}<span style="flex:1">${esc(it.label)}</span>${icon('back')}`);
        b.querySelector('svg:last-of-type').style.transform = 'rotate(180deg)';
        b.addEventListener('click', (e) => {
          e.stopPropagation();
          const r = b.getBoundingClientRect();
          showMenu(it.children, r.left, Math.min(r.top, innerHeight - 80));
        });
        m.appendChild(b);
        continue;
      }
      const b = el('button', it.danger ? 'danger' : '', `${icon(it.icon || 'check')}<span style="flex:1">${esc(it.label)}</span>${it.checked ? icon('check') : ''}`);
      b.addEventListener('click', () => { closeMenu(); it.onClick && it.onClick(); });
      m.appendChild(b);
    }
  };
  add(items);
  document.body.appendChild(m);
  const r = m.getBoundingClientRect();
  m.style.left = `${Math.max(8, Math.min(x, innerWidth - r.width - 8))}px`;
  m.style.top = `${Math.max(8, Math.min(y, innerHeight - r.height - 8))}px`;
  _menu = m;
}
addEventListener('click', (e) => { if (_menu && !_menu.contains(e.target)) closeMenu(); }, true);
addEventListener('blur', closeMenu);
addEventListener('resize', closeMenu);

// ---------- 对话框 ----------
function baseDialog() {
  const d = document.createElement('dialog');
  document.body.appendChild(d);
  return d;
}
export function confirmDialog(title, msg, okText = '确定', danger = false) {
  return new Promise(resolve => {
    const d = baseDialog();
    d.innerHTML = `<div class="dlg-body"><b>${esc(title)}</b><p>${esc(msg)}</p></div>
      <div class="dlg-actions">
        <button class="btn text" data-a="cancel">取消</button>
        <button class="btn ${danger ? 'ghost-danger' : ''}" data-a="ok">${esc(okText)}</button>
      </div>`;
    const done = (v) => { d.close(); d.remove(); resolve(v); };
    d.querySelector('[data-a=ok]').addEventListener('click', () => done(true));
    d.querySelector('[data-a=cancel]').addEventListener('click', () => done(false));
    d.addEventListener('cancel', () => done(false));
    d.addEventListener('click', (e) => { if (e.target === d) done(false); });
    d.showModal();
    d.querySelector('[data-a=ok]').focus();
  });
}
export function promptDialog(title, placeholderText = '', def = '') {
  return new Promise(resolve => {
    const d = baseDialog();
    d.innerHTML = `<div class="dlg-body"><b>${esc(title)}</b>
      <input placeholder="${esc(placeholderText)}" value="${esc(def)}"></div>
      <div class="dlg-actions">
        <button class="btn text" data-a="cancel">取消</button>
        <button class="btn" data-a="ok">确定</button>
      </div>`;
    const input = d.querySelector('input');
    const done = (v) => { d.close(); d.remove(); resolve(v); };
    d.querySelector('[data-a=ok]').addEventListener('click', () => done(input.value.trim() || null));
    d.querySelector('[data-a=cancel]').addEventListener('click', () => done(null));
    d.addEventListener('cancel', () => resolve(null));
    d.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); done(input.value.trim() || null); } });
    d.addEventListener('click', (e) => { if (e.target === d) resolve(null); });
    d.showModal();
    setTimeout(() => { input.focus(); input.select(); }, 50);
  });
}

// ---------- 设置 range 进度填充 ----------
export function paintRange(input) {
  const min = Number(input.min) || 0, max = Number(input.max) || 100;
  const p = ((Number(input.value) - min) / (max - min)) * 100;
  input.style.setProperty('--p', `${p}%`);
}

// 稳定对比字符串（中文排序）
export const collator = new Intl.Collator('zh-Hans-CN', { numeric: true, sensitivity: 'base' });
