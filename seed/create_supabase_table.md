**Step 1 — Create Supabase tables (run in Supabase SQL editor):**

```sql
create table attendance (
  id                  uuid primary key default gen_random_uuid(),
  "employeeId"        text not null,
  name                text not null,
  designation         text,
  date                text not null,
  "checkIn"           text,
  "checkInTimestamp"  timestamptz,
  "checkOut"          text,
  "checkOutTimestamp" timestamptz,
  location            text,
  lat                 double precision,
  lng                 double precision,
  "deviceId"          text,
  created_at          timestamptz default now()
);

create table config (
  id   int primary key default 1,
  data jsonb not null default '{}'::jsonb
);

alter table attendance enable row level security;
alter table config     enable row level security;
create policy "anon read attendance" on attendance for select using (true);
create policy "anon read config"     on config     for select using (true);
```

**Step 2 — Seed config**

The config JSON has three top-level arrays — see `config.example.json` for a
ready-to-edit template:

- `establishments` — the sites/organisations staff belong to. Each: `id`, `name`,
  and an optional `image` for the card's background photo. This can be a full
  `https://…` URL or a relative path to a file shipped alongside `index.html`
  (e.g. `images/head-office.jpg` — see `images/README.md`). Cards fall back to a
  slate gradient when omitted. Staff first pick their establishment in the app,
  which then unlocks the name picker filtered to that establishment.
- `employees` — each links to an establishment via `establishmentId` and to its
  allowed duty areas via `locationIds`.
- `locations` — duty areas with `lat`, `lng`, and `tolerance` (metres).

> If `establishments` is omitted or empty, the app falls back to the original
> single-step flow (name picker shown directly, full roster).

`seed_config.py` is an interactive two-way sync. Run it with no arguments and it
prompts for the Supabase URL/key, then shows a menu to **push/pull config** and
**push/pull attendance** to and from the server.

```python
pip install requests --break-system-packages

# Interactive menu (prompts for URL + service_role key, then the action):
python seed_config.py

# Provide credentials up front, still shows the menu:
python seed_config.py --url https://xxxx.supabase.co --key YOUR_SERVICE_ROLE_KEY

# Run one action and exit (no menu):
python seed_config.py --url ... --key ... --action push-config
python seed_config.py --url ... --key ... --action pull-config     --config config.json
python seed_config.py --url ... --key ... --action pull-attendance --attendance attendance.csv
python seed_config.py --url ... --key ... --action push-attendance --attendance attendance.csv
```

- **Pull** writes the server's data to local files (config → JSON, attendance →
  CSV with `id`/`created_at`), asking before overwriting an existing file.
- **Push** uploads local files: config upserts row id=1; attendance upserts on
  `id` when the CSV carries ids (so re-pushing a pulled CSV updates in place)
  and inserts fresh rows otherwise. Writes need the **service_role** key.

> 

**Step 4 — Set Worker secrets**:

```python
wrangler secret put SUPABASE_URL       # https://xxxx.supabase.co
wrangler secret put SUPABASE_ANON_KEY  # your anon key
wrangler secret put ADMIN_PIN
```
