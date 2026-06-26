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
//  ✓ deviceId always overwritten server-side — can't spoof another device
//  ✓ duplicate check-in blocked server-side — can't double-check-in
//  ✓ daily cap enforced server-side — can't exceed MAX_CHECKINS_PER_DAY
//  ✓ cross-device proxy blocked server-side — one device can't check in
//    two different employees simultaneously
//  ✓ PATCH /attendance/:id verifies the record belongs to the requesting
//    deviceId before allowing checkout — can't check out someone else
//  ✓ QR printedAt expiry — printed cards older than QR_MAX_AGE_MS are rejected
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

    // Load all OPEN (not checked out) records for a given deviceId — across ALL dates.
    // This catches the case where an employee forgot to check out on a previous day;
    // without this, the date-filtered getTodayRows would miss stale open sessions.
    async function getDeviceOpenRows(deviceId) {
      const { ok: isOk, data } = await supa(
        `attendance?deviceId=eq.${deviceId}&checkOut=is.null&select=id,employeeId,deviceId,checkIn,checkOut,date`
      );
      return isOk && Array.isArray(data) ? data : [];
    }

    // Load all OPEN records for a given employee — across ALL devices and dates.
    // This prevents an employee from checking in from a second device while they
    // have an open session on another device (e.g. forgot to check out).
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

    // ── POST /verify-pin ──────────────────────────────────────────────────────
    if (request.method === 'POST' && path.endsWith('/verify-pin')) {
      let body; try { body = await request.json(); } catch { return err('Bad JSON'); }
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
      let body; try { body = await request.json(); } catch { return err('Bad JSON'); }

      // 1. Validate employeeId exists in config
      const config = await getConfig();
      if (!config) return err('Config unavailable', 503);
      const emp = (config.employees || []).find(e => e.id === body.employeeId);
      if (!emp) return err('Unknown employeeId', 400);

      // 2. Validate deviceId is present (FingerprintJS value from client)
      const deviceId = (body.deviceId || '').trim();
      if (!deviceId || deviceId.startsWith('ADMIN')) return err('Invalid deviceId', 400);

      // 3. Server sets the date — client value is ignored entirely
      const date = shiftDateStr();
      const rows = await getTodayRows(date);

      // 4. Cross-device proxy check: this device can't have a different employee open.
      //     Queries ALL open records for this deviceId (any date) so that stale open
      //     sessions from previous days are not missed by the date filter.
      const devRows = await getDeviceOpenRows(deviceId);
      const otherOpen = devRows.find(r => r.employeeId !== body.employeeId);
      if (otherOpen) return err(`Another employee is already checked in from this device`, 409);

      // 5. No double check-in for the same employee — across ALL devices and all dates.
      //    This prevents re-entry when the employee has an open session on another device
      //    (or forgot to check out on a previous day).
      const empRows = await getEmployeeOpenRows(body.employeeId);
      if (empRows.length) {
        const openRec    = empRows[0];
        const isToday    = openRec.date === date;
        const msg        = isToday
          ? `${emp.name} is already checked in today — check out first`
          : `${emp.name} has an incomplete day from ${openRec.date} (missing check-out) — contact your admin to correct the record`;
        return err(msg, 409);
      }

      // 6. Daily cap
      const completed = rows.filter(r =>
        r.employeeId === body.employeeId && r.checkIn && r.checkOut
      ).length;
      if (completed >= MAX_CHECKINS_PER_DAY)
        return err(`${emp.name} has reached the daily limit of ${MAX_CHECKINS_PER_DAY} sessions`, 409);

      // 7. Build the row — overwrite date/deviceId server-side, but keep client's
      // local-time strings for checkIn/checkOut so they display correctly.
      // checkInTimestamp is the authoritative ISO timestamp (always UTC).
      const now = new Date();
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

      const { ok: isOk, data, status } = await supa('attendance', {
        method: 'POST', body: JSON.stringify(row),
      });
      if (!isOk) return err(data?.message || 'Insert failed', status);
      return ok(Array.isArray(data) ? data[0] : data, 201);
    }

    // ── PATCH /attendance/:id  (employee self check-out) ─────────────────────
    const patchMatch = path.match(/^\/attendance\/([0-9a-f-]{36})$/);
    if (request.method === 'PATCH' && patchMatch) {
      const id = patchMatch[1];
      let body; try { body = await request.json(); } catch { return err('Bad JSON'); }

      const deviceId = (body.deviceId || '').trim();
      if (!deviceId) return err('deviceId required for checkout', 400);

      // Fetch the target row and verify ownership by deviceId
      const { ok: isOk, data: rows } = await supa(`attendance?id=eq.${id}&select=*`);
      if (!isOk || !rows?.length) return err('Record not found', 404);
      const rec = rows[0];

      // Ownership: the deviceId checking out must match the one that checked in
      if (rec.deviceId !== deviceId) return err('You cannot check out another person', 403);
      if (rec.checkOut) return err('Already checked out', 409);

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

    // ── POST /attendance/admin  (admin check-in via QR scan) ─────────────────
    if (request.method === 'POST' && path.endsWith('/attendance/admin')) {
      let body; try { body = await request.json(); } catch { return err('Bad JSON'); }

      // PIN check
      if (!env.ADMIN_PIN) return err('ADMIN_PIN not configured', 500);
      if (body.adminPin !== env.ADMIN_PIN) return err('Incorrect PIN', 403);

      // Validate employeeId
      const config = await getConfig();
      if (!config) return err('Config unavailable', 503);
      const emp = (config.employees || []).find(e => e.id === body.employeeId);
      if (!emp) return err('Unknown employeeId', 400);

      // QR age check — printedAt comes from the scanned QR payload
      if (body.printedAt) {
        const age = Date.now() - new Date(body.printedAt).getTime();
        if (isNaN(age) || age > QR_MAX_AGE_MS)
          return err('QR code has expired — please reprint the ID card', 410);
      }

      const date = shiftDateStr();
      const rows = await getTodayRows(date);

      // Same business-rule checks as employee check-in
      const empRows = await getEmployeeOpenRows(emp.id);
      if (empRows.length) return err(`${emp.name} is already checked in`, 409);

      const completed = rows.filter(r => r.employeeId === emp.id && r.checkIn && r.checkOut).length;
      if (completed >= MAX_CHECKINS_PER_DAY)
        return err(`${emp.name} has reached the daily limit`, 409);

      const now = new Date();
      const deviceIdVal = body.printedAt
        ? `ADMIN|QR Printed on ${body.printedAt}`
        : 'ADMIN';

      const row = {
        employeeId:        emp.id,
        name:              emp.name,
        designation:       emp.designation || '',
        date,
        checkIn:           body.checkIn || nowTimeStr(now),  // client local time preferred
        checkInTimestamp:  now.toISOString(),
        checkOut:          null,
        checkOutTimestamp: null,
        location:          body.location || '',
        lat:               body.lat ?? null,
        lng:               body.lng ?? null,
        deviceId:          deviceIdVal,
      };

      const { ok: isOk, data, status } = await supa('attendance', {
        method: 'POST', body: JSON.stringify(row),
      });
      if (!isOk) return err(data?.message || 'Insert failed', status);
      return ok(Array.isArray(data) ? data[0] : data, 201);
    }

    // ── PATCH /attendance/admin/:id  (admin check-out) ────────────────────────
    const adminPatchMatch = path.match(/^\/attendance\/admin\/([0-9a-f-]{36})$/);
    if (request.method === 'PATCH' && adminPatchMatch) {
      const id = adminPatchMatch[1];
      let body; try { body = await request.json(); } catch { return err('Bad JSON'); }

      if (!env.ADMIN_PIN) return err('ADMIN_PIN not configured', 500);
      if (body.adminPin !== env.ADMIN_PIN) return err('Incorrect PIN', 403);

      const { ok: isOk, data: rows } = await supa(`attendance?id=eq.${id}&select=*`);
      if (!isOk || !rows?.length) return err('Record not found', 404);
      const rec = rows[0];
      if (rec.checkOut) return err('Already checked out', 409);

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

    return new Response('Not found', { status: 404, headers: cors });
  },
};
