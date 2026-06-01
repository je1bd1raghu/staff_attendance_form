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

```python
pip install requests --break-system-packages

# Seed config only
python seed_config.py \
  --url https://xxxx.supabase.co \
  --key YOUR_SERVICE_ROLE_KEY

# Seed config + migrate old attendance CSV
python seed_config.py \
  --url https://xxxx.supabase.co \
  --key YOUR_SERVICE_ROLE_KEY \
  --attendance attendance_records_2025-06-01.csv
```

> 

**Step 4 — Set Worker secrets**:

```python
wrangler secret put SUPABASE_URL       # https://xxxx.supabase.co
wrangler secret put SUPABASE_ANON_KEY  # your anon key
wrangler secret put ADMIN_PIN
```
