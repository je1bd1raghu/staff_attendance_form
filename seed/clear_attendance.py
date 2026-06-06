#!/usr/bin/env python3
"""
clear_attendance.py
-------------------
Deletes ALL rows from the Supabase `attendance` table — i.e. clears the
attendance records database completely. This is irreversible.

NOTE: There is no "records.json" and Cloudflare/wrangler stores nothing.
The records live in Supabase; wrangler only deploys the worker. This script
talks to the Supabase REST API directly.

The attendance table has RLS enabled (anon can only SELECT), so deleting
requires the SERVICE ROLE key, which bypasses RLS. Use the same key you use
for seed_config.py (Supabase dashboard → Settings → API → service_role).

Requirements:
    pip install requests --break-system-packages

Usage:
    # Interactive (asks for confirmation):
    python clear_attendance.py --url https://xxxx.supabase.co --key SERVICE_ROLE_KEY

    # Back up to CSV first, then clear:
    python clear_attendance.py --url https://xxxx.supabase.co --key SERVICE_ROLE_KEY \
        --backup attendance_backup.csv

    # Skip the confirmation prompt (for scripts/automation):
    python clear_attendance.py --url https://xxxx.supabase.co --key SERVICE_ROLE_KEY --yes
"""

import argparse
import csv
import sys
import requests

# Columns in CSV order (matches CSV_COLS in app.js + id/created_at).
CSV_COLS = [
    "id", "employeeId", "name", "designation", "date",
    "checkIn", "checkInTimestamp", "checkOut", "checkOutTimestamp",
    "location", "lat", "lng", "deviceId", "created_at",
]


def main():
    ap = argparse.ArgumentParser(description="Clear ALL rows from the Supabase attendance table.")
    ap.add_argument("--url",    required=True, help="Supabase project URL, e.g. https://xxxx.supabase.co")
    ap.add_argument("--key",    required=True, help="Supabase SERVICE ROLE key (Settings → API). Required — RLS blocks anon deletes.")
    ap.add_argument("--backup", default=None,  help="Optional: path to write a CSV backup of all rows before deleting.")
    ap.add_argument("--yes",    action="store_true", help="Skip the confirmation prompt.")
    args = ap.parse_args()

    base    = args.url.rstrip("/")
    headers = {
        "apikey":        args.key,
        "Authorization": f"Bearer {args.key}",
        "Content-Type":  "application/json",
    }

    # ── 1. Count current rows ─────────────────────────────────────────────────
    # Prefer: count=exact returns the total in the Content-Range header.
    r = requests.get(
        f"{base}/rest/v1/attendance",
        headers={**headers, "Prefer": "count=exact", "Range": "0-0"},
        params={"select": "id"},
    )
    if not r.ok:
        sys.exit(f"❌  Could not read attendance table: {r.status_code} {r.text}")
    # Content-Range looks like "0-0/123" — the part after "/" is the total.
    content_range = r.headers.get("Content-Range", "*/0")
    try:
        total = int(content_range.split("/")[-1])
    except ValueError:
        total = 0

    print(f"Attendance table currently has {total} row(s).")
    if total == 0:
        print("Nothing to delete. Done.")
        return

    # ── 2. Optional CSV backup ────────────────────────────────────────────────
    if args.backup:
        print(f"Backing up {total} row(s) to {args.backup} …")
        rb = requests.get(
            f"{base}/rest/v1/attendance",
            headers=headers,
            params={"select": "*", "order": "checkInTimestamp.asc.nullslast"},
        )
        if not rb.ok:
            sys.exit(f"❌  Backup read failed: {rb.status_code} {rb.text}")
        rows = rb.json()
        with open(args.backup, "w", newline="", encoding="utf-8") as f:
            writer = csv.DictWriter(f, fieldnames=CSV_COLS, extrasaction="ignore")
            writer.writeheader()
            for row in rows:
                writer.writerow(row)
        print(f"✅  Backup written: {args.backup} ({len(rows)} rows)")

    # ── 3. Confirm ────────────────────────────────────────────────────────────
    if not args.yes:
        print(f"\n⚠️  This will PERMANENTLY DELETE all {total} attendance record(s). This cannot be undone.")
        answer = input('Type "DELETE" to confirm: ').strip()
        if answer != "DELETE":
            sys.exit("Aborted — no rows were deleted.")

    # ── 4. Delete all rows ────────────────────────────────────────────────────
    # PostgREST refuses an unfiltered DELETE, so id=not.is.null matches every
    # row (id is the NOT NULL uuid primary key). return=representation lets us
    # count exactly how many were removed.
    rd = requests.delete(
        f"{base}/rest/v1/attendance",
        headers={**headers, "Prefer": "return=representation"},
        params={"id": "not.is.null"},
    )
    if not rd.ok:
        sys.exit(f"❌  Delete failed: {rd.status_code} {rd.text}")

    try:
        deleted = len(rd.json())
    except ValueError:
        deleted = total
    print(f"✅  Deleted {deleted} attendance row(s). Table is now empty.")


if __name__ == "__main__":
    main()
