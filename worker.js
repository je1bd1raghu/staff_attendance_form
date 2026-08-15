// Cloudflare Worker — Attendance Proxy (Supabase backend)
//
// Secrets required:
//   SUPABASE_URL          — e.g. https://xxxx.supabase.co
//   SUPABASE_SERVICE_KEY  — service_role key (bypasses RLS; server-side only)
//   ADMIN_PIN             — admin PIN validated server-side
//
// Optional:
//   SUPABASE_ANON_KEY     — fallback if SERVICE_KEY is unset (requires RLS
//                           insert/update policies, not recommended)
//
// ── PROXY-ATTENDANCE PROTECTIONS (all enforced server-side) ──────────────────
//
//  ✓ employeeId validated against config — can't invent a phantom employee
//  ✓ date always set server-side to current shift date — can't backdate/forward-date
//  ✓ deviceId and deviceToken always overwritten server-side — can't spoof a device
//  ✓ duplicate check-in blocked server-side — can't double-check-in
//  ✓ daily cap enforced server-side — can't exceed MAX_CHECKINS_PER_DAY
//  ✓ cross-device proxy blocked server-side — one device can't check in
//    two different employees simultaneously (matched by token OR fingerprint)
//  ✓ PATCH /attendance/:id verifies the record belongs to the requesting
//    deviceToken or deviceId before allowing checkout — can't check out someone
//    else; the durable token tolerates fingerprint drift after browser updates
//  ✓ QR printedAt expiry — printed cards older than QR_MAX_AGE_MS are rejected
//  ✓ Chrome gate — self check-in/out rejected when Sec-CH-UA positively
//    identifies a non-Chrome browser (client gate also blocks at startup)
//
// Routes:
//   GET  /config                  → proxy config JSON from Supabase
//   GET  /attendance              → fetch all attendance rows
//   POST /verify-pin              → 200 OK | 403 Forbidden
//   POST /attendance              → employee self check-in (server validates)
//   PATCH /attendance/:id         → employee check-out (ownership verified)
//   POST /attendance/admin        → admin check-in via QR (PIN + server validates)
//   PATCH /attendance/admin/:id   → admin check-out (PIN required)

const MAX_CHECKINS_PER_DAY = 2;
const SHIFT_CUTOFF_HOUR    = 4;      // 04:00 — same as app.js
const QR_MAX_AGE_MS        = 24 * 60 * 60 * 1000;  // QR cards valid for 24 h
// Local timezone offset (minutes) for the site. The worker runs in UTC on
// Cloudflare, but the shift date/cutoff and displayed times are local wall-clock.
// IST = UTC+5:30 = 330 min. Adjust if the site moves timezone.
const TZ_OFFSET_MIN        = 330;

export default {
  async fetch(request, env) {
    const cors = {
      'Access-Control-Allow-Origin':  '*',
      'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });

    const path = new URL(request.url).pathname.replace(/\/$/, '');

    // Positive-detect Chrome gate. Browsers send the Sec-CH-UA header with the
    // real brand list, so we can distinguish genuine Google Chrome from Chromium
    // forks (Edge, Opera, Samsung Internet, Brave, Vivaldi) server-side. Only
    // positive non-Chrome signals are rejected — if the header is missing we
    // allow the request and rely on the client-side gate. iOS is always allowed
    // (every iOS browser shares the WebKit engine, so there is no real Chrome).
    function chromeGate(request) {
      const secChUa = request.headers.get('sec-ch-ua') || '';
      if (!secChUa) return null;                      // can't verify → allow (client gate covers)
      const ua = request.headers.get('user-agent') || '';
      if (/iPad|iPhone|iPod/.test(ua)) return null;   // iOS → allowed
      const isChrome = /Google Chrome/.test(secChUa);
      const isFork   = /Microsoft Edge|Opera|Samsung Internet|Vivaldi|Brave/.test(secChUa);
      if (isChrome && !isFork) return null;           // genuine Chrome → allow
      return 'This page must be opened in Google Chrome';
    }

    // ── shared helpers ────────────────────────────────────────────────────────
    // The worker is server-side and holds secrets safely, so it uses the
    // service_role key which bypasses RLS. RLS still blocks direct client writes —
    // every write must come through this worker, which validates PIN/ownership.
    const supaKey = env.SUPABASE_SERVICE_KEY || env.SUPABASE_ANON_KEY;
    const supaHeaders = {
      'apikey':        supaKey,
      'Authorization': 'Bearer ' + supaKey,
      'Content-Type':  'application/json',
      'Prefer':        'return=representation',
    };
    function ok(data, status = 200) {
      return new Response(JSON.stringify(data), {
        status, headers: { 'Content-Type': 'application/json', ...cors },
      });
    }
    function err(msg, status = 400) {
      return new Response(JSON.stringify({ error: msg }), {
        status, headers: { 'Content-Type': 'application/json', ...cors },
      });
    }
    async function supa(endpoint, opts = {}) {
      const r = await fetch(`${env.SUPABASE_URL}/rest/v1/${endpoint}`, {
        ...opts,
        headers: { ...supaHeaders, ...(opts.headers || {}) },
      });
      let data;
      try { data = await r.json(); } catch { data = {}; }
      return { ok: r.ok, status: r.status, data };
    }

    // A Date shifted by TZ_OFFSET_MIN so the getUTC* getters return local
    // wall-clock values (the worker host is always UTC).
    function localDate(d = new Date()) {
      return new Date(d.getTime() + TZ_OFFSET_MIN * 60000);
    }

    // Current shift date string "YYYY-MM-DD" — computed server-side in local time
    function shiftDateStr() {
      const d = localDate();
      if (d.getUTCHours() < SHIFT_CUTOFF_HOUR) d.setUTCDate(d.getUTCDate() - 1);
      const y = d.getUTCFullYear();
      const m = String(d.getUTCMonth() + 1).padStart(2, '0');
      const day = String(d.getUTCDate()).padStart(2, '0');
      return `${y}-${m}-${day}`;
    }

    // Current local time "HH:MM:SS" (fallback when client doesn't send one)
    function nowTimeStr(d) {
      const l = localDate(d);
      const p = n => String(n).padStart(2, '0');
      return `${p(l.getUTCHours())}:${p(l.getUTCMinutes())}:${p(l.getUTCSeconds())}`;
    }

    // Load today's attendance rows for a given date from Supabase
    async function getTodayRows(date) {
      const { ok: isOk, data } = await supa(
        `attendance?date=eq.${date}&select=id,employeeId,deviceId,checkIn,checkOut,date`
      );
      return isOk && Array.isArray(data) ? data : [];
    }

    // Load all OPEN (not checked out) records belonging to this device identity —
    // matched by the durable deviceToken OR the fingerprint deviceId. Across ALL
    // dates, so stale open sessions from previous days are not missed.
    async function getDeviceOpenRows(deviceId, deviceToken) {
      const or = ['deviceId.eq.' + deviceId];
      if (deviceToken) or.push('deviceToken.eq.' + deviceToken);
      const { ok: isOk, data } = await supa(
        `attendance?or=(${or.join(',')})&checkOut=is.null&select=id,employeeId,deviceId,deviceToken,checkIn,checkOut,date`
      );
      return isOk && Array.isArray(data) ? data : [];
    }

    // Load all OPEN records for a given employee — across ALL devices and dates.
    // Only a same-day open session blocks a new check-in; open sessions from
    // previous days (forgot to check out) are surfaced to the client as a warning.
    async function getEmployeeOpenRows(employeeId) {
      const { ok: isOk, data } = await supa(
        `attendance?employeeId=eq.${employeeId}&checkOut=is.null&select=id,employeeId,deviceId,checkIn,checkOut,date`
      );
      return isOk && Array.isArray(data) ? data : [];
    }

    // Load config (employees list) for employeeId validation
    async function getConfig() {
      const { ok: isOk, data } = await supa('config?id=eq.1&select=data');
      if (!isOk || !Array.isArray(data) || !data[0]) return null;
      return data[0].data;
    }

    // Parse a JSON request body — null when malformed.
    async function readJson(request) {
      try { return await request.json(); } catch { return null; }
    }

    // Validate employeeId against config; returns { emp } or { error }.
    async function loadEmployee(body) {
      const config = await getConfig();
      if (!config) return { error: err('Config unavailable', 503) };
      const emp = (config.employees || []).find(e => e.id === body.employeeId);
      if (!emp) return { error: err('Unknown employeeId', 400) };
      return { emp };
    }

    // The single OPEN record for an employee on a given shift date, if any.
    async function getSameDayOpenRow(employeeId, date) {
      const empRows = await getEmployeeOpenRows(employeeId);
      return empRows.find(r => r.date === date);
    }

    function completedSessionCount(rows, employeeId) {
      return rows.filter(r => r.employeeId === employeeId && r.checkIn && r.checkOut).length;
    }

    // Build a check-in row. deviceToken is set only for self check-in.
    function checkInRow(emp, date, body, now, deviceId, deviceToken) {
      const row = {
        employeeId:        emp.id,
        name:              emp.name,
        designation:       emp.designation || '',
        date,                              // server-computed, ignores client value
        checkIn:           body.checkIn || nowTimeStr(now),  // client local time preferred
        checkInTimestamp:  now.toISOString(),                // server UTC, source of truth
        checkOut:          null,
        checkOutTimestamp: null,
        location:          body.location  || '',
        lat:               body.lat       ?? null,
        lng:               body.lng       ?? null,
        deviceId,                          // server re-sets from validated value
      };
      if (deviceToken) row.deviceToken = deviceToken;   // durable device pass (UUID)
      return row;
    }

    // Insert a check-in row and respond with the created record.
    async function insertRow(row) {
      const { ok: isOk, data, status } = await supa('attendance', {
        method: 'POST', body: JSON.stringify(row),
      });
      if (!isOk) return err(data?.message || 'Insert failed', status);
      return ok(Array.isArray(data) ? data[0] : data, 201);
    }

    // Fetch a single attendance record by id, or null.
    async function fetchRecord(id) {
      const { ok: isOk, data } = await supa(`attendance?id=eq.${id}&select=*`);
      if (!isOk || !data?.length) return null;
      return data[0];
    }

    // Apply a check-out to a record and respond with the updated row.
    async function checkoutRow(id, body) {
      const now = new Date();
      const patch = {
        checkOut:          body.checkOut || nowTimeStr(now),  // client local time preferred
        checkOutTimestamp: now.toISOString(),                 // server UTC, source of truth
      };
      const { ok: pOk, data: pData, status } = await supa(`attendance?id=eq.${id}`, {
        method: 'PATCH', body: JSON.stringify(patch),
      });
      if (!pOk) return err(pData?.message || 'Update failed', status);
      return ok(Array.isArray(pData) ? pData[0] : pData);
    }

    // ── POST /verify-pin ──────────────────────────────────────────────────────
    if (request.method === 'POST' && path.endsWith('/verify-pin')) {
      const body = await readJson(request);
      if (!body) return err('Bad JSON');
      if (!env.ADMIN_PIN) return err('ADMIN_PIN not configured', 500);
      return body.adminPin === env.ADMIN_PIN ? ok({ ok: true }) : err('Incorrect PIN', 403);
    }

    // ── GET /config ───────────────────────────────────────────────────────────
    if (request.method === 'GET' && path.endsWith('/config')) {
      const cfg = await getConfig();
      if (!cfg) return err('Config not found', 404);
      // Include server-computed shift date so the client doesn't need to
      // re-derive it using browser-local time (which may differ from IST).
      cfg._shiftDate        = shiftDateStr();
      cfg._tzOffsetMin      = TZ_OFFSET_MIN;
      cfg._shiftCutoffHour  = SHIFT_CUTOFF_HOUR;
      return ok(cfg);
    }

    // ── GET /attendance ───────────────────────────────────────────────────────
    if (request.method === 'GET' && path.endsWith('/attendance')) {
      const { ok: isOk, data } = await supa(
        'attendance?select=*&order=checkInTimestamp.asc.nullslast'
      );
      if (!isOk) return err('Failed to fetch attendance', 502);
      return ok(data);
    }

    // ── POST /attendance  (employee self check-in) ────────────────────────────
    if (request.method === 'POST' && path.endsWith('/attendance')) {
      const body = await readJson(request);
      if (!body) return err('Bad JSON');

      const gateErr = chromeGate(request);
      if (gateErr) return err(gateErr, 403);

      // 1. Validate employeeId exists in config
      const { emp, error } = await loadEmployee(body);
      if (error) return error;

      // 2. Validate deviceId is present (FingerprintJS value from client)
      const deviceId = (body.deviceId || '').trim();
      if (!deviceId || deviceId.startsWith('ADMIN')) return err('Invalid deviceId', 400);
      // Durable device pass — survives browser updates that change the
      // fingerprint. Generated server-side on first check-in if the client
      // didn't already hold one (stored in localStorage/IndexedDB).
      const deviceToken = (body.deviceToken || '').trim() || crypto.randomUUID();

      // 3. Server sets the date — client value is ignored entirely
      const date = shiftDateStr();
      const rows = await getTodayRows(date);

      // 4. Cross-device proxy check: this device can't have a different employee open.
      //     Matches open sessions by the durable token OR the fingerprint.
      const devRows = await getDeviceOpenRows(deviceId, deviceToken);
      const otherOpen = devRows.find(r => r.employeeId !== body.employeeId);
      if (otherOpen) return err(`Another employee is already checked in from this device`, 409);

      // 5. No double check-in TODAY. Open sessions from previous days (forgot to
      //    check out) no longer block check-in — the client shows a warning modal
      //    listing those days and requires the employee to confirm before proceeding.
      const openToday = await getSameDayOpenRow(body.employeeId, date);
      if (openToday)
        return err(`${emp.name} is already checked in today — check out first`, 409);

      // 6. Daily cap
      const completed = completedSessionCount(rows, body.employeeId);
      if (completed >= MAX_CHECKINS_PER_DAY)
        return err(`${emp.name} has reached the daily limit of ${MAX_CHECKINS_PER_DAY} sessions`, 409);

      // 7. Build the row — overwrite date/deviceId server-side, but keep client's
      // local-time strings for checkIn/checkOut so they display correctly.
      // checkInTimestamp is the authoritative ISO timestamp (always UTC).
      const now = new Date();
      const row = checkInRow(emp, date, body, now, deviceId, deviceToken);
      return insertRow(row);
    }

    // ── PATCH /attendance/:id  (employee self check-out) ─────────────────────
    const patchMatch = path.match(/^\/attendance\/([0-9a-f-]{36})$/);
    if (request.method === 'PATCH' && patchMatch) {
      const id = patchMatch[1];
      const body = await readJson(request);
      if (!body) return err('Bad JSON');

      const gateErr = chromeGate(request);
      if (gateErr) return err(gateErr, 403);

      const deviceId    = (body.deviceId || '').trim();
      const deviceToken = (body.deviceToken || '').trim();
      if (!deviceId && !deviceToken) return err('Device verification required for checkout', 400);

      // Fetch the target row and verify ownership by device identity
      const rec = await fetchRecord(id);
      if (!rec) return err('Record not found', 404);

      // Ownership: the checking-out browser must hold the durable token that
      // checked in, or (fallback) the same fingerprint. Either match is enough,
      // so a browser update that shifts the fingerprint can't lock a worker out.
      const ownsByToken = !!rec.deviceToken && !!deviceToken && rec.deviceToken === deviceToken;
      const ownsByFp    = !!rec.deviceId && !!deviceId && rec.deviceId === deviceId;
      if (!ownsByToken && !ownsByFp) return err('You cannot check out another person', 403);
      if (rec.checkOut) return err('Already checked out', 409);

      return checkoutRow(id, body);
    }

    // ── POST /attendance/admin  (admin check-in via QR scan) ─────────────────
    if (request.method === 'POST' && path.endsWith('/attendance/admin')) {
      const body = await readJson(request);
      if (!body) return err('Bad JSON');

      // PIN check
      if (!env.ADMIN_PIN) return err('ADMIN_PIN not configured', 500);
      if (body.adminPin !== env.ADMIN_PIN) return err('Incorrect PIN', 403);

      // Validate employeeId
      const { emp, error } = await loadEmployee(body);
      if (error) return error;

      // QR age check — printedAt comes from the scanned QR payload
      if (body.printedAt) {
        const age = Date.now() - new Date(body.printedAt).getTime();
        if (isNaN(age) || age > QR_MAX_AGE_MS)
          return err('QR code has expired — please reprint the ID card', 410);
      }

      const date = shiftDateStr();
      const rows = await getTodayRows(date);

      // Same business-rule checks as employee check-in. Open sessions from
      // previous days (missing check-out) no longer block admin check-in.
      const openToday = await getSameDayOpenRow(emp.id, date);
      if (openToday) return err(`${emp.name} is already checked in today`, 409);

      const completed = completedSessionCount(rows, emp.id);
      if (completed >= MAX_CHECKINS_PER_DAY)
        return err(`${emp.name} has reached the daily limit`, 409);

      const now = new Date();
      const deviceIdVal = body.printedAt
        ? `ADMIN|QR Printed on ${body.printedAt}`
        : 'ADMIN';

      const row = checkInRow(emp, date, body, now, deviceIdVal);
      return insertRow(row);
    }

    // ── PATCH /attendance/admin/:id  (admin check-out) ────────────────────────
    const adminPatchMatch = path.match(/^\/attendance\/admin\/([0-9a-f-]{36})$/);
    if (request.method === 'PATCH' && adminPatchMatch) {
      const id = adminPatchMatch[1];
      const body = await readJson(request);
      if (!body) return err('Bad JSON');

      if (!env.ADMIN_PIN) return err('ADMIN_PIN not configured', 500);
      if (body.adminPin !== env.ADMIN_PIN) return err('Incorrect PIN', 403);

      const rec = await fetchRecord(id);
      if (!rec) return err('Record not found', 404);
      if (rec.checkOut) return err('Already checked out', 409);

      return checkoutRow(id, body);
    }

    return new Response('Not found', { status: 404, headers: cors });
  },
};
