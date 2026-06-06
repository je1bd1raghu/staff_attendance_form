const WORKER_URL  = 'https://attendance-proxy.je1-bd1-raghu.workers.dev/';
// All Supabase credentials live in Cloudflare Worker secrets.
// The client never holds a Supabase key or URL directly.

let employees   = [];
let locations   = [];
let todayRecs   = [];
let currentPos  = null;
let locVerified = false;
let locName     = '';
let watchId     = null;
let deviceId    = null;
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

async function initApp() {
  setProgress(10);
  setLoadText('Loading employees…');
  await getDeviceId();
  setProgress(40);
  const ok = await fetchConfig();
  if (!ok) { hideLoading(); return; }

  setLoadText('Loading today\'s records…');
  setProgress(75);
  await fetchTodayRecords();

  setProgress(100);
  setLoadText('Ready!');
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
  const DAYS   = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  document.getElementById('dispDate').textContent = now.getDate() + ' ' + MONTHS[now.getMonth()] + ' ' + now.getFullYear();
  document.getElementById('dispTime').textContent = pad(now.getHours()) + ':' + pad(now.getMinutes()) + ':' + pad(now.getSeconds());
  document.getElementById('dispDay').textContent  = DAYS[now.getDay()].slice(0,3);
  document.getElementById('headerDate').textContent = DAYS[now.getDay()] + ', ' + MONTHS[now.getMonth()] + ' ' + now.getDate() + ', ' + now.getFullYear();
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
// Employee checkout sends deviceId for ownership verification;
// admin checkout routes to /attendance/admin/:id with the PIN.
function attUpdate(id, patch) {
  return isAdmin && verifiedPin
    ? _sendJson(WORKER_URL + 'attendance/admin/' + id, 'PATCH', { ...patch, adminPin: verifiedPin })
    : _sendJson(WORKER_URL + 'attendance/' + id, 'PATCH', { ...patch, deviceId });
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
    employees  = data.employees || [];
    locations  = data.locations  || [];
    populateEmployees();
    populateAdminLocs();
    await buildUuidLookup();   // pre-compute UUID→employeeId map for scanner
    return true;
  } catch(e) { showToast('Config error: ' + e.message, 'error'); return false; }
}

async function fetchTodayRecords() {
  try {
    const records = await attGet();
    todayRecs     = records.filter(r => r.date === shiftDateStr() && !isBeforeShiftCutoff(r));
    renderRecords();
    renderAdminRecords();
  } catch { todayRecs = []; renderRecords(); renderAdminRecords(); }
}

// Returns true if a record's check-in timestamp falls before today's shift cutoff.
// Records between midnight and SHIFT_CUTOFF_HOUR on the current calendar day are
// considered part of the *previous* shift and should not appear in today's list.
function isBeforeShiftCutoff(rec) {
  if (!rec.checkInTimestamp) return false;
  const ts      = new Date(rec.checkInTimestamp);
  const today   = new Date();
  // Only filter records that are on today's *calendar* date and before cutoff hour
  if (ts.getFullYear() === today.getFullYear() &&
      ts.getMonth()    === today.getMonth()    &&
      ts.getDate()     === today.getDate()     &&
      ts.getHours()    < SHIFT_CUTOFF_HOUR) {
    return true;
  }
  return false;
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

function esc(s) { return String(s).replace(/[<>&"]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c])); }
function hi(s, q) {
  if (!q) return esc(s);
  try {
    var safe = q.replace(/[-\[\]{}()*+?.,\\^$|#]/g, '\\$&');
    return esc(s).replace(new RegExp(safe, 'gi'), function(m){ return '<mark>'+m+'</mark>'; });
  } catch(ex) { return esc(s); }
}

function renderDropdown(query) {
  const dd = document.getElementById('comboDropdown');
  const q  = query.trim().toLowerCase();
  const list = q
    ? employees.filter(e => e.name.toLowerCase().includes(q) || (e.designation||'').toLowerCase().includes(q))
    : employees;
  if (!list.length) { dd.innerHTML = '<div class="combo-empty">No employees found</div>'; return; }
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
  ensureWatch();
  if (currentPos) checkProximity();
}

// ── LOCATION ──────────────────────────────────────────────────────────────────
function ensureWatch() {
  if (watchId !== null) return;
  if (!navigator.geolocation) { setLoc('failed', '❌', 'GPS not supported', 'Use Chrome or Safari'); return; }
  setLoc('checking', '📡', 'Getting your location…', 'Please hold still');
  watchId = navigator.geolocation.watchPosition(onPos, onPosErr, { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 });
}
function onPos(pos) {
  currentPos = { lat: pos.coords.latitude, lng: pos.coords.longitude, acc: Math.round(pos.coords.accuracy) };
  checkProximity();
}
function onPosErr(e) {
  const msgs = { 1: 'Location permission denied — please allow GPS', 2: 'Location unavailable', 3: 'Location timed out' };
  setLoc('failed', '❌', msgs[e.code] || 'Location error', 'Enable GPS and try again');
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
    setLoc('failed', '⚠️', 'No locations assigned', 'Contact admin to assign your duty area');
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
    setLoc('verified', '✅', best.name, 'You are ' + dist + 'm away — location verified ✓');
    updateBtns();
  } else {
    locVerified = false;
    const names = allowed.map(l => l.name).join(', ');
    setLoc('failed', '🚫', 'Outside your duty area', 'Nearest: ' + best.name + ' (' + dist + 'm away, need within ' + tol + 'm). Allowed: ' + names);
    disableBtns();
  }
}
function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371000, toR = Math.PI / 180;
  const dLat = (lat2 - lat1) * toR, dLng = (lng2 - lng1) * toR;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*toR) * Math.cos(lat2*toR) * Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}
function setLoc(cls, icon, title, sub) {
  document.getElementById('locStatus').className  = 'loc-status ' + cls;
  document.getElementById('locIcon').textContent  = icon;
  document.getElementById('locTitle').textContent = title;
  document.getElementById('locSub').textContent   = sub;
}
function resetLoc() {
  locVerified = false; locName = '';
  setLoc('idle', '📍', 'Location not checked', 'Select your name to begin');
}

// ── BUTTONS ───────────────────────────────────────────────────────────────────
const MAX_CHECKINS_PER_DAY = 2;

function updateBtns() {
  const id  = document.getElementById('empSelect').value;
  const btnIn  = document.getElementById('btnIn');
  const btnOut = document.getElementById('btnOut');
  if (!locVerified || !id) { disableBtns(); return; }
  // All records for this employee today, sorted oldest-first
  const empRecs = todayRecs
    .filter(r => r.employeeId === id && r.date === shiftDateStr())
    .sort((a, b) => (a.checkInTimestamp || '').localeCompare(b.checkInTimestamp || ''));
  const lastRec       = empRecs.length ? empRecs[empRecs.length - 1] : null;
  const completedSess = empRecs.filter(r => r.checkIn && r.checkOut).length;
  const hasOpenRec    = lastRec && lastRec.checkIn && !lastRec.checkOut;

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
    btnIn.title  = 'Maximum ' + MAX_CHECKINS_PER_DAY + ' check-ins per day reached';
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
  if (!locVerified) { showToast('Location not verified', 'error'); return; }
  const emp = getEmp(); if (!emp) return;
  const now = new Date();
  // date and deviceId are re-set server-side; we send them as hints only
  const rec = { employeeId: emp.id, name: emp.name, designation: emp.designation || '',
    date: shiftDateStr(), checkIn: timeStr(now), checkInTimestamp: now.toISOString(),
    checkOut: null, checkOutTimestamp: null,
    location: locName, lat: currentPos.lat, lng: currentPos.lng, deviceId };
  await withBtnLoad('btnIn', async () => {
    const inserted = await appendRecord(rec);
    todayRecs.push({ ...rec, id: inserted.id });  // store server-assigned UUID
    renderRecords(); updateBtns();
    showToast('✅ Checked IN at ' + rec.checkIn, 'success');
  });
}
async function doCheckOut() {
  if (!locVerified) { showToast('Location not verified', 'error'); return; }
  const emp = getEmp(); if (!emp) return;
  const rec = todayRecs.find(r => r.employeeId === emp.id && r.date === shiftDateStr() && !r.checkOut);
  if (!rec) { showToast('No active check-in found', 'error'); return; }
  if (!rec.id) { showToast('Record id missing — please refresh the page', 'error'); return; }
  await withBtnLoad('btnOut', async () => {
    const now     = new Date();
    const coTime  = timeStr(now);
    const updated = await attUpdate(rec.id, { checkOut: coTime });
    rec.checkOut = updated.checkOut || coTime;
    rec.checkOutTimestamp = updated.checkOutTimestamp;
    renderRecords(); updateBtns();
    showToast('🚪 Checked OUT at ' + rec.checkOut, 'success');
  });
}

async function withBtnLoad(id, fn) {
  const btn = document.getElementById(id);
  const orig = btn.innerHTML;
  btn.innerHTML = '<span class="spinner"></span>';
  btn.disabled = true;
  try { await fn(); } catch(e) { showToast('Error: ' + e.message, 'error'); }
  btn.innerHTML = orig;
}

// ── RECORD OPS ────────────────────────────────────────────────────────────────
// Client checks below are UX fast-fails — all rules are re-enforced server-side
// in the worker and cannot be bypassed by a malicious or modified client.
async function appendRecord(rec) {
  const records = await attGet().catch(() => []);
  if (rec.deviceId && rec.deviceId !== 'ADMIN') {
    const openDevRec = records.find(r => r.date === rec.date && r.deviceId === rec.deviceId && r.checkIn && !r.checkOut && r.employeeId !== rec.employeeId);
    if (openDevRec) throw new Error('Another employee (' + openDevRec.name + ') is currently checked in from this device');
  }
  const openRec = records.find(r => r.employeeId === rec.employeeId && r.date === rec.date && r.checkIn && !r.checkOut);
  if (openRec) throw new Error(rec.name + ' is already checked in — please check out first');
  const completedToday = records.filter(r => r.employeeId === rec.employeeId && r.date === rec.date && r.checkIn && r.checkOut).length;
  if (completedToday >= MAX_CHECKINS_PER_DAY) throw new Error(rec.name + ' has reached the maximum of ' + MAX_CHECKINS_PER_DAY + ' check-ins for today');
  return attInsert(rec);   // returns inserted row with server-assigned `id`
}

// ── RENDER (employee view) ────────────────────────────────────────────────────
function renderRecords() {
  const el = document.getElementById('recordsList');
  if (!todayRecs.length) { el.innerHTML = '<div class="empty-state"><div class="e-icon">🗒️</div>No records yet today</div>'; return; }
  const sorted = [...todayRecs].sort((a,b) => (a.checkInTimestamp||'').localeCompare(b.checkInTimestamp||''));
  el.innerHTML = sorted.map(r => recordHTML(r)).join('');
}

function renderAdminRecords() {
  const el = document.getElementById('adminRecordsList');
  if (!el) return;
  if (!todayRecs.length) { el.innerHTML = '<div class="empty-state"><div class="e-icon">🗒️</div>No records yet today</div>'; return; }
  const sorted = [...todayRecs].sort((a,b) => (a.checkInTimestamp||'').localeCompare(b.checkInTimestamp||''));
  el.innerHTML = sorted.map(r => recordHTML(r)).join('');
}

function recordHTML(r) {
  const init  = r.name.split(' ').map(w => w[0]).slice(0,2).join('').toUpperCase();
  const desig = r.designation ? `<div class="record-desig">🏷️ ${r.designation}</div>` : '';
  const inC   = r.checkIn  ? `<span class="time-chip chip-in">▲ ${r.checkIn}</span>` : '';
  const outC  = r.checkOut ? `<span class="time-chip chip-out">▼ ${r.checkOut}</span>` : (r.checkIn ? '<span class="time-chip chip-pending">⏳ Active</span>' : '');
  let adminC = '';
  if (r.deviceId && r.deviceId.startsWith('ADMIN')) {
    // deviceId is either "ADMIN" (legacy) or "ADMIN|QR Printed on <datetime>"
    const parts    = r.deviceId.split('|');
    const printLabel = parts[1] || '';   // e.g. "QR Printed on Mon, 2 Jun 2025 14:32:07"
    const tooltip    = printLabel ? ` title="${printLabel}"` : '';
    adminC = `<span class="time-chip chip-admin"${tooltip}>🛡️ Admin${printLabel ? ' · 🖨️' : ''}</span>`;
    if (printLabel) adminC += `<span class="time-chip chip-admin" style="font-size:9px;opacity:0.85">${printLabel.replace('QR Printed on ','')}</span>`;
  }
  return `<div class="record-item"><div class="record-avatar">${init}</div><div class="record-info"><div class="record-name">${r.name}</div>${desig}<div class="record-loc">📍 ${r.location||'—'}</div></div><div class="record-times">${inC}${outC}${adminC}</div></div>`;
}

// ── HELPERS ───────────────────────────────────────────────────────────────────
function getEmp()    { const id = document.getElementById('empSelect').value; return employees.find(e => e.id === id) || null; }

// ── SHIFT DATE ────────────────────────────────────────────────────────────────
// A "workday" runs from ~sunrise to next sunrise. Any time between midnight and
// SHIFT_CUTOFF_HOUR (04:00) is still considered part of the *previous* calendar
// day's shift — so overnight check-outs are matched to their check-in date.
const SHIFT_CUTOFF_HOUR = 4;   // 04:00 — adjust if your site has earlier starts
function shiftDateStr() {
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
  toastTmr = setTimeout(() => el.classList.remove('show'), 3400);
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
    document.getElementById('pinTitle').textContent = 'Print QR Codes';
    document.getElementById('pinSub').textContent   = 'Enter admin PIN to access QR printing';
  } else if (purpose === 'download') {
    document.getElementById('pinIcon').textContent  = '📥';
    document.getElementById('pinTitle').textContent = 'Download Records';
    document.getElementById('pinSub').textContent   = 'Enter admin PIN to download attendance data';
  } else {
    document.getElementById('pinIcon').textContent  = '🔐';
    document.getElementById('pinTitle').textContent = 'Admin Access';
    document.getElementById('pinSub').textContent   = 'Enter your PIN to continue';
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
  const len = Math.max(pinBuffer.length, 1);  // always show at least 1 dot placeholder
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

function submitPin() {
  const pin = pinBuffer;
  // Disable keypad while verifying
  document.getElementById('pinKeypad').style.pointerEvents = 'none';
  document.getElementById('pinSubmit').disabled = true;
  document.getElementById('pinSubmit').textContent = '…';
  fetch(WORKER_URL + 'verify-pin', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ adminPin: pin })
  })
  .then(r => r.json().then(data => ({ ok: r.ok, data })))
  .then(({ ok, data }) => {
    document.getElementById('pinKeypad').style.pointerEvents = '';
    document.getElementById('pinSubmit').textContent = '✓ Confirm PIN';
    if (ok) {
      verifiedPin = pin;
      closePinOverlay();
      if (pinPurpose === 'qr') {
        startAdminTimer();
        _openQrPrintDirect();
      } else if (pinPurpose === 'download') {
        startAdminTimer();
        _openDownloadSheetDirect();
      } else {
        enterAdmin();   // enterAdmin() calls startAdminTimer() itself
      }
    } else {
      renderPinDots(true);
      setTimeout(() => { pinBuffer = ''; renderPinDots(); document.getElementById('pinSubmit').disabled = true; }, 700);
      showToast(data.error || 'Incorrect PIN', 'error');
    }
  })
  .catch(() => {
    document.getElementById('pinKeypad').style.pointerEvents = '';
    document.getElementById('pinSubmit').textContent = '✓ Confirm PIN';
    renderPinDots(true);
    setTimeout(() => { pinBuffer = ''; renderPinDots(); document.getElementById('pinSubmit').disabled = true; }, 700);
    showToast('Network error — could not verify PIN', 'error');
  });
}

// ── ENTER / EXIT ADMIN ────────────────────────────────────────────────────────
const ADMIN_SESSION_MS = 5 * 60 * 1000;   // 5 minutes
let   _adminTimer      = null;

function startAdminTimer() {
  clearTimeout(_adminTimer);
  _adminTimer = setTimeout(() => {
    showToast('⏱️ Admin session expired — please re-authenticate', 'warning');
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
  document.getElementById('downloadOverlay').classList.remove('open');
  // Exit full admin mode if active
  if (isAdmin) {
    isAdmin = false;
    stopAdminWatch();
    stopScanner();
    scannedEmpId     = null;
    scannedPrintedAt = null;
    document.getElementById('adminView').style.display    = 'none';
    document.getElementById('employeeView').style.display = 'block';
    document.getElementById('adminBtn').classList.remove('admin-active');
  }
  verifiedPin = null;
}

function enterAdmin() {
  isAdmin = true;
  document.getElementById('employeeView').style.display = 'none';
  document.getElementById('adminView').style.display    = 'block';
  document.getElementById('adminBtn').classList.add('admin-active');
  renderAdminRecords();
  populateAdminLocs();
  startAdminWatch();
  resetCameraToggleBtn();
  startAdminTimer();
}

function exitAdmin() {
  clearTimeout(_adminTimer);
  _adminTimer = null;
  isAdmin = false;
  verifiedPin = null;
  stopAdminWatch();
  stopScanner();
  scannedEmpId     = null;
  scannedPrintedAt = null;
  document.getElementById('adminView').style.display    = 'none';
  document.getElementById('employeeView').style.display = 'block';
  document.getElementById('adminBtn').classList.remove('admin-active');
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
function setAdminLoc(cls, icon, title, sub) {
  const el = document.getElementById('adminLocStatus');
  if (!el) return;
  el.className = 'loc-status ' + cls;
  document.getElementById('adminLocIcon').textContent  = icon;
  document.getElementById('adminLocTitle').textContent = title;
  document.getElementById('adminLocSub').textContent   = sub;
}

function startAdminWatch() {
  if (adminWatchId !== null) return;
  if (!navigator.geolocation) {
    setAdminLoc('failed', '❌', 'GPS not supported', 'Location verification unavailable');
    return;
  }
  setAdminLoc('checking', '📡', 'Getting your location…', 'Please wait');
  adminWatchId = navigator.geolocation.watchPosition(
    pos => {
      adminCurrentPos = { lat: pos.coords.latitude, lng: pos.coords.longitude, acc: Math.round(pos.coords.accuracy) };
      checkAdminProximity();
    },
    err => {
      const msgs = { 1: 'Location permission denied — allow GPS to continue', 2: 'Location unavailable', 3: 'Location timed out' };
      setAdminLoc('failed', '❌', msgs[err.code] || 'Location error', 'Check-in/out disabled until location is verified');
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
    if (!adminLocId) setAdminLoc('idle', '📍', 'No location selected', 'Select a duty location above');
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
    setAdminLoc('verified', '✅', loc.name, 'You are ' + dist + 'm away — location verified ✓');
  } else {
    adminLocVerified = false;
    setAdminLoc('failed', '🚫', 'You are outside ' + loc.name,
      dist + 'm away — must be within ' + tol + 'm to mark attendance here');
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
        const empRecs = todayRecs
          .filter(r => r.employeeId === emp.id && r.date === shiftDateStr())
          .sort((a, b) => (a.checkInTimestamp || '').localeCompare(b.checkInTimestamp || ''));
        const lastRec       = empRecs.length ? empRecs[empRecs.length - 1] : null;
        const completedSess = empRecs.filter(r => r.checkIn && r.checkOut).length;
        const hasOpenRec    = lastRec && lastRec.checkIn && !lastRec.checkOut;
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
  btn.textContent = '📷 Start Camera';
  btn.classList.remove('active');
  wrap.classList.remove('visible');
  document.getElementById('qrScanStatus').textContent = '📷 Press "Start Camera" to begin scanning';
}

async function toggleCamera() {
  if (scannerStream) {
    // Camera is ON → turn it off
    stopScanner();
    resetCameraToggleBtn();
  } else {
    // Camera is OFF → turn it on
    const btn  = document.getElementById('btnCameraToggle');
    const wrap = document.getElementById('qrScannerWrap');
    btn.textContent = '⏹ Stop Camera';
    btn.classList.add('active');
    wrap.classList.add('visible');
    await startScanner();
  }
}

// ── QR SCANNER ────────────────────────────────────────────────────────────────
async function startScanner() {
  try {
    scannerPaused = false;
    document.getElementById('qrScanStatus').textContent = '📷 Starting camera…';
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 640 }, height: { ideal: 480 } }
    });
    scannerStream = stream;
    const video = document.getElementById('qrVideo');
    video.srcObject = stream;
    await video.play();
    document.getElementById('qrScanStatus').textContent = '📷 Point camera at QR code';
    tickScanner();
  } catch(e) {
    document.getElementById('qrScanStatus').textContent = '❌ Camera error: ' + e.message;
    resetCameraToggleBtn();   // restore "Start Camera" button state
  }
}

function stopScanner() {
  if (scannerAnimFrame) { cancelAnimationFrame(scannerAnimFrame); scannerAnimFrame = null; }
  if (scannerStream) { scannerStream.getTracks().forEach(t => t.stop()); scannerStream = null; }
  // Reset button label (safe to call even on exitAdmin)
  const btn = document.getElementById('btnCameraToggle');
  if (btn) { btn.textContent = '📷 Start Camera'; btn.classList.remove('active'); }
  const wrap = document.getElementById('qrScannerWrap');
  if (wrap) wrap.classList.remove('visible');
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
    document.getElementById('qrScanStatus').textContent = '📷 Point camera at QR code';
    scannerAnimFrame = requestAnimationFrame(tickScanner);
  } else {
    document.getElementById('qrScanStatus').textContent = '📷 Press "Start Camera" to begin scanning';
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
    document.getElementById('qrScanStatus').textContent = '⚠️ Unknown QR: ' + data;
    scannerAnimFrame = requestAnimationFrame(tickScanner);
    return;
  }
  // Pause scanner
  scannerPaused = true;
  scannedEmpId       = emp.id;
  scannedPrintedAt   = printedAtPart;
  resetAdminTimer();

  // Find records for today, sorted oldest-first
  const empRecs = todayRecs
    .filter(r => r.employeeId === emp.id && r.date === shiftDateStr())
    .sort((a, b) => (a.checkInTimestamp || '').localeCompare(b.checkInTimestamp || ''));
  const lastRec       = empRecs.length ? empRecs[empRecs.length - 1] : null;
  const completedSess = empRecs.filter(r => r.checkIn && r.checkOut).length;
  const hasOpenRec    = lastRec && lastRec.checkIn && !lastRec.checkOut;
  const capReached    = completedSess >= MAX_CHECKINS_PER_DAY && !hasOpenRec;

  const init = emp.name.split(' ').map(w => w[0]).slice(0,2).join('').toUpperCase();
  document.getElementById('scanAvatar').textContent  = init;
  document.getElementById('scanName').textContent    = emp.name;
  document.getElementById('scanDesig').textContent   = emp.designation || '';
  let stateText = '';
  if (!lastRec)        stateText = '⬜ Not checked in today';
  else if (hasOpenRec) stateText = '✅ Checked in at ' + lastRec.checkIn + ' · tap CHECK OUT';
  else if (capReached) stateText = '🔒 Daily limit reached (' + MAX_CHECKINS_PER_DAY + ' sessions completed)';
  else                 stateText = '↩ Last checkout: ' + lastRec.checkOut + ' · tap CHECK IN to re-enter';
  document.getElementById('scanState').textContent   = stateText;
  document.getElementById('scanPreview').classList.add('visible');
  document.getElementById('qrScanStatus').textContent = '✅ Scanned: ' + emp.name;

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
  if (!emp) { showToast('No employee scanned', 'error'); return; }
  if (!adminLocId) { showToast('Select a duty location first', 'warning'); return; }
  if (!adminLocVerified) { showToast('Your location is not verified for this site — move closer', 'error'); return; }
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
  try {
    const records = await attGet().catch(() => []);
    // Check there is no currently open record (not checked out) for this employee today
    const openRec = records.find(r => r.employeeId === rec.employeeId && r.date === rec.date && r.checkIn && !r.checkOut);
    if (openRec) throw new Error(rec.name + ' is already checked in — check out first');
    const completedToday = records.filter(r => r.employeeId === rec.employeeId && r.date === rec.date && r.checkIn && r.checkOut).length;
    if (completedToday >= MAX_CHECKINS_PER_DAY) throw new Error(rec.name + ' has reached the maximum of ' + MAX_CHECKINS_PER_DAY + ' check-ins for today');
    const inserted = await attAdminInsert({ ...rec, printedAt: scannedPrintedAt });
    todayRecs.push({ ...rec, id: inserted.id });
    renderRecords(); renderAdminRecords();
    resetAdminTimer();
    showToast('✅ ' + emp.name + ' checked IN', 'success');
    document.getElementById('scanState').textContent = '✅ Checked in at ' + rec.checkIn;
    document.getElementById('btnScanIn').disabled  = true;
    document.getElementById('btnScanOut').disabled = false;
  } catch(e) {
    showToast('Error: ' + e.message, 'error');
    document.getElementById('btnScanIn').disabled = false;
  }
  document.getElementById('btnScanIn').innerHTML = '✅ Check IN';
}

async function adminDoOut() {
  const emp = employees.find(e => e.id === scannedEmpId);
  if (!emp) { showToast('No employee scanned', 'error'); return; }
  if (!adminLocVerified) { showToast('Your location is not verified for this site — move closer', 'error'); return; }
  document.getElementById('btnScanOut').disabled = true;
  document.getElementById('btnScanOut').innerHTML = '<span class="spinner"></span>';
  try {
    const allRecs = await attGet().catch(() => []);
    const today   = shiftDateStr();
    const openRec = allRecs.find(r => r.employeeId === emp.id && r.date === today && !r.checkOut);
    if (!openRec) throw new Error('No active check-in found for ' + emp.name);
    if (!openRec.id) throw new Error('Record has no id — cannot update');
    const now    = new Date();
    const coTime = timeStr(now);
    const updated = await attUpdate(openRec.id, { checkOut: coTime });   // worker verifies PIN
    const displayTime = updated.checkOut || coTime;
    const local = todayRecs.find(r => r.employeeId === emp.id && r.date === today && !r.checkOut);
    if (local) { local.checkOut = displayTime; local.checkOutTimestamp = updated.checkOutTimestamp; }
    renderRecords(); renderAdminRecords();
    resetAdminTimer();
    showToast('🚪 ' + emp.name + ' checked OUT', 'success');
    document.getElementById('scanState').textContent = '✔️ Checked out at ' + displayTime;
    document.getElementById('btnScanOut').disabled = true;
  } catch(e) {
    showToast('Error: ' + e.message, 'error');
    document.getElementById('btnScanOut').disabled = false;
  }
  document.getElementById('btnScanOut').innerHTML = '🚪 Check OUT';
}

// ── DOWNLOAD SHEET ────────────────────────────────────────────────────────────
function openDownloadSheet() {
  if (!isAdmin && !verifiedPin) { openPinOverlay('download'); return; }
  _openDownloadSheetDirect();
}

async function _openDownloadSheetDirect() {
  await populateSummaryMonths();
  document.getElementById('downloadOverlay').classList.add('open');
}

function closeDownloadSheet() {
  document.getElementById('downloadOverlay').classList.remove('open');
  revokeAdminSession();
}

function handleDownloadOverlayClick(e) {
  if (e.target === document.getElementById('downloadOverlay')) closeDownloadSheet();
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

async function downloadRawCsv() {
  const btn = event.currentTarget;
  btn.disabled = true;
  btn.style.opacity = '0.6';
  try {
    const records = await attGet();
    const content = csvStringify(records);
    const d = new Date();
    const ts = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
    triggerDownload('attendance_records_' + ts + '.csv', content);
    showToast('Downloaded ' + records.length + ' records', 'success');
  } catch(e) {
    showToast('Download failed: ' + e.message, 'error');
  } finally {
    btn.disabled = false;
    btn.style.opacity = '';
  }
}

async function downloadSummaryCsv() {
  const btn = event.currentTarget;
  btn.disabled = true;
  btn.style.opacity = '0.6';
  try {
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
      const monthLabel = new Date(+y, +m - 1, 1)
        .toLocaleString('en-IN', { month: 'short', year: 'numeric' });
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
    showToast('Summary: ' + rows.length + ' employee-month rows', 'success');
  } catch(e) {
    showToast('Download failed: ' + e.message, 'error');
  } finally {
    btn.disabled = false;
    btn.style.opacity = '';
  }
}

// Populate the month selector from all records
async function populateSummaryMonths() {
  try {
    const records = await attGet();
    const months  = [...new Set(records.map(r => r.date ? r.date.slice(0,7) : '').filter(Boolean))].sort().reverse();
    const sel = document.getElementById('summaryMonthSel');
    if (!sel) return;
    sel.innerHTML = '<option value="">All months</option>' +
      months.map(m => {
        const [y, mo] = m.split('-');
        const label = new Date(+y, +mo - 1, 1).toLocaleString('en-IN', { month: 'long', year: 'numeric' });
        return `<option value="${m}">${label}</option>`;
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
let _uuidToEmpId = {};

function formatPrintedOn(d) {
  const DAYS  = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const MONTHS= ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `Printed on ${DAYS[d.getDay()]}, ${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// ── QR PRINT PAGE ─────────────────────────────────────────────────────────────
async function openQrPrint() {
  // Require admin PIN — if already in admin mode the PIN is already verified
  if (!isAdmin && !verifiedPin) {
    openPinOverlay('qr');
    return;
  }
  await _openQrPrintDirect();
}

async function _openQrPrintDirect() {
  await buildUuidLookup();
  _selectedEmpIds.clear();
  document.getElementById('qrPrintOverlay').classList.add('open');
  buildQrGrid('');
}

function closeQrPrint() {
  document.getElementById('qrPrintOverlay').classList.remove('open');
  _selectedEmpIds.clear();
  revokeAdminSession();
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
    grid.innerHTML = '<div class="emp-list-empty">No employees found</div>';
    _updateSelectionUI();
    return;
  }
  for (const emp of list) {
    const init    = emp.name.split(' ').map(w => w[0]).slice(0,2).join('').toUpperCase();
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
    printBtn.textContent = `🖨️ Print Selected (${n})`; printBtn.style.display = '';
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
  const init    = emp.name.split(' ').map(w => w[0]).slice(0,2).join('').toUpperCase();

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
  document.getElementById('btnIdPrint').textContent = '🖨️ Print ID Card';
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
    body { font-family: 'Nunito', Arial, sans-serif; background: white; }
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
  <link href="https://fonts.googleapis.com/css2?family=Nunito:wght@400;600;700;800&display=swap" rel="stylesheet">
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
  document.getElementById('btnIdPrint').textContent = isOpen ? '✕ Cancel' : '🖨️ Print ID Card';
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
  document.getElementById('btnIdPrint').textContent = '🖨️ Print ID Card';
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
  btn.disabled = true; btn.textContent = '⏳ Building…';

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
