-- 001_device_token.sql
-- Durable device pass: lets check-out succeed when the fingerprint drifts
-- (e.g. after a browser update) by matching the stored token OR fingerprint.
--
-- Run with:  python seed_config.py --action migrate
-- (or paste into the Supabase SQL editor — Step 1b in create_supabase_table.md)

alter table attendance add column if not exists "deviceToken" text;
update attendance set "deviceToken" = "deviceId" where "deviceToken" is null;
