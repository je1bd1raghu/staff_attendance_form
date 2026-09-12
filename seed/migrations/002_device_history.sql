-- 002_device_history.sql
-- Device lineage: one row per durable deviceToken, tracking every fingerprint
-- and linked token that device has presented. Populated by the worker on every
-- self check-in/check-out (recordDeviceIdentity in worker.js) so check-out
-- ownership survives a full storage wipe (new token) or gradual fingerprint
-- drift (browser/OS updates). Genuinely new devices have no row and fall back
-- to admin-assisted recovery.
--
-- Run with:  python seed_config.py --action migrate
-- (or paste into the Supabase SQL editor)

create table if not exists devices (
  device_token   text primary key,
  fingerprints   text[] not null default '{}',
  linked_tokens  text[] not null default '{}',
  first_seen     timestamptz not null default now(),
  last_seen      timestamptz not null default now()
);

-- Only the worker (service_role, bypasses RLS) reads/writes this table. No anon
-- policy is created, so direct anonymous access is denied.
alter table devices enable row level security;