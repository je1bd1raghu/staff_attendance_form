// Cloudflare Worker — Attendance Proxy (Supabase backend)
//
// Secrets required (set via Cloudflare dashboard or `wrangler secret put`):
//   SUPABASE_URL        — e.g. https://xxxx.supabase.co
//   SUPABASE_ANON_KEY   — anon/public key (safe to use from server-side)
//   ADMIN_PIN           — admin PIN validated server-side
//
// Supabase tables required:
//   attendance  — one row per check-in/out event (see schema below)
//   config      — single row holding employees + locations JSON
//
// Routes:
//   GET  /attendance            → fetch all attendance rows as JSON
//   GET  /config                → fetch config row
//   POST /verify-pin            → 200 OK | 403 Forbidden
//   POST /attendance            → insert one attendance record (employee self check-in)
//   PATCH /attendance/:id       → update one record (check-out, admin edits)
//   POST /attendance/admin      → insert with PIN check (admin check-in via QR)
//   PATCH /attendance/admin/:id → update with PIN check (admin check-out via QR)
//
// Supabase schema (run in SQL editor):
// ─────────────────────────────────────────────────────────────────────────────
//   create table attendance (
//     id                  uuid primary key default gen_random_uuid(),
//     "employeeId"        text not null,
//     name                text not null,
//     designation         text,
//     date                text not null,           -- "YYYY-MM-DD"
//     "checkIn"           text,                    -- "HH:MM:SS"
//     "checkInTimestamp"  timestamptz,
//     "checkOut"          text,
//     "checkOutTimestamp" timestamptz,
//     location            text,
//     lat                 double precision,
//     lng                 double precision,
//     "deviceId"          text,
//     created_at          timestamptz default now()
//   );
//
//   create table config (
//     id          int primary key default 1,        -- always a single row
//     data        jsonb not null default '{}'::jsonb
//   );
//
//   -- Row-level security: allow anon reads but no direct writes
//   -- (all writes go through this worker which validates the PIN)
//   alter table attendance enable row level security;
//   alter table config     enable row level security;
//   create policy "anon read attendance" on attendance for select using (true);
//   create policy "anon read config"     on config     for select using (true);
// ─────────────────────────────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    const cors = {
      'Access-Control-Allow-Origin':  '*',
      'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });

    const url      = new URL(request.url);
    const path     = url.pathname.replace(/\/$/, '');   // strip trailing slash
    const supa     = env.SUPABASE_URL;
    const anonKey  = env.SUPABASE_ANON_KEY;

    // ── helpers ───────────────────────────────────────────────────────────────
    const supaHeaders = {
      'apikey':        anonKey,
      'Authorization': 'Bearer ' + anonKey,
      'Content-Type':  'application/json',
      'Prefer':        'return=representation',
    };

    function ok(data, status = 200) {
      return new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json', ...cors },
      });
    }
    function err(msg, status = 400) {
      return new Response(JSON.stringify({ error: msg }), {
        status,
        headers: { 'Content-Type': 'application/json', ...cors },
      });
    }
    async function supaFetch(endpoint, options = {}) {
      const r = await fetch(supa + '/rest/v1/' + endpoint, {
        ...options,
        headers: { ...supaHeaders, ...(options.headers || {}) },
      });
      const text = await r.text();
      let data;
      try { data = JSON.parse(text); } catch { data = text; }
      return { ok: r.ok, status: r.status, data };
    }
    function checkPin(body) {
      if (!env.ADMIN_PIN) return 'ADMIN_PIN secret not configured';
      if (!body || body.adminPin !== env.ADMIN_PIN) return 'Incorrect PIN';
      return null;
    }
    function stripPin(body) {
      const { adminPin, ...rest } = body;
      return rest;
    }

    // ── POST /verify-pin ──────────────────────────────────────────────────────
    if (request.method === 'POST' && path.endsWith('/verify-pin')) {
      let body;
      try { body = await request.json(); } catch { return err('Bad JSON'); }
      if (!env.ADMIN_PIN) return err('ADMIN_PIN secret not configured', 500);
      return body.adminPin === env.ADMIN_PIN
        ? ok({ ok: true })
        : err('Incorrect PIN', 403);
    }

    // ── GET /config ───────────────────────────────────────────────────────────
    if (request.method === 'GET' && path.endsWith('/config')) {
      const { ok: isOk, data } = await supaFetch('config?id=eq.1&select=data');
      if (!isOk) return err('Failed to fetch config', 502);
      const row = Array.isArray(data) ? data[0] : null;
      if (!row) return err('Config not found', 404);
      return ok(row.data);
    }

    // ── GET /attendance ───────────────────────────────────────────────────────
    if (request.method === 'GET' && path.endsWith('/attendance')) {
      // Return all rows ordered by check-in time
      const { ok: isOk, data } = await supaFetch(
        'attendance?select=*&order=checkInTimestamp.asc.nullslast'
      );
      if (!isOk) return err('Failed to fetch attendance', 502);
      return ok(data);
    }

    // ── POST /attendance  (employee self check-in, no PIN) ────────────────────
    if (request.method === 'POST' && path.endsWith('/attendance')) {
      let body;
      try { body = await request.json(); } catch { return err('Bad JSON'); }
      const { ok: isOk, data, status } = await supaFetch('attendance', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      if (!isOk) return err(data?.message || 'Insert failed', status);
      return ok(Array.isArray(data) ? data[0] : data, 201);
    }

    // ── POST /attendance/admin  (admin check-in via QR, requires PIN) ─────────
    if (request.method === 'POST' && path.endsWith('/attendance/admin')) {
      let body;
      try { body = await request.json(); } catch { return err('Bad JSON'); }
      const pinErr = checkPin(body);
      if (pinErr) return err(pinErr, 403);
      const { ok: isOk, data, status } = await supaFetch('attendance', {
        method: 'POST',
        body: JSON.stringify(stripPin(body)),
      });
      if (!isOk) return err(data?.message || 'Insert failed', status);
      return ok(Array.isArray(data) ? data[0] : data, 201);
    }

    // ── PATCH /attendance/:id  (employee check-out, no PIN) ───────────────────
    const patchMatch = path.match(/\/attendance\/([0-9a-f-]{36})$/);
    if (request.method === 'PATCH' && patchMatch) {
      const id = patchMatch[1];
      let body;
      try { body = await request.json(); } catch { return err('Bad JSON'); }
      const { ok: isOk, data, status } = await supaFetch(
        'attendance?id=eq.' + id, {
          method: 'PATCH',
          body: JSON.stringify(body),
        }
      );
      if (!isOk) return err(data?.message || 'Update failed', status);
      return ok(Array.isArray(data) ? data[0] : data);
    }

    // ── PATCH /attendance/admin/:id  (admin check-out, requires PIN) ──────────
    const adminPatchMatch = path.match(/\/attendance\/admin\/([0-9a-f-]{36})$/);
    if (request.method === 'PATCH' && adminPatchMatch) {
      const id = adminPatchMatch[1];
      let body;
      try { body = await request.json(); } catch { return err('Bad JSON'); }
      const pinErr = checkPin(body);
      if (pinErr) return err(pinErr, 403);
      const { ok: isOk, data, status } = await supaFetch(
        'attendance?id=eq.' + id, {
          method: 'PATCH',
          body: JSON.stringify(stripPin(body)),
        }
      );
      if (!isOk) return err(data?.message || 'Update failed', status);
      return ok(Array.isArray(data) ? data[0] : data);
    }

    return new Response('Not found', { status: 404, headers: cors });
  },
};
