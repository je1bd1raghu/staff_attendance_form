const WORKER_URL  = 'https://attendance-proxy.je1-bd1-raghu.workers.dev/';
// All Supabase credentials live in Cloudflare Worker secrets.
// The client never holds a Supabase key or URL directly.

let employees      = [];
let locations      = [];
let establishments = [];
let selectedEstId  = null;   // currently chosen establishment (null = none / not required)
let todayRecs   = [];
let recSearch        = '';      // Today's Attendance filter: text query
let recStatusFilter  = 'all';   // Today's Attendance filter: all | inside | left
let currentPos  = null;
let locVerified = false;
let locName     = '';
let watchId     = null;
let deviceId    = null;
let deviceToken = null;  // durable device pass — survives fingerprint drift
let verifiedPin = null;  // PIN confirmed by server; held in memory for the session

// ── ADMIN STATE ───────────────────────────────────────────────────────────────
let isAdmin          = false;
let adminLocId       = null;    // selected location id in admin mode
let scannedEmpId     = null;    // EMP id from last scan
let scannedPrintedAt = null;    // ISO printedAt from QR payload (null for legacy QRs)
let adminWatchId     = null;    // geolocation watchId for admin GPS
let adminCurrentPos  = null;    // admin's live GPS position
let adminLocVerified = false;   // true when admin is within tolerance of selected location
let scannerStream    = null;
let scannerAnimFrame = null;
let scannerPaused    = false;

// ── DATE FORMATTING CONSTANTS ─────────────────────────────────────────────────
const DAY_FULL   = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
const DAY_ABBR   = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const MONTH_ABBR = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

// ── BENGALI UI ────────────────────────────────────────────────────────────────
// The whole frontend speaks Bengali. Displayed dates/times/counts use Bengali
// numerals via bd(); abbreviations are Bengali too. Latin scripts are kept for
// opaque identifiers (device ids, employee ids, QR payloads) and data files.
const BN_DIGITS   = ['০','১','২','৩','৪','৫','৬','৭','৮','৯'];
const DAY_FULL_BN   = ['রবিবার','সোমবার','মঙ্গলবার','বুধবার','বৃহস্পতিবার','শুক্রবার','শনিবার'];
const DAY_ABBR_BN   = ['রবি','সোম','মঙ্গল','বুধ','বৃহ','শুক্র','শনি'];
const MONTH_ABBR_BN = ['জানু','ফেব্রু','মার্চ','এপ্রিল','মে','জুন','জুলাই','আগস্ট','সেপ্টে','অক্টো','নভে','ডিসে'];
const MONTH_FULL_BN = ['জানুয়ারি','ফেব্রুয়ারি','মার্চ','এপ্রিল','মে','জুন','জুলাই','আগস্ট','সেপ্টেম্বর','অক্টোবর','নভেম্বর','ডিসেম্বর'];

// Convert ASCII digits 0-9 in a string to Bengali numerals (input stays as-is).
function bd(s) { return String(s).replace(/[0-9]/g, d => BN_DIGITS[d]); }

// Shorten an opaque device id for display: "a1b2c3…x9y8" (full Latin id kept in tooltips).
function shortId(id) {
  if (!id) return '—';
  return id.length > 12 ? id.slice(0, 8) + '…' + id.slice(-4) : id;
}

// ── BOOT ──────────────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  updateClock();
  setInterval(updateClock, 1000);
  initApp();
});

async function getDeviceId() {
  try {
    const fp     = await FingerprintJS.load();
    const result = await fp.get();
    deviceId = result.visitorId;
  } catch(e) { deviceId = null; }
}

// deviceId may be null when FingerprintJS fails (blocked storage/WebGL, etc.).
// Fall back to the durable token so check-in isn't blocked; the worker treats
// it as an opaque device identity and still validates it (non-empty, non-ADMIN).
function effDeviceId() { return deviceId || deviceToken || ''; }

// ── DURABLE DEVICE PASS ──────────────────────────────────────────────────────
// A random UUID that identifies "this browser" for check-out. Unlike the
// fingerprint, it survives browser updates, so a fingerprint shift can never
// lock a worker out. Persisted in localStorage, an IndexedDB mirror, AND a
// cookie, so eviction of any single store (or a partial "clear recent
// history") doesn't reset them all. On boot the first token we can find is
// re-written into every store, healing whichever one was lost.
const DEVICE_TOKEN_KEY    = 'att_deviceToken';
const DEVICE_TOKEN_COOKIE = 'att_dt';
const DEVICE_TOKEN_TTL    = 400;   // days

function cookieGet(name) {
  const m = document.cookie.match('(?:^|;)\\s*' + name + '=([^;]+)');
  return m ? decodeURIComponent(m[1]) : null;
}
function cookieSet(name, val) {
  const d = new Date();
  d.setDate(d.getDate() + DEVICE_TOKEN_TTL);
  document.cookie = name + '=' + encodeURIComponent(val) +
    '; path=/; SameSite=Lax; expires=' + d.toUTCString();
}

// Write the token into every store it can reach (edge-order: cookie first so a
// storage-throwing browser still keeps the token in a cookie).
async function persistDeviceToken(t) {
  if (!t) return;
  cookieSet(DEVICE_TOKEN_COOKIE, t);
  try { localStorage.setItem(DEVICE_TOKEN_KEY, t); } catch {}
  try { await idbSet('deviceToken', t); } catch {}
}

function idbOpen() {
  return new Promise((resolve, reject) => {
    try {
      const rq = indexedDB.open('att_device', 1);
      rq.onsuccess  = () => resolve(rq.result);
      rq.onerror    = () => reject(rq.error);
      rq.onupgradeneeded = () => {
        if (!rq.result.objectStoreNames.contains('kv')) rq.result.createObjectStore('kv');
      };
    } catch(e) { reject(e); }
  });
}
function idbGet(key) {
  return idbOpen().then(db => new Promise((resolve, reject) => {
    try {
      const rq = db.transaction('kv', 'readonly').objectStore('kv').get(key);
      rq.onsuccess = () => resolve(rq.result);
      rq.onerror   = () => reject(rq.error);
    } catch(e) { reject(e); }
  }));
}
function idbSet(key, val) {
  return idbOpen().then(db => new Promise((resolve, reject) => {
    try {
      const tx = db.transaction('kv', 'readwrite');
      tx.objectStore('kv').put(val, key);
      tx.oncomplete = () => resolve();
      tx.onerror    = () => reject(tx.error);
    } catch(e) { reject(e); }
  }));
}
function genToken() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const r = (n) => Math.floor(Math.random() * n).toString(16).padStart(8, '0');
  return r(0x100000000) + '-' + r(0x10000) + '-' + '4' + Math.floor(Math.random()*0x1000).toString(16).padStart(3,'0')
       + '-' + (0x8000 | Math.floor(Math.random()*0x3fff)).toString(16) + '-' + r(0x100000000) + r(0x10000);
}
async function getDeviceToken() {
  if (deviceToken) return deviceToken;
  let t = null;
  try { t = localStorage.getItem(DEVICE_TOKEN_KEY); } catch {}
  if (!t) { try { t = await idbGet('deviceToken'); } catch {} }
  if (!t) t = cookieGet(DEVICE_TOKEN_COOKIE);
  t = t || genToken();
  await persistDeviceToken(t);   // heal any store that is missing the token
  deviceToken = t;
  return t;
}

// If another tab replaces the token, adopt + mirror it so both tabs stay in sync.
window.addEventListener('storage', (e) => {
  if (e.key === DEVICE_TOKEN_KEY && e.newValue && e.newValue !== deviceToken) {
    deviceToken = e.newValue;
    cookieSet(DEVICE_TOKEN_COOKIE, e.newValue);
    try { idbSet('deviceToken', e.newValue); } catch {}
  }
});

// ── CHROME GATE ──────────────────────────────────────────────────────────────
// Staff check-in/out is verified in-browser, so we ask for Google Chrome on
// desktop + Android. iOS is always allowed — every iOS browser shares the
// WebKit engine, so there is no real "Chrome" to enforce there.
function browserCheck() {
  const ua = navigator.userAgent || '';
  if (/iPad|iPhone|iPod/.test(ua)) return 'ok';
  const brands = (navigator.userAgentData && navigator.userAgentData.brands)
    ? navigator.userAgentData.brands.map(b => b.brand)
    : [];
  if (brands.length) {
    const s = brands.join(' ');
    if (/Microsoft Edge|Opera|Samsung Internet|Vivaldi|Brave|Edg|OPR/i.test(s)) return 'block';
    if (/Google Chrome/.test(s)) return 'ok';
    return 'block';
  }
  if (/Chrome\/|Chromium\//.test(ua) && !/Edg\/|OPR\/|SamsungBrowser|Vivaldi|CriOS/.test(ua)) return 'ok';
  return 'block';
}

function showBrowserGate() {
  const gate = document.getElementById('browserGate');
  if (!gate) return;
  document.getElementById('loadingScreen').classList.add('hide');
  gate.style.display = 'flex';
  document.title = 'Chrome-এ এই পেজ খুলুন';
  const url = location.href;
  const isAndroid = /Android/i.test(navigator.userAgent || '');
  const link = document.getElementById('openChromeBtn');
  if (isAndroid) {
    // One-tap: hand the current page over to Chrome on Android.
    const hostPath  = url.replace(/^https?:\/\//i, '');
    const scheme    = /^http:/.test(url) ? 'http' : 'https';
    const fb        = encodeURIComponent(url);
    link.href = 'intent://' + hostPath + '#Intent;scheme=' + scheme +
                ';package=com.android.chrome;S.browser_fallback_url=' + fb + ';end';
  } else {
    link.textContent = 'গুগল ক্রোম ডাউনলোড করুন';
    link.href = 'https://www.google.com/chrome/';
    const note = document.getElementById('gateDesktopNote');
    if (note) note.style.display = '';
    const phoneNote = document.getElementById('gatePhoneNote');
    if (phoneNote) phoneNote.style.display = 'none';
  }
  const copyBtn = document.getElementById('copyLinkBtn');
  if (copyBtn) copyBtn.addEventListener('click', () => {
    (navigator.clipboard ? navigator.clipboard.writeText(url)
      : Promise.reject(new Error('no clipboard')))
      .then(() => showToast('লিংক কপি হয়েছে — Chrome-এ পেস্ট করুন', 'success'))
      .catch(() => showToast('অ্যাড্রেস বারে লম্বা প্রেস করে লিংক কপি করুন', 'warning'));
  });
  gate.tabIndex = -1;
  gate.focus();
}

async function initApp() {
  setProgress(10);
  setLoadText('ব্রাউজার চেক হচ্ছে…');
  if (browserCheck() === 'block') { showBrowserGate(); return; }
  setProgress(25);
  setLoadText('কর্মচারীদের তথ্য লোড হচ্ছে…');
  await Promise.all([getDeviceId(), getDeviceToken()]);
  setProgress(40);
  const ok = await fetchConfig();
  if (!ok) { hideLoading(); return; }

  setLoadText("আজকের এটেন্ডেন্সের তথ্য লোড হচ্ছে…");
  setProgress(75);
  await fetchTodayRecords();

  setProgress(100);
  setLoadText('প্রস্তুত!');
  setTimeout(hideLoading, 500);
}

function setProgress(p) { document.getElementById('loadingBar').style.width = p + '%'; }
function setLoadText(t) { document.getElementById('loadingText').textContent = t; }
function hideLoading() {
  const el = document.getElementById('loadingScreen');
  el.classList.add('hide');
  setTimeout(() => el.style.display = 'none', 450);
}

// ── CLOCK ─────────────────────────────────────────────────────────────────────
function updateClock() {
  const now = new Date();
  document.getElementById('headerClock').textContent =
    bd(pad(now.getHours())) + ':' + bd(pad(now.getMinutes())) + ':' + bd(pad(now.getSeconds()));
  document.getElementById('headerDateText').textContent = DAY_FULL_BN[now.getDay()] + ', ' + bd(now.getDate()) + ' ' + MONTH_ABBR_BN[now.getMonth()] + ', ' + bd(now.getFullYear());
}
function pad(n) { return n < 10 ? '0' + n : '' + n; }

// ── SUPABASE / REST ───────────────────────────────────────────────────────────
// Attendance is stored as rows in Supabase, not a flat CSV file.
// All business-rule validation (proxy checks, date, cap) is enforced
// server-side in the Cloudflare Worker — client checks are UX fast-fails only.

// CSV helpers kept only for the download feature
const CSV_COLS = ['employeeId','name','designation','date','checkIn','checkInTimestamp',
                  'checkOut','checkOutTimestamp','location','lat','lng','deviceId'];
function csvEscape(v) {
  const s = v == null ? '' : String(v);
  return (s.includes(',') || s.includes('"') || s.includes('\n'))
    ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function csvStringify(records) {
  return [CSV_COLS.join(','),
    ...records.map(r => CSV_COLS.map(c => csvEscape(r[c])).join(','))
  ].join('\n');
}

// Fetch all attendance rows (returns JSON array with `id` UUID per row)
async function attGet() {
  const r = await fetch(WORKER_URL + 'attendance?t=' + Date.now());
  if (!r.ok) return [];
  return r.json();
}

// Shared POST/PATCH helper — parses error JSON for a friendly message
async function _sendJson(url, method, body) {
  const r = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    let msg = 'HTTP ' + r.status;
    try { const d = await r.json(); if (d.error) msg = d.error; } catch {}
    throw new Error(msg);
  }
  return r.json();
}

// Insert one new check-in record; worker re-sets date/deviceId server-side
function attInsert(rec) {
  return _sendJson(WORKER_URL + 'attendance', 'POST', rec);
}

// Update a record by its Supabase UUID (check-out).
// Employee checkout sends deviceToken + deviceId for ownership verification;
// admin checkout routes to /attendance/admin/:id with the PIN.
function attUpdate(id, patch) {
  return isAdmin && verifiedPin
    ? _sendJson(WORKER_URL + 'attendance/admin/' + id, 'PATCH', { ...patch, adminPin: verifiedPin })
    : _sendJson(WORKER_URL + 'attendance/' + id, 'PATCH', { ...patch, deviceToken, deviceId });
}

// Admin check-in via QR scan — worker validates PIN, QR age, and all business rules
function attAdminInsert(rec) {
  return _sendJson(WORKER_URL + 'attendance/admin', 'POST', { ...rec, adminPin: verifiedPin });
}

async function workerGet(path) {
  const r = await fetch(WORKER_URL + path + '?t=' + Date.now());
  if (!r.ok) throw new Error('HTTP ' + r.status + ' fetching ' + path);
  return r.json();
}

async function fetchConfig() {
  try {
    const data = await workerGet('config');
    employees      = data.employees      || [];
    locations      = data.locations      || [];
    establishments = data.establishments || [];
    serverShiftDate = data._shiftDate || null;
    populateEmployees();
    populateEstablishments();
    populateAdminLocs();
    await buildUuidLookup();   // pre-compute UUID→employeeId map for scanner
    return true;
  } catch(e) { showToast('কনফিগারেশন লোড করা যায়নি — ইন্টারনেট চেক করে পেজ রিফ্রেশ করুন', 'error'); return false; }
}

async function fetchTodayRecords() {
  try {
    const records = await attGet();
    todayRecs     = records.filter(r => r.date === shiftDateStr());
    renderRecords();
    renderAdminRecords();
    renderDeviceLine();
  } catch { todayRecs = []; renderRecords(); renderAdminRecords(); renderDeviceLine(); }
}

// ── EMPLOYEES ─────────────────────────────────────────────────────────────────
function populateEmployees() {
  employees.sort((a, b) => a.name.localeCompare(b.name));
  const sel = document.getElementById('empSelect');
  sel.innerHTML = '<option value=""></option>';
  employees.forEach(e => {
    const o = document.createElement('option');
    o.value = e.id; o.textContent = e.name;
    sel.appendChild(o);
  });
  renderDropdown('');
}

// ── ESTABLISHMENTS ──────────────────────────────────────────────────────────────
function populateEstablishments() {
  const scroller  = document.getElementById('estScroller');
  const estLabel  = document.getElementById('estLabel');
  const nameBlock = document.getElementById('nameBlock');
  if (!scroller) return;

  // No establishments configured → keep the original single-step flow.
  if (!establishments.length) {
    scroller.style.display = 'none';
    if (estLabel) estLabel.style.display = 'none';
    selectedEstId = null;
    unlockNameBlock();
    return;
  }

  scroller.innerHTML = establishments.map((est, i) => {
    const count = employees.filter(e => e.establishmentId === est.id).length;
    // background image set inline; falls back to the CSS gradient when absent.
    const bg = est.image ? ';background-image:url(' + cssUrl(est.image) + ')' : '';
    return '<button class="est-card" type="button" data-eid="' + esc(est.id) + '" style="--i:' + i + bg + '"' +
           ' onclick="selectEstablishment(\'' + esc(est.id) + '\')">' +
             '<span class="est-name">' + esc(est.name) + '</span>' +
             '<span class="est-count">' + bd(count) + ' জন</span>' +
             '<span class="est-check">✓</span>' +
           '</button>';
  }).join('');
}

function selectEstablishment(id) {
  if (selectedEstId === id) return;        // already selected — no-op
  selectedEstId = id;
  document.querySelectorAll('.est-card').forEach(c =>
    c.classList.toggle('active', c.dataset.eid === id));
  clearEmployee();                         // reset any prior name choice
  unlockNameBlock();
  renderDropdown('');
  // Activate the name field for the chosen establishment after the reveal settles.
  const input = document.getElementById('empSearch');
  setTimeout(() => { if (input && selectedEstId === id) input.focus(); }, 280);
}

function unlockNameBlock() {
  const nameBlock = document.getElementById('nameBlock');
  const input     = document.getElementById('empSearch');
  if (nameBlock) nameBlock.classList.remove('locked');
  if (input) input.disabled = false;
}

function esc(s) { return String(s).replace(/[<>&"]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c])); }
// Wrap a URL for safe use inside an inline-style url(...): drop quotes, parens
// and brackets so it can't break out of the attribute or the url() token.
function cssUrl(s) { return "'" + String(s).replace(/["'()<>\\]/g, '') + "'"; }
function hi(s, q) {
  if (!q) return esc(s);
  try {
    var safe = q.replace(/[-\[\]{}()*+?.,\\^$|#]/g, '\\$&');
    return esc(s).replace(new RegExp(safe, 'gi'), function(m){ return '<mark>'+m+'</mark>'; });
  } catch(ex) { return esc(s); }
}

// Employees shown in the name picker — scoped to the chosen establishment
// when establishments are configured, otherwise the full roster.
function visibleEmployees() {
  if (!establishments.length || !selectedEstId) return employees;
  return employees.filter(e => e.establishmentId === selectedEstId);
}

function renderDropdown(query) {
  const dd = document.getElementById('comboDropdown');
  const q  = query.trim().toLowerCase();
  const base = visibleEmployees();
  const list = q
    ? base.filter(e => e.name.toLowerCase().includes(q) || (e.designation||'').toLowerCase().includes(q))
    : base;
  if (!list.length) { dd.innerHTML = '<div class="combo-empty">কোনো কর্মচারী পাওয়া যায়নি</div>'; return; }
  dd.innerHTML = list.map(e => {
    const desig = e.designation ? '<div class="combo-desig">'+hi(e.designation, q)+'</div>' : '';
    return '<div class="combo-item" data-id="'+esc(e.id)+'">'+hi(e.name, q)+desig+'</div>';
  }).join('');
}

function filterEmployees() {
  const q = document.getElementById('empSearch').value;
  document.getElementById('comboClear').style.display = q ? '' : 'none';
  openDropdown(); renderDropdown(q);
}

function openDropdown() {
  document.getElementById('comboDropdown').style.display = 'block';
  document.getElementById('comboWrapper').classList.add('open');
}
function closeDropdown() {
  document.getElementById('comboDropdown').style.display = 'none';
  document.getElementById('comboWrapper').classList.remove('open');
}
function selectEmployee(id) {
  const emp = employees.find(e => e.id === id);
  if (!emp) return;
  document.getElementById('empSearch').value = emp.name + (emp.designation ? ' — ' + emp.designation : '');
  document.getElementById('comboClear').style.display = '';
  document.getElementById('empSelect').value = id;
  closeDropdown(); onEmployeeChange();
}
function clearEmployee() {
  document.getElementById('empSearch').value = '';
  document.getElementById('comboClear').style.display = 'none';
  document.getElementById('empSelect').value = '';
  renderDropdown(''); resetLoc(); disableBtns();
  renderDeviceLine();
  clearEmployeeWatch();
}
function clearEmployeeWatch() {
  if (watchId !== null) {
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
    currentPos = null;
  }
}
document.addEventListener('DOMContentLoaded', function() {
  document.getElementById('comboDropdown').addEventListener('mousedown', function(e) {
    const item = e.target.closest('.combo-item');
    if (item) { e.preventDefault(); selectEmployee(item.dataset.id); }
  });
  document.addEventListener('click', function(e) {
    const w = document.getElementById('comboWrapper');
    if (w && !w.contains(e.target)) closeDropdown();
  });
});
function onEmployeeChange() {
  resetLoc(); disableBtns();
  const id = document.getElementById('empSelect').value;
  if (!id) return;
  renderDeviceLine();
  ensureWatch();
  if (currentPos) checkProximity();
}

// ── LOCATION ──────────────────────────────────────────────────────────────────
function ensureWatch() {
  if (watchId !== null) return;
  if (!navigator.geolocation) { setLoc('failed', '❌', 'GPS সমর্থিত নয়', 'Chrome বা Safari ব্যবহার করুন'); return; }
  setLoc('checking', '📡', 'আপনার অবস্থান পাওয়া যাচ্ছে…', 'অনুগ্রহ করে অপেক্ষা করুন');
  watchId = navigator.geolocation.watchPosition(onPos, onPosErr, { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 });
}
function onPos(pos) {
  currentPos = { lat: pos.coords.latitude, lng: pos.coords.longitude, acc: Math.round(pos.coords.accuracy) };
  checkProximity();
}
function onPosErr(e) {
  const msgs = { 1: 'লোকেশন অনুমতি দেওয়া হয়নি — GPS অনুমতি দিন', 2: 'লোকেশন পাওয়া যাচ্ছে না', 3: 'লোকেশন টাইম আউট হয়েছে' };
  setLoc('failed', '❌', msgs[e.code] || 'লোকেশন ত্রুটি', 'GPS চালু করে আবার চেষ্টা করুন');
  disableBtns();
}
function checkProximity() {
  if (!currentPos) { disableBtns(); return; }   // GPS not yet acquired
  const emp = getEmp();
  if (!emp) return;
  const allowed = emp.locationIds && emp.locationIds.length
    ? locations.filter(l => emp.locationIds.includes(l.id))
    : locations;
  if (!allowed.length) {
    setLoc('failed', '⚠️', 'ডিউটি স্থান নির্ধারিত নেই', 'ডিউটি এলাকা নির্ধারণ করতে অ্যাডমিনের সাথে যোগাযোগ করুন');
    disableBtns(); return;
  }
  let best = null, bestDist = Infinity;
  allowed.forEach(loc => {
    const d = haversine(currentPos.lat, currentPos.lng, loc.lat, loc.lng);
    if (d < bestDist) { bestDist = d; best = loc; }
  });
  const tol  = best.tolerance || 15;
  const dist = Math.round(bestDist);
  if (bestDist <= tol) {
    locVerified = true; locName = best.name;
    setLoc('verified', '✅', best.name, 'আপনি ' + bd(dist) + ' মিটার দূরে — লোকেশন যাচাই হয়েছে ✓');
    updateBtns();
  } else {
    locVerified = false;
    const names = allowed.map(l => l.name).join(', ');
    setLoc('failed', '🚫', 'আপনার ডিউটি এলাকার বাইরে', 'সবচেয়ে কাছে: ' + best.name + ' (' + bd(dist) + ' মিটার দূরে, প্রযোজ্য সীমা ' + bd(tol) + ' মিটার)। অনুমোদিত: ' + names);
    disableBtns();
  }
}
function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371000, toR = Math.PI / 180;
  const dLat = (lat2 - lat1) * toR, dLng = (lng2 - lng1) * toR;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*toR) * Math.cos(lat2*toR) * Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}
function resetLoc() {
  locVerified = false; locName = '';
  setLoc('idle', '📍', 'লোকেশন যাচাই করা হয়নি', 'শুরু করতে আপনার নাম নির্বাচন করুন');
}

// ── BUTTONS ───────────────────────────────────────────────────────────────────
const MAX_CHECKINS_PER_DAY = 2;

function updateBtns() {
  const id  = document.getElementById('empSelect').value;
  const btnIn  = document.getElementById('btnIn');
  const btnOut = document.getElementById('btnOut');
  if (!locVerified || !id) { disableBtns(); return; }
  // Cross-device check: block check-in when another employee is checked in from this device
  const sameIdentity = r => (r.deviceId && r.deviceId === deviceId) || (r.deviceToken && r.deviceToken === deviceToken);
  if (deviceId || deviceToken) {
    const otherOnDevice = todayRecs.find(r => sameIdentity(r) && r.checkIn && !r.checkOut && r.employeeId !== id);
    if (otherOnDevice) {
      btnIn.disabled  = true;
      btnOut.disabled = true;
      btnIn.title  = otherOnDevice.name + ' এখন এই ডিভাইসে চেক-ইন করা আছে';
      btnOut.title = '';
      return;
    }
  }
  // All records for this employee today, sorted oldest-first
  const { lastRec, completedSess, hasOpenRec } = empSessionState(id);

  if (!lastRec) {
    // No session yet — allow first check-in
    btnIn.disabled  = false;
    btnOut.disabled = true;
  } else if (hasOpenRec) {
    // Currently checked in — allow check-out
    btnIn.disabled  = true;
    btnOut.disabled = false;
  } else if (completedSess < MAX_CHECKINS_PER_DAY) {
    // Has completed sessions but under the cap — allow another check-in
    btnIn.disabled  = false;
    btnOut.disabled = true;
  } else {
    // Hit the daily cap — lock both
    btnIn.disabled  = true;
    btnOut.disabled = true;
    btnIn.title  = 'দৈনিক সর্বোচ্চ ' + bd(MAX_CHECKINS_PER_DAY) + ' টি চেক-ইন পূর্ণ হয়েছে';
    btnOut.title = '';
    return;
  }
  btnIn.title  = '';
  btnOut.title = '';
}
function disableBtns() {
  document.getElementById('btnIn').disabled  = true;
  document.getElementById('btnOut').disabled = true;
}

// ── ACTIONS (employee self) ───────────────────────────────────────────────────
async function doCheckIn() {
  if (!locVerified) { showToast('লোকেশন যাচাই হয়নি — স্ট্যাটাস সবুজ হওয়া পর্যন্ত ডিউটি এলাকায় থাকুন', 'error'); return; }
  const emp = getEmp(); if (!emp) return;
  const now = new Date();
  // date and deviceId are re-set server-side; we send them as hints only
  const rec = { employeeId: emp.id, name: emp.name, designation: emp.designation || '',
    date: shiftDateStr(), checkIn: timeStr(now), checkInTimestamp: now.toISOString(),
    checkOut: null, checkOutTimestamp: null,
    location: locName, lat: currentPos.lat, lng: currentPos.lng, deviceId: effDeviceId(), deviceToken };
  await withBtnLoad('btnIn', async () => {
    const inserted = await appendRecord(rec);
    if (!inserted) return;  // check-in cancelled via incomplete-days warning modal
    // Adopt the authoritative token (the worker re-set it server-side) and
    // persist it everywhere, so a later check-out on this device can be owned
    // even if the client had arrived token-less.
    if (inserted.deviceToken && inserted.deviceToken !== deviceToken) {
      deviceToken = inserted.deviceToken;
      await persistDeviceToken(deviceToken);
    }
    todayRecs.push({ ...rec, id: inserted.id });  // store server-assigned UUID
    renderRecords(); updateBtns(); renderDeviceLine();
    showToast('✅ ' + bd(rec.checkIn) + ' এ চেক-ইন হয়েছে', 'success');
  });
}
async function doCheckOut() {
  if (!locVerified) { showToast('লোকেশন যাচাই হয়নি — স্ট্যাটাস সবুজ হওয়া পর্যন্ত ডিউটি এলাকায় থাকুন', 'error'); return; }
  const emp = getEmp(); if (!emp) return;
  const rec = todayRecs.find(r => r.employeeId === emp.id && r.date === shiftDateStr() && !r.checkOut);
  if (!rec) { showToast('সক্রিয় চেক-ইন পাওয়া যায়নি — চেক-আউটের আগে চেক-ইন করুন', 'error'); return; }
  if (!rec.id) { showToast('সার্ভার থেকে রেকর্ড ID পাওয়া যায়নি — পেজ রিফ্রেশ করে আবার চেষ্টা করুন', 'error'); return; }
  await withBtnLoad('btnOut', async () => {
    const now     = new Date();
    const coTime  = timeStr(now);
    try {
      const updated = await attUpdate(rec.id, { checkOut: coTime });
      rec.checkOut = updated.checkOut || coTime;
      rec.checkOutTimestamp = updated.checkOutTimestamp;
      renderRecords(); updateBtns(); renderDeviceLine();
      showToast('🚪 ' + bd(rec.checkOut) + ' এ চেক-আউট হয়েছে', 'success');
    } catch(e) {
      if (e.message === 'You cannot check out another person') {
        // Show the admin-recovery sheet instead of a transient toast — the
        // employee needs to know the session can be closed by scanning their
        // QR card from admin view.
        document.getElementById('checkoutLockedOverlay').classList.add('open');
      } else {
        throw e;
      }
    }
  });
}

async function withBtnLoad(id, fn) {
  const btn = document.getElementById(id);
  const orig = btn.innerHTML;
  btn.innerHTML = '<span class="spinner"></span>';
  btn.disabled = true;
  try { await fn(); } catch(e) { showToast(e.message, 'error'); }
  btn.innerHTML = orig;
}

// ── INCOMPLETE CHECK-OUT WARNING MODAL ───────────────────────────────────────
// When an employee has previous days without a check-out, check-in is not blocked —
// the employee is warned instead and must confirm (I Agree) to proceed.
let _warnResolve = null;

function confirmIncompleteCheckIn(dates, name, isSelf) {
  return new Promise((resolve) => {
    _warnResolve = resolve;
    const daysEl = document.getElementById('warnDays');
    daysEl.innerHTML = '';
    dates.forEach(d => {
      const chip = document.createElement('div');
      chip.className = 'warn-day';
      chip.textContent = d;
      daysEl.appendChild(chip);
    });
    const plural = dates.length > 1;
    const frame  = isSelf ? 'আপনি' : name;
    const dayWord = plural ? 'আগের ' + bd(dates.length) + ' টি দিনে' : 'একটি আগের দিনে';
    document.getElementById('warnSub').textContent =
      frame + ' ' + dayWord + ' চেক-আউট করেননি।';
    document.getElementById('warnText').textContent =
      'সমস্যা সমাধানে অফিসে যোগাযোগ করুন। অন্যথায় ' +
      (plural ? 'এই দিনগুলোর' : 'এই দিনটির') + ' বেতন কাটা হতে পারে।';
    document.getElementById('warnOverlay').classList.add('open');
  });
}

function warnAgree() {
  document.getElementById('warnOverlay').classList.remove('open');
  const resolve = _warnResolve; _warnResolve = null;
  if (resolve) resolve(true);
}

function warnDismiss() {
  document.getElementById('warnOverlay').classList.remove('open');
  const resolve = _warnResolve; _warnResolve = null;
  if (resolve) resolve(false);
}

function warnOverlayClick(e) {
  if (e.target.id === 'warnOverlay') warnDismiss();
}

// ── RECORD OPS ────────────────────────────────────────────────────────────────
// Client checks below are UX fast-fails — all rules are re-enforced server-side
// in the worker and cannot be bypassed by a malicious or modified client.

// Shared validation for employee self and admin check-in.
// Returns true if check-in is allowed, false if cancelled, throws on blocking error.
async function validateCheckIn(rec, isSelf, records) {
  // Device proxy check (self check-in only)
  if (isSelf && (rec.deviceId || rec.deviceToken)) {
    const openDevRec = records.find(r =>
      ((r.deviceId === rec.deviceId) || (r.deviceToken && r.deviceToken === rec.deviceToken)) &&
      r.checkIn && !r.checkOut && r.employeeId !== rec.employeeId);
    if (openDevRec) throw new Error('আরেকজন কর্মচারী (' + openDevRec.name + ') এই ডিভাইসে চেক-ইন করা আছেন');
  }
  // Same-day open session blocks a new check-in
  const openToday = records.find(r => r.employeeId === rec.employeeId && r.date === rec.date && r.checkIn && !r.checkOut);
  if (openToday) throw new Error(rec.name + ' আজ ইতিমধ্যে চেক-ইন করেছেন — আগে চেক-আউট করুন');
  // Previous days without a check-out — warn and require confirmation
  const openPrev = records.filter(r => r.employeeId === rec.employeeId && r.date !== rec.date && r.checkIn && !r.checkOut);
  if (openPrev.length) {
    const agreed = await confirmIncompleteCheckIn(openPrev.map(r => r.date).sort(), rec.name, isSelf);
    if (!agreed) return false;
  }
  // Daily cap
  const completedToday = records.filter(r => r.employeeId === rec.employeeId && r.date === rec.date && r.checkIn && r.checkOut).length;
  if (completedToday >= MAX_CHECKINS_PER_DAY) throw new Error(rec.name + ' আজকের দৈনিক সর্বোচ্চ ' + bd(MAX_CHECKINS_PER_DAY) + ' টি চেক-ইন পূর্ণ করেছেন');
  return true;
}

async function appendRecord(rec) {
  const records = await attGet().catch(() => []);
  const valid = await validateCheckIn(rec, true, records);
  if (!valid) return null;
  return attInsert(rec);
}

// ── RENDER (employee view) ────────────────────────────────────────────────────
// A record is "inside" when checked in but not yet out; "left" once checked out.
function isInside(r) { return !!r.checkIn && !r.checkOut; }

function filteredRecords() {
  const q = recSearch.trim().toLowerCase();
  return todayRecs.filter(r => {
    if (recStatusFilter === 'inside' && !isInside(r)) return false;
    if (recStatusFilter === 'left'   &&  isInside(r)) return false;
    if (!q) return true;
    return (r.name||'').toLowerCase().includes(q)
        || (r.designation||'').toLowerCase().includes(q)
        || (r.location||'').toLowerCase().includes(q);
  });
}

// Shared record-list renderer: sorts by check-in time and maps each row.
function renderRecordList(el, list) {
  if (!el) return;
  if (!list.length) { el.innerHTML = '<div class="empty-state"><div class="e-icon">🗒️</div>আজ এখনও কোনো রেকর্ড নেই</div>'; return; }
  const sorted = [...list].sort((a,b) => (a.checkInTimestamp||'').localeCompare(b.checkInTimestamp||''));
  el.innerHTML = sorted.map(r => recordHTML(r)).join('');
}

function renderRecords() {
  const el  = document.getElementById('recordsList');
  const bar = document.getElementById('recFilter');
  if (bar) bar.style.display = todayRecs.length ? '' : 'none';
  updateRecFilterCounts();
  const list = filteredRecords();
  if (!list.length) { el.innerHTML = '<div class="empty-state"><div class="e-icon">🔍</div>কোনো মিল পাওয়া যায়নি</div>'; return; }
  renderRecordList(el, list);
}

function updateRecFilterCounts() {
  const set = (id, n) => { const e = document.getElementById(id); if (e) e.textContent = n; };
  set('recN-all',    todayRecs.length);
  set('recN-inside', todayRecs.filter(isInside).length);
  set('recN-left',   todayRecs.filter(r => !isInside(r)).length);
}

function filterRecords() {
  recSearch = document.getElementById('recSearch').value;
  document.getElementById('recClear').style.display = recSearch ? '' : 'none';
  renderRecords();
}
function clearRecSearch() {
  recSearch = '';
  document.getElementById('recSearch').value = '';
  document.getElementById('recClear').style.display = 'none';
  renderRecords();
}
function setRecFilter(status) {
  recStatusFilter = status;
  document.querySelectorAll('#recChips .rec-chip')
    .forEach(c => c.classList.toggle('active', c.dataset.status === status));
  renderRecords();
}

function renderAdminRecords() {
  renderRecordList(document.getElementById('adminRecordsList'), todayRecs);
  updatePostMeta();
}

function recordHTML(r) {
  const init  = initials(r.name);
  const desig = r.designation ? `<div class="record-desig">🏷️ ${r.designation}</div>` : '';
  const inC   = r.checkIn  ? `<span class="time-chip chip-in">▲ ${bd(r.checkIn)}</span>` : '';
  const outC  = r.checkOut ? `<span class="time-chip chip-out">▼ ${bd(r.checkOut)}</span>` : (r.checkIn ? '<span class="time-chip chip-pending">⏳ চলমান</span>' : '');
  let adminC = '';
  if (r.deviceId && r.deviceId.startsWith('ADMIN')) {
    // deviceId is either "ADMIN" (legacy) or "ADMIN|QR Printed on <datetime>"
    const parts    = r.deviceId.split('|');
    const printLabel = parts[1] || '';   // e.g. "QR Printed on Mon, 2 Jun 2025 14:32:07"
    const tooltip    = printLabel ? ` title="${printLabel}"` : '';
    adminC = `<span class="time-chip chip-admin"${tooltip}>🛡️ অ্যাডমিন${printLabel ? ' · 🖨️' : ''}</span>`;
    if (printLabel) adminC += `<span class="time-chip chip-admin" style="font-size:9px;opacity:0.85">${printLabel.replace('QR Printed on ','')}</span>`;
  }
  const clickable = r.id ? ` clickable" data-recid="${esc(r.id)}" role="button" tabindex="0" onclick="openGateModal('${esc(r.id)}')` : '';
  return `<div class="record-item${clickable}"><div class="record-avatar">${init}</div><div class="record-info"><div class="record-name">${r.name}</div>${desig}<div class="record-loc">📍 ${r.location||'—'}</div></div><div class="record-times">${inC}${outC}${adminC}</div>${r.id ? '<div class="record-chevron">›</div>' : ''}</div>`;
}

// ── GATE CHECK MODAL ──────────────────────────────────────────────────────────
// Tapped from a Today's Attendance card. Shows a guard, at a glance, whether the
// person is on premises or has left, with exact check-in / check-out details.
function openGateModal(id) {
  if (!id) return;
  const r = todayRecs.find(x => x.id === id);
  if (!r) return;

  const init = initials(r.name);
  document.getElementById('gateAvatar').textContent = init;
  document.getElementById('gateName').textContent   = r.name || '—';
  const desigEl = document.getElementById('gateDesig');
  desigEl.textContent   = r.designation || '';
  desigEl.style.display = r.designation ? '' : 'none';
  document.getElementById('gateMeta').innerHTML =
    (r.employeeId ? '🪪 ' + esc(r.employeeId) + '&nbsp;&nbsp;·&nbsp;&nbsp;' : '') +
    '📍 ' + esc(r.location || '—');

  // Verdict
  const inside = isInside(r);
  document.getElementById('gateVerdict').className = 'gate-verdict ' + (inside ? 'inside' : 'exited');
  document.getElementById('gateStamp').textContent = inside ? 'প্রাঙ্গণে' : 'বেরিয়েছেন';
  document.getElementById('gateVerdictSub').textContent =
    inside ? ('চেক-ইন হয়েছে ' + (r.checkIn ? bd(r.checkIn) : '—'))
           : ('চেক-আউট হয়েছে ' + (r.checkOut ? bd(r.checkOut) : '—'));
  document.getElementById('gateGuidance').textContent =
    inside ? '⛔ সীমাবদ্ধ — বের হওয়ার আগে চেক-আউট করতে হবে'
           : '✅ চেক-আউট সম্পন্ন — বের হতে পারবেন';

  // Timeline (real sequence: in → out)
  const rows = [];
  rows.push(gateTlRow('in', 'চেক-ইন', r.checkIn || '—',
                      fmtStampDate(r.checkInTimestamp), recordedBy(r)));
  rows.push(r.checkOut
    ? gateTlRow('out', 'চেক-আউট', bd(r.checkOut), fmtStampDate(r.checkOutTimestamp), '')
    : gateTlRow('pending', 'চেক-আউট', 'এখনও নয়', 'এখনও প্রাঙ্গণে আছেন', ''));
  document.getElementById('gateTimeline').innerHTML = rows.join('');

  document.getElementById('gateOverlay').classList.add('open');
}

function gateTlRow(cls, label, time, date, meta) {
  const sub = [date, meta].filter(Boolean).join(' · ');
  return '<div class="gate-tl-row ' + cls + '">' +
           '<div class="gate-tl-marker"></div>' +
           '<div class="gate-tl-text">' +
             '<div class="gate-tl-label">' + esc(label) + '</div>' +
             '<div class="gate-tl-time">' + esc(time) + '</div>' +
             (sub ? '<div class="gate-tl-meta">' + esc(sub) + '</div>' : '') +
           '</div>' +
         '</div>';
}

// How the check-in was recorded — admin QR scan vs. employee self check-in.
function recordedBy(r) {
  return (r.deviceId && r.deviceId.startsWith('ADMIN')) ? 'অ্যাডমিনের মাধ্যমে' : 'নিজে চেক-ইন';
}

// ISO timestamp → "রবি, ২০ জুন" (empty string if missing/invalid).
function fmtStampDate(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  if (isNaN(d.getTime())) return '';
  return DAY_ABBR_BN[d.getDay()] + ', ' + bd(d.getDate()) + ' ' + MONTH_ABBR_BN[d.getMonth()];
}

function closeGateModal() { document.getElementById('gateOverlay').classList.remove('open'); }
function handleGateOverlayClick(e) { if (e.target.id === 'gateOverlay') closeGateModal(); }

// ── CHECKOUT-LOCKED RECOVERY SHEET ───────────────────────────────────────────
// Shown when a check-out fails the device-ownership check. Recovery is
// admin-assisted: an admin scans the employee's QR ID card from admin view.
function closeCheckoutLocked() { document.getElementById('checkoutLockedOverlay').classList.remove('open'); }
function handleCheckoutLockedClick(e) { if (e.target.id === 'checkoutLockedOverlay') closeCheckoutLocked(); }

// ── DEVICE ID LINE (employee location card) ──────────────────────────────────
// The location card always shows this device's ID. When the selected employee
// has an OPEN session today, recorded by THIS device (same durable token) but
// with a different fingerprint than the current one, we warn that the device id
// drifted and offer to adopt the new one. Switching is a local acknowledgment —
// the worker re-records identity + fingerprint on the next check-in/out anyway.
function openSessionForEmp(emp) {
  if (!emp) return null;
  return todayRecs.find(r => r.employeeId === emp.id && r.date === shiftDateStr() && r.checkIn && !r.checkOut) || null;
}

// Persisted set of deviceIds the worker has explicitly confirmed as "this device".
function switchedDeviceIds() {
  try { return JSON.parse(localStorage.getItem('att_switchedDevices')) || []; } catch { return []; }
}
function adoptSwitchedIds(list) {
  try { localStorage.setItem('att_switchedDevices', JSON.stringify(list)); } catch {}
}

// Session-scoped dismissals, so a "পরে" choice (or a switch) stops the banner
// from flashing again on every GPS tick.
const _switchDismissed = new Set();

function renderDeviceLine() {
  const box = document.getElementById('devBox');
  if (!box) return;
  const cur   = effDeviceId();
  const shown = shortId(cur) || '—';
  let html = '<div class="dev-line">' +
               '<span class="dev-line-ico">🖥️</span>' +
               '<span class="dev-line-label">ডিভাইস আইডি</span>' +
               '<code class="dev-line-id">' + esc(shown) + '</code>' +
             '</div>';
  const emp  = getEmp();
  const open = openSessionForEmp(emp);
  if (emp && open && open.deviceToken === deviceToken && open.deviceId && cur &&
      open.deviceId !== cur && !switchedDeviceIds().includes(cur) && !_switchDismissed.has(cur)) {
    html += '<div class="dev-warn" role="status">' +
              '<span class="dev-warn-ico">⚠️</span>' +
              '<span class="dev-warn-text">চেক-ইনের সময়কার আইডি থেকে এই ডিভাইসের আইডি বদলে গেছে।</span>' +
              '<button class="dev-warn-btn" type="button" onclick="openDeviceSwitch()">নতুন আইডি ব্যবহার করুন</button>' +
            '</div>';
  }
  box.innerHTML = html;
}

function openDeviceSwitch() {
  const cur  = effDeviceId();
  const emp  = getEmp();
  const open = openSessionForEmp(emp);
  const oldId = open && open.deviceId ? open.deviceId : '—';
  document.getElementById('dsOldNew').textContent =
    'পুরনো: ' + shortId(oldId) + '    নতুন: ' + shortId(cur);
  document.getElementById('deviceSwitchOverlay').classList.add('open');
}

function closeDeviceSwitch() {
  document.getElementById('deviceSwitchOverlay').classList.remove('open');
  const cur = effDeviceId();
  if (cur) _switchDismissed.add(cur);
}

function confirmDeviceSwitch() {
  const cur = effDeviceId();
  if (cur) {
    const list = switchedDeviceIds();
    if (!list.includes(cur)) list.push(cur);
    adoptSwitchedIds(list);
  }
  closeDeviceSwitch();
  renderDeviceLine();
  showToast('✅ এই নতুন আইডিকে ডিভাইসের আইডি হিসেবে ব্যবহার করা হবে', 'success');
}

function handleDeviceSwitchClick(e) { if (e.target.id === 'deviceSwitchOverlay') closeDeviceSwitch(); }

// ── GENERIC CONFIRM ──────────────────────────────────────────────────────────
// Promise-based confirm used by the admin roster editor (delete, rename).
let _confirmCb = null;
function askConfirm({ icon = '❓', title = 'নিশ্চিত করুন', sub = '', text = '', okText = 'নিশ্চিত', okClass = 'warn-agree' } = {}) {
  return new Promise((resolve) => {
    _confirmCb = resolve;
    document.getElementById('confirmIcon').textContent  = icon;
    document.getElementById('confirmTitle').textContent = title;
    document.getElementById('confirmSub').textContent   = sub;
    document.getElementById('confirmText').textContent  = text;
    const okBtn = document.getElementById('confirmOkBtn');
    okBtn.className = 'warn-btn ' + okClass;
    okBtn.textContent = okText;
    document.getElementById('confirmOverlay').classList.add('open');
  });
}
function confirmCb(ok) {
  document.getElementById('confirmOverlay').classList.remove('open');
  const resolve = _confirmCb; _confirmCb = null;
  if (resolve) resolve(ok);
}
function confirmOverlayClick(e) { if (e.target.id === 'confirmOverlay') confirmCb(false); }

// Keyboard: Esc closes the modal; Enter/Space activates a focused record card.
document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape') closeGateModal();
  const a = document.activeElement;
  if ((e.key === 'Enter' || e.key === ' ') && a && a.classList && a.classList.contains('record-item')) {
    e.preventDefault();
    a.click();
  }
});

// ── HELPERS ───────────────────────────────────────────────────────────────────
function getEmp()    { const id = document.getElementById('empSelect').value; return employees.find(e => e.id === id) || null; }

// Uppercase initials from a name (max 2), e.g. "John Doe" → "JD".
function initials(name) {
  return (name || '?').split(' ').map(w => w[0]).slice(0,2).join('').toUpperCase();
}

// Session state for one employee today: sorted record list plus derived flags.
function empSessionState(empId) {
  const empRecs = todayRecs
    .filter(r => r.employeeId === empId && r.date === shiftDateStr())
    .sort((a, b) => (a.checkInTimestamp || '').localeCompare(b.checkInTimestamp || ''));
  const lastRec       = empRecs.length ? empRecs[empRecs.length - 1] : null;
  const completedSess = empRecs.filter(r => r.checkIn && r.checkOut).length;
  const hasOpenRec    = lastRec && lastRec.checkIn && !lastRec.checkOut;
  return { empRecs, lastRec, completedSess, hasOpenRec };
}

// ── SHIFT DATE ────────────────────────────────────────────────────────────────
// A "workday" runs from ~sunrise to next sunrise. Any time between midnight and
// SHIFT_CUTOFF_HOUR (04:00) is still considered part of the *previous* calendar
// day's shift — so overnight check-outs are matched to their check-in date.
// The server computes the shift date using IST (TZ_OFFSET_MIN=330) and returns it
// in the config response as _shiftDate.  The client uses that authoritative value.
const SHIFT_CUTOFF_HOUR = 4;   // 04:00 — adjust if your site has earlier starts
function shiftDateStr() {
  if (serverShiftDate) return serverShiftDate;
  // Fallback: compute locally (matches server only when browser is in IST)
  const d = new Date();
  if (d.getHours() < SHIFT_CUTOFF_HOUR) d.setDate(d.getDate() - 1);
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}
function timeStr(d)  { return pad(d.getHours())+':'+pad(d.getMinutes())+':'+pad(d.getSeconds()); }

let toastTmr;
function showToast(msg, type='') {
  const el = document.getElementById('toast');
  el.textContent = msg; el.className = 'toast ' + type;
  void el.offsetWidth;
  el.classList.add('show');
  clearTimeout(toastTmr);
  toastTmr = setTimeout(() => el.classList.remove('show'), 5000);
}

// ══════════════════════════════════════════════════════════════════════════════
// ── ADMIN MODE ────────────────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════

// ── PIN ───────────────────────────────────────────────────────────────────────
let pinBuffer  = '';
let pinPurpose = 'admin';   // 'admin' | 'qr'

function handleAdminBtn() {
  if (isAdmin) { exitAdmin(); return; }
  openPinOverlay('admin');
}

function openPinOverlay(purpose = 'admin') {
  pinPurpose = purpose;
  pinBuffer  = '';
  renderPinDots();
  document.getElementById('pinSubmit').disabled = true;
  if (purpose === 'qr') {
    document.getElementById('pinIcon').textContent  = '🖨️';
    document.getElementById('pinTitle').textContent = 'QR কোড প্রিন্ট';
    document.getElementById('pinSub').textContent   = 'QR প্রিন্ট করার জন্য অ্যাডমিন PIN দিন';
  } else if (purpose === 'download') {
    document.getElementById('pinIcon').textContent  = '📥';
    document.getElementById('pinTitle').textContent = 'রেকর্ড ডাউনলোড';
    document.getElementById('pinSub').textContent   = 'এটেন্ডেন্সের তথ্য ডাউনলোড করতে অ্যাডমিন PIN দিন';
  } else {
    document.getElementById('pinIcon').textContent  = '🔐';
    document.getElementById('pinTitle').textContent = 'অ্যাডমিন অ্যাক্সেস';
    document.getElementById('pinSub').textContent   = 'চালিয়ে যেতে আপনার PIN দিন';
  }
  document.getElementById('pinOverlay').classList.add('open');
}

function closePinOverlay() {
  pinBuffer = '';
  renderPinDots();
  document.getElementById('pinSubmit').disabled = true;
  document.getElementById('pinOverlay').classList.remove('open');
}

function pinKey(d) {
  if (pinBuffer.length >= 20) return;  // reasonable max, not enforced server-side
  pinBuffer += d;
  renderPinDots();
  document.getElementById('pinSubmit').disabled = pinBuffer.length === 0;
}

function pinDel() {
  pinBuffer = pinBuffer.slice(0, -1);
  renderPinDots();
  document.getElementById('pinSubmit').disabled = pinBuffer.length === 0;
}

function renderPinDots(error) {
  const container = document.getElementById('pinDots');
  container.innerHTML = '';
  for (let i = 0; i < pinBuffer.length; i++) {
    const dot = document.createElement('div');
    dot.className = 'pin-dot' + (error ? ' error' : ' filled');
    container.appendChild(dot);
  }
  // Show empty placeholder dots (minimum 4 for visual balance when buffer is short)
  const empties = Math.max(0, 4 - pinBuffer.length);
  for (let i = 0; i < empties; i++) {
    const dot = document.createElement('div');
    dot.className = 'pin-dot' + (error ? ' error' : '');
    container.appendChild(dot);
  }
}

function _pinError(msg) {
  renderPinDots(true);
  setTimeout(() => { pinBuffer = ''; renderPinDots(); document.getElementById('pinSubmit').disabled = true; }, 700);
  showToast(msg, 'error');
}

async function submitPin() {
  const pin = pinBuffer;
  document.getElementById('pinKeypad').style.pointerEvents = 'none';
  document.getElementById('pinSubmit').disabled = true;
  document.getElementById('pinSubmit').textContent = '…';
  try {
    await _sendJson(WORKER_URL + 'verify-pin', 'POST', { adminPin: pin });
    verifiedPin = pin;
    closePinOverlay();
    if (pinPurpose === 'qr' || pinPurpose === 'download') {
      startAdminTimer();
    }
    if (pinPurpose === 'qr') {
      openQrPrint();
    } else if (pinPurpose === 'download') {
      openDownloadSheet();
    } else {
      enterAdmin();
    }
  } catch (e) {
    _pinError(e.message || 'ভুল PIN — অ্যাডমিন PIN-এ বড়/ছোট হাতের অক্ষর আলাদাভাবে গণ্য হয়, আবার চেষ্টা করুন');
  } finally {
    document.getElementById('pinKeypad').style.pointerEvents = '';
    document.getElementById('pinSubmit').textContent = '✓ PIN নিশ্চিত করুন';
  }
}

// ── ENTER / EXIT ADMIN ────────────────────────────────────────────────────────
const ADMIN_SESSION_MS = 5 * 60 * 1000;   // 5 minutes
let   _adminTimer      = null;

function startAdminTimer() {
  clearTimeout(_adminTimer);
  _adminTimer = setTimeout(() => {
    showToast('⏱️ অ্যাডমিন সেশন শেষ — আবার আপনার PIN দিন', 'warning');
    revokeAdminSession();
  }, ADMIN_SESSION_MS);
}

function resetAdminTimer() {
  if (_adminTimer !== null) startAdminTimer();   // only reset if a session is active
}

function revokeAdminSession() {
  clearTimeout(_adminTimer);
  _adminTimer = null;
  // Close any open privileged sheets first
  document.getElementById('qrPrintOverlay').classList.remove('open');
  // Exit full admin mode if active
  if (isAdmin) {
    isAdmin = false;
    teardownAdminUi();
  }
  verifiedPin = null;
}

function teardownAdminUi() {
  stopAdminWatch();
  stopScanner();
  scannedEmpId     = null;
  scannedPrintedAt = null;
  const view = document.getElementById('adminView');
  view.classList.remove('admin-in');
  view.style.display = 'none';
  document.getElementById('employeeView').style.display = 'block';
  document.getElementById('adminBtn').classList.remove('admin-active');
}

function enterAdmin() {
  isAdmin = true;
  const view = document.getElementById('adminView');
  view.style.display = 'block';
  view.classList.add('admin-in');
  document.getElementById('employeeView').style.display = 'none';
  document.getElementById('adminBtn').classList.add('admin-active');
  renderAdminRecords();
  populateAdminLocs();
  renderMgmtEmpList();
  renderMgmtLocList();
  updatePostMeta();
  populateSummaryMonths();
  startAdminWatch();
  resetCameraToggleBtn();
  startAdminTimer();
}

// ── PASS BOARD (admin function grid) ──────────────────────────────────────────
// The admin view is a board of clipped passes. On narrow screens each pass is a
// compact launcher that expands to full width when opened; on wide screens the
// whole board is a static dashboard. togglePost()/openPost() drive the accordion.
function togglePost(head) {
  const post = head.closest('.pass');
  if (!post || post.classList.contains('pass-hero')) return;
  const open = post.classList.toggle('open');
  if (open) {
    document.querySelectorAll('#passBoard .pass.open').forEach(p => { if (p !== post) p.classList.remove('open'); });
    if (matchMedia('(max-width: 679px)').matches) {
      post.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }
}

function openPost(id) {
  const post = document.getElementById(id);
  if (!post) return;
  if (!post.classList.contains('open')) {
    document.querySelectorAll('#passBoard .pass.open').forEach(p => { if (p !== post) p.classList.remove('open'); });
    post.classList.add('open');
  }
  post.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// Live counts in each pass tag — the legder shows "inside / total", the roster
// shows roster sizes, and the card pass shows how many passes can be printed.
function updatePostMeta() {
  const ledger = document.getElementById('ledgerMeta');
  if (ledger) {
    const inside = todayRecs.filter(r => r.checkIn && !r.checkOut).length;
    ledger.textContent = 'ভিতরে ' + bd(inside) + ' · ' + bd(todayRecs.length) + ' জন';
  }
  const roster = document.getElementById('rosterMeta');
  if (roster) roster.textContent = '👥 ' + bd(employees.length) + ' · 📍 ' + bd(locations.length);
  const cards = document.getElementById('cardMeta');
  if (cards) cards.textContent = bd(employees.length) + ' জন';
}

function exitAdmin() {
  clearTimeout(_adminTimer);
  _adminTimer = null;
  isAdmin = false;
  verifiedPin = null;
  teardownAdminUi();
}

// ── ADMIN DATA MANAGEMENT (roster editor) ────────────────────────────────────
// Adds/edits/deletes employees and locations. Every change mutates the in-memory
// arrays and is persisted by upserting the whole config via POST /config — the
// worker is the only writer (RLS allows anon SELECT only) and requires the PIN.
function switchMgmtTab(tab) {
  const emps  = document.getElementById('mgmtEmpList');
  const locs  = document.getElementById('mgmtLocList');
  const addE  = document.getElementById('btnAddEmp');
  const addL  = document.getElementById('btnAddLoc');
  const tabE  = document.getElementById('tabEmps');
  const tabL  = document.getElementById('tabLocs');
  emps.style.display  = tab === 'emps' ? '' : 'none';
  locs.style.display  = tab === 'locs' ? '' : 'none';
  addE.style.display  = tab === 'emps' ? '' : 'none';
  addL.style.display  = tab === 'locs' ? '' : 'none';
  tabE.classList.toggle('active', tab === 'emps');
  tabL.classList.toggle('active', tab === 'locs');
}

function renderMgmtEmpList() {
  const el = document.getElementById('mgmtEmpList');
  if (!el) return;
  employees.sort((a, b) => a.name.localeCompare(b.name));
  if (!employees.length) {
    el.innerHTML = '<div class="mgmt-empty">কোনো কর্মচারী নেই — উপরে "নতুন কর্মচারী" চেপে যোগ করুন</div>';
    return;
  }
  el.innerHTML = employees.map(e => {
    const estName = establishments.find(s => s.id === e.establishmentId);
    const est = estName ? ('<span class="mgmt-human"> · ' + esc(estName.name) + '</span>') : '';
    return '<div class="mgmt-row">' +
             '<div class="mgmt-avatar">' + esc(initials(e.name)) + '</div>' +
             '<div class="mgmt-info">' +
               '<div class="mgmt-name">' + esc(e.name) + '</div>' +
               '<div class="mgmt-sub">' + esc(e.id) + est + '</div>' +
             '</div>' +
             '<div class="mgmt-actions">' +
               '<button class="mgmt-btn edit" title="সম্পাদনা" aria-label="সম্পাদনা" onclick="openEmpForm(\'' + esc(e.id) + '\')">✏️</button>' +
               '<button class="mgmt-btn del" title="মুছুন" aria-label="মুছুন" onclick="askDelEmp(\'' + esc(e.id) + '\')">🗑️</button>' +
             '</div>' +
           '</div>';
  }).join('');
}

function renderMgmtLocList() {
  const el = document.getElementById('mgmtLocList');
  if (!el) return;
  locations.sort((a, b) => a.name.localeCompare(b.name));
  if (!locations.length) {
    el.innerHTML = '<div class="mgmt-empty">কোনো ডিউটি স্থান নেই — উপরে "নতুন ডিউটি স্থান" চেপে যোগ করুন</div>';
    return;
  }
  el.innerHTML = locations.map(l => {
    const tol  = l.tolerance || 15;
    const used = employees.filter(e => (e.locationIds || []).includes(l.id)).length;
    return '<div class="mgmt-row">' +
             '<div class="mgmt-avatar">📍</div>' +
             '<div class="mgmt-info">' +
               '<div class="mgmt-name">' + esc(l.name) + '</div>' +
               '<div class="mgmt-sub">' + esc(l.id) + ' · ' +
                 '<span class="mgmt-human">' + bd(l.lat) + ', ' + bd(l.lng) + ' · সীমা ' + bd(tol) + ' মিটার</span></div>' +
             '</div>' +
             '<div class="mgmt-actions">' +
               '<button class="mgmt-btn edit" title="সম্পাদনা" aria-label="সম্পাদনা" onclick="openLocForm(\'' + esc(l.id) + '\')">✏️</button>' +
               '<button class="mgmt-btn del" title="মুছুন" aria-label="মুছুন" onclick="askDelLoc(\'' + esc(l.id) + '\')">🗑️</button>' +
             '</div>' +
           '</div>';
  }).join('');
}

// Auto id: next numeric suffix after existing "EMP###" / "LOC-###" ids.
function autoId(prefix, list, noDash) {
  const re = new RegExp('^' + (noDash ? prefix : prefix + '-') + '(\\d+)$');
  let max = 0;
  list.forEach(x => {
    const m = String(x.id || '').match(re);
    if (m) max = Math.max(max, +m[1]);
  });
  return (noDash ? prefix : prefix + '-') + String(max + 1).padStart(3, '0');
}

// ── DATA FORM (add/edit) ─────────────────────────────────────────────────────
// Shared bottom-sheet form. _dataForm = { kind:'emp'|'loc', id:null|string }.
let _dataForm = null;

function openEmpForm(id) {
  const emp = id ? employees.find(e => e.id === id) : null;
  _dataForm = { kind: 'emp', id: id || null };
  const estOptions = establishments.map(s =>
    '<option value="' + esc(s.id) + '"' + ((emp && emp.establishmentId === s.id) ? ' selected' : '') + '>' + esc(s.name) + '</option>').join('');
  const locPills = locations.map(l => {
    const on = emp && (emp.locationIds || []).includes(l.id);
    return '<button type="button" class="data-loc-pill' + (on ? ' sel' : '') + '" data-lid="' + esc(l.id) + '"' +
           ' onclick="toggleEmpLocPill(this, \'' + esc(l.id) + '\')">' + esc(l.name) + '</button>';
  }).join('');
  document.getElementById('dataFormTitle').textContent = id ? 'কর্মচারী সম্পাদনা' : 'নতুন কর্মচারী';
  document.getElementById('dataFormBody').innerHTML =
    '<div class="data-field"><div class="data-field-label">কর্মচারীর নাম *</div>' +
      '<input type="text" class="data-input" id="dfName" value="' + (emp ? esc(emp.name) : '') + '" placeholder="পুরো নাম">' +
    '</div>' +
    '<div class="data-field"><div class="data-field-label">পদবি</div>' +
      '<input type="text" class="data-input" id="dfDesig" value="' + (emp ? esc(emp.designation || '') : '') + '" placeholder="যেমন: ম্যানেজার">' +
    '</div>' +
    (establishments.length
      ? '<div class="data-field"><div class="data-field-label">প্রতিষ্ঠান</div>' +
        '<select class="data-input" id="dfEst" style="appearance:auto">' +
          '<option value="">— নেই —</option>' + estOptions + '</select></div>'
      : '<input type="hidden" id="dfEst" value="">') +
    '<div class="data-field"><div class="data-field-label">ডিউটি স্থান</div>' +
      '<div class="data-loc-pills" id="dfLocPills">' + (locPills || '<span class="data-hint">কোনো ডিউটি স্থান নেই — আগে একটি স্থান যোগ করুন</span>') + '</div>' +
    '</div>' +
    '<div class="data-hint">সংশোধন সাপেক্ষ: নাম বা পদবি বদলালে পুরনো ছাপা QR কার্ড অকার্যকর হয়ে পড়তে পারে।</div>' +
    '<div class="data-form-actions">' +
      '<button class="btn-form-cancel" onclick="closeDataForm()">বাতিল</button>' +
      '<button class="btn-save small" style="flex:2" onclick="saveDataForm()">সংরক্ষণ করুন</button>' +
    '</div>';
  document.getElementById('dataFormOverlay').classList.add('open');
}

function toggleEmpLocPill(btn, lid) {
  btn.classList.toggle('sel');
}

function openLocForm(id) {
  const loc = id ? locations.find(l => l.id === id) : null;
  _dataForm = { kind: 'loc', id: id || null };
  document.getElementById('dataFormTitle').textContent = id ? 'ডিউটি স্থান সম্পাদনা' : 'নতুন ডিউটি স্থান';
  document.getElementById('dataFormBody').innerHTML =
    '<div class="data-field"><div class="data-field-label">স্থানের নাম *</div>' +
      '<input type="text" class="data-input" id="dfLocName" value="' + (loc ? esc(loc.name) : '') + '" placeholder="যেমন: দক্ষিণ গেট">' +
    '</div>' +
    '<div class="data-field"><div class="data-field-label">অক্ষাংশ (lat) *</div>' +
      '<input type="number" step="any" class="data-input" id="dfLat" value="' + (loc ? loc.lat : '') + '" placeholder="12.971599">' +
    '</div>' +
    '<div class="data-field"><div class="data-field-label">দ্রাঘিমাংশ (lng) *</div>' +
      '<input type="number" step="any" class="data-input" id="dfLng" value="' + (loc ? loc.lng : '') + '" placeholder="77.594566">' +
    '</div>' +
    '<div class="data-field"><div class="data-field-label">সহনশীলতা (মিটার) *</div>' +
      '<input type="number" step="1" min="1" class="data-input" id="dfTol" value="' + (loc ? (loc.tolerance || 15) : 15) + '">' +
      '<div class="data-hint">কর্মচারী কত মিটারের মধ্যে থাকলে চেক-ইন/আউট allowed হবে।</div>' +
    '</div>' +
    '<div class="data-form-actions">' +
      '<button class="btn-form-cancel" onclick="closeDataForm()">বাতিল</button>' +
      '<button class="btn-save small" style="flex:2" onclick="saveDataForm()">সংরক্ষণ করুন</button>' +
    '</div>';
  document.getElementById('dataFormOverlay').classList.add('open');
}

function closeDataForm() { document.getElementById('dataFormOverlay').classList.remove('open'); _dataForm = null; }
function dataFormOverlayClick(e) { if (e.target.id === 'dataFormOverlay') closeDataForm(); }

function _selectedLocIds() {
  return [...document.querySelectorAll('#dfLocPills .data-loc-pill.sel')].map(p => p.dataset.lid);
}

// Persist the mutated config through the worker (PIN-guarded), then refresh.
async function pushConfigData() {
  await _sendJson(WORKER_URL + 'config', 'POST', {
    adminPin: verifiedPin,
    data: { establishments, employees, locations },
  });
}

function refreshRosterUi() {
  populateEmployees();
  populateEstablishments();
  populateAdminLocs();
  buildUuidLookup().then(() => {});
  renderMgmtEmpList();
  renderMgmtLocList();
  renderRecords();
  renderAdminRecords();
  updatePostMeta();
}

async function saveDataForm() {
  const f = _dataForm;
  if (!f) return;
  const saveBtn = document.querySelector('#dataFormOverlay .btn-save');
  const orig    = saveBtn.textContent;
  saveBtn.disabled = true; saveBtn.textContent = 'সংরক্ষণ হচ্ছে…';
  try {
    if (f.kind === 'emp') {
      const name  = document.getElementById('dfName').value.trim();
      const desig = document.getElementById('dfDesig').value.trim();
      if (!name) throw new Error('কর্মচারীর নাম দিন');
      const estInput = document.getElementById('dfEst');
      const establishmentId = estInput ? (estInput.value || null) : null;
      const locIds = _selectedLocIds();

      if (f.id) {
        const emp = employees.find(x => x.id === f.id);
        if (emp && (emp.name !== name || (emp.designation || '') !== desig)) {
          const go = await askConfirm({
            icon: '🪪', title: 'QR কার্ড বদলাতে হবে',
            sub: 'নাম বা পদবি বদলে গেলে এই কর্মচারীর QR আইডি বদলে যায়।',
            text: 'পুরনো মুদ্রিত কার্ডগুলো কাজ করবে না — ভবিষ্যতে এটেন্ডেন্স দিতে নতুন কার্ড ছাপাতে হবে। চালিয়ে যাবেন?',
            okText: 'হ্যাঁ, সংরক্ষণ করুন',
          });
          if (!go) return;
        }
        emp.name = name; emp.designation = desig;
        emp.establishmentId = establishmentId;
        emp.locationIds = locIds;
      } else {
        const id = autoId('EMP', employees, true);
        employees.push({ id, name, designation: desig, establishmentId, locationIds: locIds });
      }
    } else {
      const name = document.getElementById('dfLocName').value.trim();
      const lat  = parseFloat(document.getElementById('dfLat').value);
      const lng  = parseFloat(document.getElementById('dfLng').value);
      const tol  = parseInt(document.getElementById('dfTol').value, 10);
      if (!name) throw new Error('স্থানের নাম দিন');
      if (isNaN(lat) || isNaN(lng)) throw new Error('সঠিক অক্ষাংশ/দ্রাঘিমাংশ দিন');
      if (isNaN(tol) || tol < 1) throw new Error('সহনশীলতা কমপক্ষে ১ মিটার দিন');
      if (f.id) {
        const loc = locations.find(x => x.id === f.id);
        loc.name = name; loc.lat = lat; loc.lng = lng; loc.tolerance = tol;
      } else {
        locations.push({ id: autoId('LOC', locations, false), name, lat, lng, tolerance: tol });
      }
    }
    await pushConfigData();
    refreshRosterUi();
    closeDataForm();
    showToast('✅ সংরক্ষণ সম্পন্ন হয়েছে', 'success');
  } catch(e) {
    showToast(e.message || 'সংরক্ষণ ব্যর্থ হয়েছে', 'error');
  } finally {
    if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = orig; }
  }
}

function askDelEmp(id) {
  const emp = employees.find(e => e.id === id);
  if (!emp) return;
  askConfirm({
    icon: '🗑️', title: 'কর্মচারী মুছবেন?',
    sub: emp.name + ' (' + emp.id + ')',
    text: 'তার পুরনো এটেন্ডেন্স রেকর্ড থাকবে, তবে নাম টিকে আর এই অ্যাপে থাকবে না। QR কার্ড আর স্ক্যান হবে না।',
    okText: 'মুছুন',
  }).then(async (go) => {
    if (!go) return;
    employees = employees.filter(e => e.id !== id);
    await pushConfigData();
    refreshRosterUi();
    showToast('🗑️ কর্মচারী মুছে ফেলা হয়েছে', 'success');
  }).catch(() => {});
}

function askDelLoc(id) {
  const loc = locations.find(l => l.id === id);
  if (!loc) return;
  const used = employees.filter(e => (e.locationIds || []).includes(id)).length;
  askConfirm({
    icon: '🗑️', title: 'ডিউটি স্থান মুছবেন?',
    sub: loc.name + ' (' + loc.id + ')',
    text: used
      ? bd(used) + ' জন কর্মচারী এতে যুক্ত — মুছলে তাদের ডিউটি এলাকা ধরা পড়বে না। চালিয়ে যেতে পরে তাদের সম্পাদনা করে স্থান বদলে দিন।'
      : 'এই স্থানটি মুছে গেলে কনফিগারেশন থেকে বাদ পড়বে।',
    okText: 'মুছুন',
  }).then(async (go) => {
    if (!go) return;
    locations = locations.filter(l => l.id !== id);
    employees.forEach(e => {
      if (e.locationIds && e.locationIds.includes(id)) e.locationIds = e.locationIds.filter(x => x !== id);
    });
    if (adminLocId === id) { adminLocId = null; }
    await pushConfigData();
    refreshRosterUi();
    showToast('🗑️ ডিউটি স্থান মুছে ফেলা হয়েছে', 'success');
  }).catch(() => {});
}

// ── ADMIN LOCATION PILLS ──────────────────────────────────────────────────────
function populateAdminLocs() {
  const container = document.getElementById('adminLocPills');
  if (!container) return;
  container.innerHTML = locations.map(l =>
    `<button class="loc-pill" data-lid="${l.id}" onclick="selectAdminLoc('${l.id}')">${l.name}</button>`
  ).join('');
  // pre-select first
  if (locations.length) selectAdminLoc(locations[0].id);
}

function selectAdminLoc(id) {
  adminLocId = id;
  document.querySelectorAll('.loc-pill').forEach(p => {
    p.classList.toggle('selected', p.dataset.lid === id);
  });
  checkAdminProximity();  // re-evaluate GPS against newly selected location
}

// ── ADMIN GPS ─────────────────────────────────────────────────────────────────
// Shared loc-status updater — prefix selects employee ("loc") vs admin ("adminLoc") ids.
function setLocState(cls, icon, title, sub, prefix) {
  const el = document.getElementById(prefix + 'Status');
  if (!el) return;
  el.className = 'loc-status ' + cls;
  document.getElementById(prefix + 'Icon').textContent  = icon;
  document.getElementById(prefix + 'Title').textContent = title;
  document.getElementById(prefix + 'Sub').textContent   = sub;
}
function setLoc(cls, icon, title, sub)      { setLocState(cls, icon, title, sub, 'loc'); }
function setAdminLoc(cls, icon, title, sub) { setLocState(cls, icon, title, sub, 'adminLoc'); }

function startAdminWatch() {
  if (adminWatchId !== null) return;
  if (!navigator.geolocation) {
    setAdminLoc('failed', '❌', 'GPS সমর্থিত নয়', 'লোকেশন যাচাই করা যাচ্ছে না');
    return;
  }
  setAdminLoc('checking', '📡', 'আপনার অবস্থান পাওয়া যাচ্ছে…', 'অনুগ্রহ করে অপেক্ষা করুন');
  adminWatchId = navigator.geolocation.watchPosition(
    pos => {
      adminCurrentPos = { lat: pos.coords.latitude, lng: pos.coords.longitude, acc: Math.round(pos.coords.accuracy) };
      checkAdminProximity();
    },
    err => {
      const msgs = { 1: 'লোকেশন অনুমতি দেওয়া হয়নি — GPS চালু করুন', 2: 'লোকেশন পাওয়া যাচ্ছে না', 3: 'লোকেশন টাইম আউট হয়েছে' };
      setAdminLoc('failed', '❌', msgs[err.code] || 'লোকেশন ত্রুটি', 'লোকেশন যাচাই না হওয়া পর্যন্ত চেক-ইন/আউট বন্ধ');
      adminLocVerified = false;
      updateAdminActionBtns();
    },
    { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 }
  );
}

function stopAdminWatch() {
  if (adminWatchId !== null) {
    navigator.geolocation.clearWatch(adminWatchId);
    adminWatchId = null;
  }
  adminCurrentPos  = null;
  adminLocVerified = false;
}

function checkAdminProximity() {
  if (!adminCurrentPos || !adminLocId) {
    if (!adminLocId) setAdminLoc('idle', '📍', 'কোনো স্থান নির্বাচিত হয়নি', 'উপরে একটি ডিউটি স্থান নির্বাচন করুন');
    adminLocVerified = false;
    updateAdminActionBtns();
    return;
  }
  const loc = locations.find(l => l.id === adminLocId);
  if (!loc) { adminLocVerified = false; updateAdminActionBtns(); return; }

  const dist = Math.round(haversine(adminCurrentPos.lat, adminCurrentPos.lng, loc.lat, loc.lng));
  const tol  = loc.tolerance || 15;

  if (dist <= tol) {
    adminLocVerified = true;
    setAdminLoc('verified', '✅', loc.name, 'আপনি ' + bd(dist) + ' মিটার দূরে — লোকেশন যাচাই হয়েছে ✓');
  } else {
    adminLocVerified = false;
    setAdminLoc('failed', '🚫', 'আপনি ' + loc.name + ' এর বাইরে আছেন',
      bd(dist) + ' মিটার দূরে — এখানে এটেন্ডেন্স দিতে ' + bd(tol) + ' মিটারের মধ্যে থাকতে হবে');
  }
  updateAdminActionBtns();
}

// Disable or re-enable the Check IN / Check OUT buttons based on GPS state.
// Called after every proximity update or location pill change.
function updateAdminActionBtns() {
  // Buttons only exist in DOM after a scan — guard safely
  const btnIn  = document.getElementById('btnScanIn');
  const btnOut = document.getElementById('btnScanOut');
  if (!btnIn || !btnOut) return;
  if (!adminLocVerified) {
    btnIn.disabled  = true;
    btnOut.disabled = true;
  } else {
    if (scannedEmpId) {
      const emp = employees.find(e => e.id === scannedEmpId);
      if (emp) {
        const { completedSess, hasOpenRec } = empSessionState(emp.id);
        if (hasOpenRec) {
          btnIn.disabled  = true;
          btnOut.disabled = false;
        } else if (completedSess < MAX_CHECKINS_PER_DAY) {
          btnIn.disabled  = false;
          btnOut.disabled = true;
        } else {
          btnIn.disabled  = true;   // daily cap reached
          btnOut.disabled = true;
        }
      }
    }
  }
}

// ── CAMERA TOGGLE ────────────────────────────────────────────────────────────
function resetCameraToggleBtn() {
  const btn  = document.getElementById('btnCameraToggle');
  const wrap = document.getElementById('qrScannerWrap');
  btn.textContent = '📷 ক্যামেরা চালু করুন';
  btn.classList.remove('active');
  wrap.classList.remove('visible');
  document.getElementById('qrScanStatus').textContent = '📷 স্ক্যান শুরু করতে "ক্যামেরা চালু করুন" চাপুন';
}

async function toggleCamera() {
  if (scannerStream) {
    // Camera is ON → turn it off
    stopScanner();
  } else {
    // Camera is OFF → turn it on
    const btn  = document.getElementById('btnCameraToggle');
    const wrap = document.getElementById('qrScannerWrap');
    btn.textContent = '⏹ ক্যামেরা বন্ধ করুন';
    btn.classList.add('active');
    wrap.classList.add('visible');
    await startScanner();
  }
}

// ── QR SCANNER ────────────────────────────────────────────────────────────────
async function startScanner() {
  try {
    scannerPaused = false;
    document.getElementById('qrScanStatus').textContent = '📷 ক্যামেরা চালু হচ্ছে…';
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 640 }, height: { ideal: 480 } }
    });
    scannerStream = stream;
    const video = document.getElementById('qrVideo');
    video.srcObject = stream;
    await video.play();
    document.getElementById('qrScanStatus').textContent = '📷 QR কোডের দিকে ক্যামেরা রাখুন';
    tickScanner();
  } catch(e) {
    document.getElementById('qrScanStatus').textContent = '❌ ক্যামেরা ত্রুটি: ' + e.message;
    resetCameraToggleBtn();   // restore "Start Camera" button state
  }
}

function stopScanner() {
  if (scannerAnimFrame) { cancelAnimationFrame(scannerAnimFrame); scannerAnimFrame = null; }
  if (scannerStream) { scannerStream.getTracks().forEach(t => t.stop()); scannerStream = null; }
  resetCameraToggleBtn();
}

function tickScanner() {
  if (scannerPaused) return;
  const video = document.getElementById('qrVideo');
  if (!video.videoWidth) { scannerAnimFrame = requestAnimationFrame(tickScanner); return; }
  const canvas = document.createElement('canvas');
  canvas.width  = video.videoWidth;
  canvas.height = video.videoHeight;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(video, 0, 0);
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const code = jsQR(imageData.data, imageData.width, imageData.height, { inversionAttempts: 'dontInvert' });
  if (code && code.data) {
    onQrDetected(code.data);
  } else {
    scannerAnimFrame = requestAnimationFrame(tickScanner);
  }
}

function resumeScanner() {
  scannerPaused    = false;
  scannedEmpId     = null;
  scannedPrintedAt = null;
  document.getElementById('scanPreview').classList.remove('visible');
  document.getElementById('scanActionRow').style.display = 'none';
  document.getElementById('btnRescan').style.display     = 'none';
  if (scannerStream) {
    document.getElementById('qrScanStatus').textContent = '📷 QR কোডের দিকে ক্যামেরা রাখুন';
    scannerAnimFrame = requestAnimationFrame(tickScanner);
  } else {
    document.getElementById('qrScanStatus').textContent = '📷 স্ক্যান শুরু করতে "ক্যামেরা চালু করুন" চাপুন';
  }
}

function onQrDetected(data) {
  // Payload format: "<uuid>|<ISO-printedAt>"  or legacy plain employeeId
  const trimmed = data.trim();
  const pipeIdx = trimmed.indexOf('|');
  const uuidPart      = pipeIdx >= 0 ? trimmed.slice(0, pipeIdx) : trimmed;
  const printedAtPart = pipeIdx >= 0 ? trimmed.slice(pipeIdx + 1) : null;

  // Resolve UUID → employeeId, fall back to legacy direct ID
  const empId = _uuidToEmpId[uuidPart] || uuidPart;
  const emp = employees.find(e => e.id === empId);
  if (!emp) {
    document.getElementById('qrScanStatus').textContent = '⚠️ অজানা QR: ' + data;
    scannerAnimFrame = requestAnimationFrame(tickScanner);
    return;
  }
  // Pause scanner
  scannerPaused = true;
  scannedEmpId       = emp.id;
  scannedPrintedAt   = printedAtPart;
  resetAdminTimer();

  // Find records for today, sorted oldest-first
  const { lastRec, completedSess, hasOpenRec } = empSessionState(emp.id);
  const capReached    = completedSess >= MAX_CHECKINS_PER_DAY && !hasOpenRec;

  const init = initials(emp.name);
  document.getElementById('scanAvatar').textContent  = init;
  document.getElementById('scanName').textContent    = emp.name;
  document.getElementById('scanDesig').textContent   = emp.designation || '';
  let stateText = '';
  if (!lastRec)        stateText = '⬜ আজ চেক-ইন করেননি';
  else if (hasOpenRec) stateText = '✅ ' + bd(lastRec.checkIn) + ' এ চেক-ইন · চেক-আউট চাপুন';
  else if (capReached) stateText = '🔒 দৈনিক সীমা পূর্ণ (' + bd(MAX_CHECKINS_PER_DAY) + ' টি সেশন সম্পন্ন)';
  else                 stateText = '↩ শেষ চেক-আউট: ' + bd(lastRec.checkOut) + ' · পুনরায় প্রবেশে চেক-ইন চাপুন';
  document.getElementById('scanState').textContent   = stateText;
  document.getElementById('scanPreview').classList.add('visible');
  document.getElementById('qrScanStatus').textContent = '✅ স্ক্যান হয়েছে: ' + emp.name;

  // Show action buttons — respect cap
  const btnIn  = document.getElementById('btnScanIn');
  const btnOut = document.getElementById('btnScanOut');
  btnIn.disabled  = hasOpenRec || capReached || !adminLocVerified;
  btnOut.disabled = !hasOpenRec || !adminLocVerified;
  document.getElementById('scanActionRow').style.display = 'grid';
  document.getElementById('btnRescan').style.display     = 'block';
}

// ── ADMIN CHECK-IN / CHECK-OUT ────────────────────────────────────────────────
async function adminDoIn() {
  const emp = employees.find(e => e.id === scannedEmpId);
  if (!emp) { showToast('কোনো কর্মচারী স্ক্যান করা হয়নি — এগোতে বৈধ QR কোড স্ক্যান করুন', 'error'); return; }
  if (!adminLocId) { showToast('কর্মচারী স্ক্যানের আগে একটি ডিউটি স্থান নির্বাচন করুন', 'warning'); return; }
  if (!adminLocVerified) { showToast('এই স্থানের জন্য আপনার লোকেশন যাচাই হয়নি — আরও কাছে আসুন', 'error'); return; }
  const loc = locations.find(l => l.id === adminLocId);
  const locLabel = loc ? loc.name : adminLocId;
  const now = new Date();
  // Encode QR print timestamp into deviceId so it's visible in raw records
  const deviceIdVal = scannedPrintedAt
    ? 'ADMIN|QR Printed on ' + formatPrintedOn(new Date(scannedPrintedAt))
    : 'ADMIN';
  const rec = {
    employeeId: emp.id, name: emp.name, designation: emp.designation || '',
    date: shiftDateStr(), checkIn: timeStr(now), checkInTimestamp: now.toISOString(),
    checkOut: null, checkOutTimestamp: null,
    location: locLabel, lat: loc ? loc.lat : '', lng: loc ? loc.lng : '',
    deviceId: deviceIdVal
  };
  document.getElementById('btnScanIn').disabled = true;
  document.getElementById('btnScanIn').innerHTML = '<span class="spinner"></span>';
  let didCheckIn = false;
  try {
    const records = await attGet().catch(() => []);
    const valid = await validateCheckIn(rec, false, records);
    if (!valid) { showToast('চেক-ইন বাতিল করা হয়েছে', 'warning'); return; }
    const inserted = await attAdminInsert({ ...rec, printedAt: scannedPrintedAt });
    todayRecs.push({ ...rec, id: inserted.id });
    renderRecords(); renderAdminRecords();
    resetAdminTimer();
    showToast('✅ ' + emp.name + ' চেক-ইন সম্পন্ন হয়েছে', 'success');
    document.getElementById('scanState').textContent = '✅ ' + bd(rec.checkIn) + ' এ চেক-ইন';
    document.getElementById('btnScanIn').disabled  = true;
    document.getElementById('btnScanOut').disabled = false;
    didCheckIn = true;
  } catch(e) {
    showToast(e.message, 'error');
  } finally {
    document.getElementById('btnScanIn').innerHTML = '✅ চেক-ইন';
    if (!didCheckIn) document.getElementById('btnScanIn').disabled = false;
  }
}

async function adminDoOut() {
  const emp = employees.find(e => e.id === scannedEmpId);
  if (!emp) { showToast('কোনো কর্মচারী স্ক্যান করা হয়নি — এগোতে বৈধ QR কোড স্ক্যান করুন', 'error'); return; }
  if (!adminLocVerified) { showToast('এই স্থানের জন্য আপনার লোকেশন যাচাই হয়নি — আরও কাছে আসুন', 'error'); return; }
  document.getElementById('btnScanOut').disabled = true;
  document.getElementById('btnScanOut').innerHTML = '<span class="spinner"></span>';
  try {
    const allRecs = await attGet().catch(() => []);
    const today   = shiftDateStr();
    const openRec = allRecs.find(r => r.employeeId === emp.id && r.date === today && !r.checkOut);
    if (!openRec) throw new Error(emp.name + ' এর কোনো সক্রিয় চেক-ইন পাওয়া যায়নি');
    if (!openRec.id) throw new Error('রেকর্ডে id নেই — আপডেট করা যাবে না');
    const now    = new Date();
    const coTime = timeStr(now);
    const updated = await attUpdate(openRec.id, { checkOut: coTime });   // worker verifies PIN
    const displayTime = updated.checkOut || coTime;
    const local = todayRecs.find(r => r.employeeId === emp.id && r.date === today && !r.checkOut);
    if (local) { local.checkOut = displayTime; local.checkOutTimestamp = updated.checkOutTimestamp; }
    renderRecords(); renderAdminRecords();
    resetAdminTimer();
    showToast('🚪 ' + emp.name + ' চেক-আউট সম্পন্ন হয়েছে', 'success');
    document.getElementById('scanState').textContent = '✔️ ' + bd(displayTime) + ' এ চেক-আউট';
    document.getElementById('btnScanOut').disabled = true;
  } catch(e) {
    showToast(e.message, 'error');
    document.getElementById('btnScanOut').disabled = false;
  }
  document.getElementById('btnScanOut').innerHTML = '🚪 চেক-আউট';
}

// ── DOWNLOAD SHEET ────────────────────────────────────────────────────────────
// Reports now live inside the admin pass board — this brings the board forward
// and reveals the report pass, ensuring its month list is loaded first.
async function openDownloadSheet() {
  if (!isAdmin && !verifiedPin) { openPinOverlay('download'); return; }
  if (!isAdmin) enterAdmin();
  await populateSummaryMonths();
  openPost('postReport');
}

// ══════════════════════════════════════════════════════════════════════════════
// ── DOWNLOAD RECORDS ──────────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════

function triggerDownload(filename, content) {
  const a = document.createElement('a');
  a.href = 'data:text/csv;charset=utf-8,' + encodeURIComponent(content);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

// Disable + dim a download button while `fn` runs; restores it afterwards and
// rethrows any error so the caller can show a contextual failure toast.
async function withDownloadBusy(btn, fn) {
  btn.disabled = true;
  btn.style.opacity = '0.6';
  try {
    await fn();
  } finally {
    btn.disabled = false;
    btn.style.opacity = '';
  }
}

async function downloadRawCsv() {
  const btn = event.currentTarget;
  try {
    await withDownloadBusy(btn, async () => {
      const records = await attGet();
      const content = csvStringify(records);
      const d = new Date();
      const ts = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
      triggerDownload('attendance_records_' + ts + '.csv', content);
      showToast('সফলভাবে ' + bd(records.length) + ' টি এটেন্ডেন্স রেকর্ড ডাউনলোড হয়েছে', 'success');
    });
  } catch(e) {
    showToast('এটেন্ডেন্স রেকর্ড ডাউনলোড ব্যর্থ: ' + e.message, 'error');
  }
}

async function downloadSummaryCsv() {
  const btn = event.currentTarget;
  try {
    await withDownloadBusy(btn, async () => {
      const records  = await attGet();
      const monthSel = document.getElementById('summaryMonthSel');
      const filter   = monthSel ? monthSel.value : '';   // "YYYY-MM" or "" for all

      // Group: key = employeeId + "|" + "YYYY-MM"
      // First pass: collect all records per employee-month
      const groups = {};
      for (const r of records) {
        if (!r.date) continue;
        const monthKey = r.date.slice(0, 7);  // "YYYY-MM"
        if (filter && monthKey !== filter) continue;
        const key = (r.employeeId || '') + '|' + monthKey;
        if (!groups[key]) {
          groups[key] = {
            employeeId:  r.employeeId || '',
            name:        r.name || '',
            designation: r.designation || '',
            monthKey,
            // date → { completed: bool, open: bool }
            dateMap:     {},
            sessions:    0,
            totalMins:   0,
          };
        }
        const g = groups[key];
        if (!g.dateMap[r.date]) g.dateMap[r.date] = { completed: false, open: false };

        if (r.checkIn && r.checkOut) {
          // Completed session
          g.dateMap[r.date].completed = true;
          g.sessions++;
          let mins = 0;
          if (r.checkInTimestamp && r.checkOutTimestamp) {
            const ms = new Date(r.checkOutTimestamp) - new Date(r.checkInTimestamp);
            if (ms > 0) mins = ms / 60000;
          } else {
            const [ih, im] = r.checkIn.split(':').map(Number);
            const [oh, om] = r.checkOut.split(':').map(Number);
            if (!isNaN(ih) && !isNaN(oh)) {
              mins = (oh * 60 + om) - (ih * 60 + im);
              if (mins < 0) mins += 24 * 60;
            }
          }
          g.totalMins += mins;
        } else if (r.checkIn && !r.checkOut) {
          // Open / incomplete session
          g.dateMap[r.date].open = true;
        }
      }

      // Build CSV rows sorted by month, then name
      const rows = Object.values(groups).sort((a, b) =>
        a.monthKey.localeCompare(b.monthKey) || a.name.localeCompare(b.name)
      );

      const header = ['Month', 'Employee ID', 'Name', 'Designation',
                      'Days Present', 'Incomplete Days', 'Incomplete Dates',
                      'Total Sessions', 'Total Duty Hours', 'Avg Daily Hours'];
      const lines = [header.join(',')];
      for (const g of rows) {
        // Days present = dates with at least one completed session
        const presentDates    = Object.entries(g.dateMap).filter(([, v]) => v.completed).map(([d]) => d).sort();
        // Incomplete = dates where ALL records are open (no completed session on that date)
        const incompleteDates = Object.entries(g.dateMap).filter(([, v]) => v.open && !v.completed).map(([d]) => d).sort();
        const days      = presentDates.length;
        const totalH    = (g.totalMins / 60).toFixed(2);
        const avgH      = days > 0 ? (g.totalMins / 60 / days).toFixed(2) : '0.00';
        const [y, m]    = g.monthKey.split('-');
        const monthLabel = MONTH_FULL_BN[+m - 1] + ' ' + bd(y);
        lines.push([
          csvEscape(monthLabel),
          csvEscape(g.employeeId),
          csvEscape(g.name),
          csvEscape(g.designation),
          days,
          incompleteDates.length,
          csvEscape(incompleteDates.join(', ')),
          g.sessions,
          totalH,
          avgH
        ].join(','));
      }

      const content = lines.join('\r\n');
      const suffix  = filter ? '_' + filter : '_all';
      triggerDownload('attendance_summary' + suffix + '.csv', content);
      showToast(bd(rows.length) + ' জন-মাস সারি সম্বলিত সারাংশ তৈরি হয়েছে', 'success');
    });
  } catch(e) {
    showToast('সারাংশ তৈরি ব্যর্থ: ' + e.message, 'error');
  }
}

// Populate the month selector from all records
async function populateSummaryMonths() {
  try {
    const records = await attGet();
    const months  = [...new Set(records.map(r => r.date ? r.date.slice(0,7) : '').filter(Boolean))].sort().reverse();
    const sel = document.getElementById('summaryMonthSel');
    if (!sel) return;
    sel.innerHTML = '<option value="">সব মাস</option>' +
      months.map(m => {
        const [y, mo] = m.split('-');
        return `<option value="${m}">${MONTH_FULL_BN[+mo - 1]} ${bd(y)}</option>`;
      }).join('');
    // Default to current month (local time)
    const cd = new Date();
    const cur = cd.getFullYear() + '-' + pad(cd.getMonth() + 1);
    if (months.includes(cur)) sel.value = cur;
  } catch { /* no records yet */ }
}

// ══════════════════════════════════════════════════════════════════════════════
// ── UUID GENERATION ───────────────────────────────────────────────────────────
// Deterministic UUID v5-style derived from employee data using SHA-1 via SubtleCrypto.
// Falls back to a seeded pseudo-random UUID if SubtleCrypto is unavailable.

// Cache: employeeId → { uuid, printedAt }
const _empUuidCache = {};

async function getEmpUuid(emp) {
  if (_empUuidCache[emp.id]) return _empUuidCache[emp.id];
  const seed = [emp.id, emp.name, emp.designation || ''].join('|');
  let uuid;
  try {
    const enc  = new TextEncoder().encode(seed);
    const hash = await crypto.subtle.digest('SHA-1', enc);
    const b    = new Uint8Array(hash);
    // Format as UUID v5 layout from first 16 bytes of SHA-1
    b[6] = (b[6] & 0x0f) | 0x50;  // version 5
    b[8] = (b[8] & 0x3f) | 0x80;  // variant RFC 4122
    const h = Array.from(b).map(x => x.toString(16).padStart(2,'0')).join('');
    uuid = `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20,32)}`;
  } catch {
    // Fallback: seeded LCG pseudo-random (deterministic for same seed)
    let s = 0;
    for (let i = 0; i < seed.length; i++) s = Math.imul(31, s) + seed.charCodeAt(i) | 0;
    const rand = (n) => { s = Math.imul(1664525, s) + 1013904223 | 0; return ((s >>> 0) % n).toString(16).padStart(n > 65535 ? 8 : 4, '0'); };
    uuid = `${rand(0x100000000)}-${rand(0x10000)}-5${rand(0x1000)}-${(0x8000 | (Math.abs(s) & 0x3fff)).toString(16)}-${rand(0x100000000)}${rand(0x10000)}`;
  }
  _empUuidCache[emp.id] = uuid;
  return uuid;
}

// Build a reverse-lookup map: uuid → employeeId
// Called once after employees load and when needed
async function buildUuidLookup() {
  _uuidToEmpId = {};
  await Promise.all(employees.map(async emp => {
    const uuid = await getEmpUuid(emp);
    _uuidToEmpId[uuid] = emp.id;
  }));
}
let _uuidToEmpId  = {};
let serverShiftDate = null;

function formatPrintedOn(d) {
  return `Printed on ${DAY_ABBR[d.getDay()]}, ${d.getDate()} ${MONTH_ABBR[d.getMonth()]} ${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// ── QR PRINT PAGE ─────────────────────────────────────────────────────────────
async function openQrPrint() {
  // Require admin PIN — if already in admin mode the PIN is already verified
  if (!isAdmin && !verifiedPin) {
    openPinOverlay('qr');
    return;
  }
  await buildUuidLookup();
  _selectedEmpIds.clear();
  document.getElementById('qrPrintOverlay').classList.add('open');
  buildQrGrid('');
}

function closeQrPrint() {
  document.getElementById('qrPrintOverlay').classList.remove('open');
  _selectedEmpIds.clear();
  // Opened from inside admin mode → keep the session; otherwise it was a one-off
  // privileged sheet and must revoke the temporary PIN session.
  if (!isAdmin) revokeAdminSession();
}

function filterQrGrid() {
  buildQrGrid(document.getElementById('qrSearchInput').value.trim().toLowerCase());
}

// Selected employee IDs — persists across search/filter
const _selectedEmpIds = new Set();

async function buildQrGrid(query) {
  const grid = document.getElementById('qrGrid');
  const list = query
    ? employees.filter(e => e.name.toLowerCase().includes(query) || (e.designation||'').toLowerCase().includes(query))
    : employees;
  grid.innerHTML = '';
  if (!list.length) {
    grid.innerHTML = '<div class="emp-list-empty">কোনো কর্মচারী পাওয়া যায়নি</div>';
    _updateSelectionUI();
    return;
  }
  for (const emp of list) {
    const init    = initials(emp.name);
    const checked = _selectedEmpIds.has(emp.id);
    const item    = document.createElement('div');
    item.className = 'emp-list-item' + (checked ? ' selected' : '');
    item.dataset.empId = emp.id;
    item.innerHTML = `
      <div class="emp-list-avatar">${init}</div>
      <div class="emp-list-info">
        <div class="emp-list-name">${esc(emp.name)}</div>
        ${emp.designation ? `<div class="emp-list-desig">${esc(emp.designation)}</div>` : ''}
        <div class="emp-list-id">${esc(emp.id)}</div>
      </div>
      <div class="emp-list-arrow">›</div>`;
    // Arrow opens the ID card modal; clicking anywhere else on the row toggles selection
    item.querySelector('.emp-list-arrow').addEventListener('click', e => { e.stopPropagation(); openIdCard(emp); });
    item.addEventListener('click', () => _toggleEmpSelection(emp.id, item));
    grid.appendChild(item);
  }
  _updateSelectionUI();
}

function _toggleEmpSelection(empId, itemEl) {
  const on = !_selectedEmpIds.has(empId);
  if (on) _selectedEmpIds.add(empId); else _selectedEmpIds.delete(empId);
  itemEl.classList.toggle('selected', on);
  _updateSelectionUI();
}

function toggleSelectAll(checked) {
  if (_updatingUI) return;
  document.querySelectorAll('#qrGrid .emp-list-item').forEach(item => {
    const id = item.dataset.empId;
    if (checked) _selectedEmpIds.add(id); else _selectedEmpIds.delete(id);
    item.classList.toggle('selected', checked);
  });
  _updateSelectionUI();
}

let _updatingUI = false;

function _updateSelectionUI() {
  const n        = _selectedEmpIds.size;
  const badge    = document.getElementById('selCountBadge');
  const printBtn = document.getElementById('btnPrintSelected');
  const chkAll   = document.getElementById('chkSelectAll');

  if (n > 0) {
    badge.textContent = n; badge.style.display = '';
    printBtn.textContent = `🖨️ নির্বাচিত প্রিন্ট (${bd(n)})`; printBtn.style.display = '';
  } else {
    badge.style.display = 'none'; printBtn.style.display = 'none';
  }

  if (!chkAll) return;
  const visible  = [...document.querySelectorAll('#qrGrid .emp-list-item')].map(el => el.dataset.empId);
  const selCount = visible.filter(id => _selectedEmpIds.has(id)).length;
  // Set checkbox state without triggering onchange — writing .checked or
  // .indeterminate fires the change event in some browsers, which calls
  // toggleSelectAll(false) and clears the entire selection set.
  _updatingUI = true;
  chkAll.checked       = visible.length > 0 && selCount === visible.length;
  chkAll.indeterminate = selCount > 0 && selCount < visible.length;
  _updatingUI = false;
}

// ── ID CARD ───────────────────────────────────────────────────────────────────
let _idCardEmpId     = null;
let _idCardPrintedAt = null;

async function openIdCard(emp) {
  _idCardEmpId     = emp.id;
  _idCardPrintedAt = new Date().toISOString();
  const uuid    = await getEmpUuid(emp);
  const payload = uuid + '|' + _idCardPrintedAt;
  const init    = initials(emp.name);

  document.getElementById('idCardAvatar').textContent = init;
  document.getElementById('idCardName').textContent   = emp.name;
  document.getElementById('idCardDesig').textContent  = emp.designation || '';
  document.getElementById('idCardEmpId').textContent  = emp.id;
  document.getElementById('idCardStamp').textContent  = formatPrintedOn(new Date(_idCardPrintedAt));

  const qrWrap = document.getElementById('idCardQr');
  qrWrap.innerHTML = '';
  try {
    new QRCode(qrWrap, { text: payload, width: 180, height: 180,
      colorDark: '#212529', colorLight: '#ffffff', correctLevel: QRCode.CorrectLevel.M });
  } catch(e) { qrWrap.textContent = payload; }

  document.getElementById('idCardOverlay').classList.add('open');
}

function closeIdCard() {
  document.getElementById('idCardOverlay').classList.remove('open');
  document.getElementById('slotPicker').classList.remove('open');
  document.getElementById('btnIdPrint').textContent = '🖨️ আইডি কার্ড প্রিন্ট';
  document.querySelectorAll('.slot-cell').forEach(c => c.classList.remove('selected'));
  _selectedSlot    = -1;
  _idCardEmpId     = null;
  _idCardPrintedAt = null;
}

function handleIdCardOverlayClick(e) {
  if (e.target === document.getElementById('idCardOverlay')) closeIdCard();
}

// ── ID CARD PRINT ─────────────────────────────────────────────────────────────
let _selectedSlot = -1;   // 0=TL 1=TR 2=BL 3=BR

// Shared print CSS — used by both single-card and multi-select print
const PRINT_CSS = `
    html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    @page { size: A4 portrait; margin: 0; }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Hind Siliguri', Arial, sans-serif; background: white; }
    .page { display: grid; grid-template-columns: 1fr 1fr; grid-template-rows: 1fr 1fr;
            gap: 6mm; width: 210mm; height: 297mm; padding: 10mm; page-break-after: always; }
    .page:last-child { page-break-after: avoid; }
    .id-card { border: 1.5px dashed #adb5bd; border-radius: 4mm; overflow: hidden; display: flex; flex-direction: column; }
    .id-card.empty { border: none !important; background: transparent !important; }
    .card-hdr { background: #212529; padding: 3.5mm 4mm; flex-shrink: 0; }
    .ttl { font-size: 8pt; font-weight: 800; color: white; letter-spacing: 1.2px; text-align: center; text-transform: uppercase; }
    .top-sec { display: flex; gap: 3.5mm; padding: 4mm 4.5mm; flex-shrink: 0; }
    .photo-box { width: 22mm; height: 28mm; border: 1px solid #adb5bd; border-radius: 2mm; flex-shrink: 0;
                 display: flex; align-items: center; justify-content: center; background: #f8f9fa; }
    .photo-label { font-size: 6pt; font-weight: 700; color: #adb5bd; letter-spacing: 1.2px; text-transform: uppercase; }
    .name-block { flex: 1; display: flex; flex-direction: column; justify-content: flex-start; gap: 1.2mm; min-width: 0; padding-top: 0.5mm; }
    .printed-name  { font-size: 10pt; font-weight: 800; color: #212529; line-height: 1.2; word-break: break-word; }
    .printed-desig { font-size: 7pt; color: #F5821F; font-weight: 700; margin-bottom: 0.5mm; }
    .printed-id    { font-size: 6pt; color: #adb5bd; font-weight: 700; font-family: monospace; margin-bottom: 1.5mm; }
    .divider { height: 0.3mm; background: #dee2e6; margin: 0 4mm; flex-shrink: 0; }
    .fields-sec { padding: 3mm 4.5mm; display: flex; flex-direction: column; justify-content: space-between; flex: 1; }
    .field-row { display: flex; align-items: flex-end; gap: 2mm; }
    .flabel { font-size: 6pt; font-weight: 800; color: #495057; text-transform: uppercase;
              letter-spacing: 0.4px; white-space: nowrap; flex-shrink: 0; min-width: 14mm; }
    .fline { flex: 1; border-bottom: 0.8px solid #212529; height: 4.5mm; display: block; }
    .fline.short { max-width: 13mm; }
    .fval { flex: 1; font-size: 6.5pt; font-weight: 700; color: #F5821F; line-height: 1.4;
            padding-bottom: 0.5mm; white-space: normal; overflow: visible; word-break: break-word; }
    .field-row:has(.fval) { align-items: flex-start; }
    .bottom-sec { display: flex; align-items: flex-end; padding: 3mm 4.5mm 4mm; gap: 3mm; flex-shrink: 0; }
    .qr-col { display: flex; flex-direction: row; align-items: center; flex-shrink: 0; gap: 1.5mm; }
    .qr-wrap { background: #fff4ec; border-radius: 2.5mm; padding: 2mm; display: inline-flex; }
    .qr-wrap img { display: block; border-radius: 1.5mm; }
    .stamp { font-size: 4.5pt; color: #adb5bd; font-weight: 600; white-space: nowrap;
             writing-mode: vertical-rl; transform: rotate(180deg); letter-spacing: 0.3px; line-height: 1; }
    .sig-col { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: flex-end; padding-bottom: 1mm; }
    .sig-line { width: 100%; border-bottom: 0.8px solid #212529; margin-bottom: 2mm; height: 10mm; }
    .sig-label { font-size: 5.5pt; font-weight: 800; color: #495057; text-transform: uppercase; letter-spacing: 0.5px; text-align: center; }`;

// Build one card's HTML from an employee + QR image source
function buildCardHtml(emp, qrSrc, printedOn) {
  const allowed = (emp.locationIds && emp.locationIds.length)
    ? locations.filter(l => emp.locationIds.includes(l.id)).map(l => l.name).join(', ')
    : locations.map(l => l.name).join(', ');
  return `
    <div class="id-card">
      <div class="card-hdr"><div class="ttl">EMPLOYEE ID CARD</div></div>
      <div class="top-sec">
        <div class="photo-box"><span class="photo-label">PHOTO</span></div>
        <div class="name-block">
          <div class="printed-name">${esc(emp.name)}</div>
          ${emp.designation ? `<div class="printed-desig">${esc(emp.designation)}</div>` : ''}
          <div class="printed-id">${esc(emp.id)}</div>
          <div class="field-row"><span class="flabel">Dept</span><span class="fline"></span></div>
          <div class="field-row"><span class="flabel">DOJ</span><span class="fline"></span></div>
        </div>
      </div>
      <div class="divider"></div>
      <div class="fields-sec">
        <div class="field-row"><span class="flabel">Blood Gr</span><span class="fline short"></span></div>
        <div class="field-row"><span class="flabel">Mobile</span><span class="fline"></span></div>
        <div class="field-row"><span class="flabel">Emergency</span><span class="fline"></span></div>
        <div class="field-row"><span class="flabel">Issue Date</span><span class="fline"></span></div>
        <div class="field-row"><span class="flabel">Valid Until</span><span class="fline"></span></div>
        <div class="field-row"><span class="flabel">Allowed</span><span class="fval">${esc(allowed)}</span></div>
      </div>
      <div class="divider"></div>
      <div class="bottom-sec">
        <div class="qr-col">
          <div class="stamp">${printedOn}</div>
          <div class="qr-wrap">${qrSrc ? `<img src="${qrSrc}" width="78" height="78">` : `<p style="font-size:7px;font-family:monospace">${esc(emp.id)}</p>`}</div>
        </div>
        <div class="sig-col">
          <div class="sig-line"></div>
          <div class="sig-label">Authorized Signature</div>
        </div>
      </div>
    </div>`;
}

// Wrap card HTML in a full print document and send to the hidden iframe
function sendToPrinter(pagesHtml) {
  const printHtml = `<!DOCTYPE html><html><head><title></title>
  <link href="https://fonts.googleapis.com/css2?family=Hind+Siliguri:wght@400;600;700&display=swap" rel="stylesheet">
  <style>${PRINT_CSS}</style></head><body>${pagesHtml}</body></html>`;
  let iframe = document.getElementById('_printFrame');
  if (!iframe) {
    iframe = document.createElement('iframe');
    iframe.id = '_printFrame';
    iframe.style.cssText = 'position:fixed;top:-9999px;left:-9999px;width:0;height:0;border:0';
    document.body.appendChild(iframe);
  }
  const iDoc = iframe.contentDocument || iframe.contentWindow.document;
  iDoc.open(); iDoc.write(printHtml); iDoc.close();
  iframe.contentWindow.onload = () => {
    setTimeout(() => { iframe.contentWindow.focus(); iframe.contentWindow.print(); }, 400);
  };
}

// Generate a QR data-URI for an employee (uses cached UUID + fresh timestamp)
function _qrDataUri(emp) {
  const el = document.createElement('div');
  new QRCode(el, {
    text: `${_empUuidCache[emp.id] || emp.id}|${new Date().toISOString()}`,
    width: 156, height: 156, colorDark: '#212529', colorLight: '#ffffff',
    correctLevel: QRCode.CorrectLevel.M,
  });
  const canvas = el.querySelector('canvas');
  return canvas ? canvas.toDataURL('image/png') : '';
}

function toggleSlotPicker() {
  const picker = document.getElementById('slotPicker');
  const isOpen = picker.classList.toggle('open');
  document.getElementById('btnIdPrint').textContent = isOpen ? '✕ বাতিল' : '🖨️ আইডি কার্ড প্রিন্ট';
  if (!isOpen) {
    _selectedSlot = -1;
    document.querySelectorAll('.slot-cell').forEach(c => c.classList.remove('selected'));
  }
}

function selectSlot(slot) {
  _selectedSlot = slot;
  document.querySelectorAll('.slot-cell').forEach(c => {
    c.classList.toggle('selected', +c.dataset.slot === slot);
  });
  setTimeout(() => printIdCard(), 260);   // brief delay so the highlight shows
}

// Print the currently open ID card into the chosen A4 slot
function printIdCard() {
  if (!_idCardEmpId) return;
  const emp = employees.find(e => e.id === _idCardEmpId);
  if (!emp) return;

  document.getElementById('slotPicker').classList.remove('open');
  document.getElementById('btnIdPrint').textContent = '🖨️ আইডি কার্ড প্রিন্ট';
  document.querySelectorAll('.slot-cell').forEach(c => c.classList.remove('selected'));

  const imgEl = document.getElementById('idCardQr').querySelector('canvas, img');
  let imgSrc  = '';
  if (imgEl && imgEl.tagName === 'CANVAS')   imgSrc = imgEl.toDataURL('image/png');
  else if (imgEl && imgEl.tagName === 'IMG') imgSrc = imgEl.src;

  const slot      = _selectedSlot >= 0 ? _selectedSlot : 0;
  const printedOn = formatPrintedOn(new Date(_idCardPrintedAt || Date.now()));
  const cardHtml  = buildCardHtml(emp, imgSrc, printedOn);
  const empty     = '<div class="id-card empty"></div>';
  const slots     = [0,1,2,3].map(i => i === slot ? cardHtml : empty);

  sendToPrinter(`<div class="page">${slots.join('')}</div>`);
  _selectedSlot = -1;
}

// Print all selected employees, 4 per A4 page, sorted A→Z
async function printSelectedIdCards() {
  if (!_selectedEmpIds.size) return;
  const btn = document.getElementById('btnPrintSelected');
  const orig = btn.textContent;
  btn.disabled = true; btn.textContent = '⏳ তৈরি হচ্ছে…';

  const printedOn = formatPrintedOn(new Date());
  const sorted    = employees.filter(e => _selectedEmpIds.has(e.id)).sort((a,b) => a.name.localeCompare(b.name));
  const cards     = sorted.map(emp => buildCardHtml(emp, _qrDataUri(emp), printedOn));

  const empty = '<div class="id-card empty"></div>';
  const pages = [];
  for (let i = 0; i < cards.length; i += 4) {
    const group = cards.slice(i, i + 4);
    while (group.length < 4) group.push(empty);
    pages.push(`<div class="page">${group.join('')}</div>`);
  }

  sendToPrinter(pages.join('\n'));
  btn.disabled = false; btn.textContent = orig;
}

// Clean up both geolocation watches on page unload
window.addEventListener('pagehide', () => {
  if (watchId      !== null) navigator.geolocation.clearWatch(watchId);
  if (adminWatchId !== null) navigator.geolocation.clearWatch(adminWatchId);
});
