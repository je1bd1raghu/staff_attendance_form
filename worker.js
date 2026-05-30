// Cloudflare Worker — Attendance Proxy
// All GitHub credentials live in Cloudflare secrets — never in HTML or client JS.
//
// Secrets required (set via Cloudflare dashboard or `wrangler secret put`):
//   GITHUB_TOKEN   — personal access token with gist scope
//   GIST_ID        — attendance gist ID
//   CONFIG_GIST_ID — config gist ID
//   ADMIN_PIN      — admin PIN validated server-side
//
// Routes:
//   GET  /                           → proxy raw attendance CSV from GitHub
//   GET  /config                     → proxy raw config JSON from GitHub
//   POST /verify-pin  { adminPin }   → 200 OK | 403 Forbidden
//   PATCH /<gistId>   { files, [adminPin] } → proxy PATCH to GitHub (writes)

export default {
  async fetch(request, env) {
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, PATCH, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);

    // ── PIN verification ───────────────────────────────────────────────────────
    if (request.method === 'POST' && url.pathname.endsWith('/verify-pin')) {
      let body;
      try { body = await request.json(); } catch { return jsonResp({ error: 'Bad JSON' }, 400, corsHeaders); }
      if (!env.ADMIN_PIN) return jsonResp({ error: 'ADMIN_PIN secret not configured' }, 500, corsHeaders);
      return body.adminPin === env.ADMIN_PIN
        ? jsonResp({ ok: true }, 200, corsHeaders)
        : jsonResp({ error: 'Incorrect PIN' }, 403, corsHeaders);
    }

    // ── Read: attendance CSV ───────────────────────────────────────────────────
    if (request.method === 'GET' && url.pathname.endsWith('/attendance')) {
      return proxyGistRaw(env.GIST_ID, 'attendance.csv', env, corsHeaders);
    }

    // ── Read: config JSON ──────────────────────────────────────────────────────
    if (request.method === 'GET' && url.pathname.endsWith('/config')) {
      return proxyGistRaw(env.CONFIG_GIST_ID, 'config.json', env, corsHeaders);
    }

    // ── Write: PATCH attendance gist ───────────────────────────────────────────
    if (request.method === 'PATCH') {
      let body;
      try { body = await request.json(); } catch { return jsonResp({ error: 'Bad JSON' }, 400, corsHeaders); }

      // Validate PIN if present (admin writes)
      if ('adminPin' in body) {
        if (!env.ADMIN_PIN) return jsonResp({ error: 'ADMIN_PIN secret not configured' }, 500, corsHeaders);
        if (body.adminPin !== env.ADMIN_PIN) return jsonResp({ error: 'Incorrect PIN' }, 403, corsHeaders);
        delete body.adminPin; // strip before forwarding to GitHub
      }

      const resp = await fetch(`https://api.github.com/gists/${env.GIST_ID}`, {
        method: 'PATCH',
        headers: githubHeaders(env),
        body: JSON.stringify(body),
      });

      return new Response(await resp.text(), {
        status: resp.status,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }

    return new Response('Not allowed', { status: 405, headers: corsHeaders });
  },
};

async function proxyGistRaw(gistId, filename, env, corsHeaders) {
  const rawUrl = `https://gist.githubusercontent.com/raw/${gistId}/${filename}?t=${Date.now()}`;
  const resp = await fetch(rawUrl, { headers: githubHeaders(env) });
  const text = await resp.text();
  const ct   = filename.endsWith('.json') ? 'application/json' : 'text/plain';
  return new Response(text, {
    status: resp.status,
    headers: { 'Content-Type': ct, ...corsHeaders },
  });
}

function githubHeaders(env) {
  return {
    Authorization: `token ${env.GITHUB_TOKEN}`,
    Accept: 'application/vnd.github.v3+json',
    'User-Agent': 'attendance-worker',
  };
}

function jsonResp(data, status, corsHeaders) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  });
}
