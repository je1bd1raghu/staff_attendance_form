#!/usr/bin/env python3
"""
clear_attendance.py
-------------------
Deletes rows from the Supabase `attendance` table.

By default, ALL rows are deleted. Use --days and/or --incomplete-only to
delete a subset.

NOTE: There is no "records.json" and Cloudflare/wrangler stores nothing.
The records live in Supabase; wrangler only deploys the worker. This script
talks to the Supabase REST API directly.

The attendance table has RLS enabled (anon can only SELECT), so deleting
requires the SERVICE ROLE key, which bypasses RLS. Use the same key you use
for seed_config.py (Supabase dashboard → Settings → API → service_role).

Requirements:
    pip install requests --break-system-packages

Usage:
    # Delete ALL rows (interactive, with confirmation):
    python clear_attendance.py --url https://xxxx.supabase.co --key SERVICE_ROLE_KEY

    # Delete rows older than 30 days:
    python clear_attendance.py --url https://xxxx.supabase.co --key SERVICE_ROLE_KEY --days 30

    # Delete only incomplete records (checkOut is null):
    python clear_attendance.py --url https://xxxx.supabase.co --key SERVICE_ROLE_KEY \
        --incomplete-only

    # Delete incomplete records older than 7 days (combined filters):
    python clear_attendance.py --url https://xxxx.supabase.co --key SERVICE_ROLE_KEY \
        --days 7 --incomplete-only

    # Auto-named backup, then clear:
    python clear_attendance.py --url https://xxxx.supabase.co --key SERVICE_ROLE_KEY --backup

    # Custom path backup, then clear:
    python clear_attendance.py --url https://xxxx.supabase.co --key SERVICE_ROLE_KEY \
        --backup attendance_backup.csv

    # Skip the confirmation prompt (for scripts/automation):
    python clear_attendance.py --url https://xxxx.supabase.co --key SERVICE_ROLE_KEY --yes
"""

import argparse
import csv
import sys
from datetime import datetime, timedelta

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
    ap.add_argument("--backup", nargs="?", const="auto", default=None,
                    help="Write a CSV backup before deleting. Pass a filename, or use --backup alone to auto-name.")
    ap.add_argument("--days",            type=int, default=None,
                    help="Delete only records older than N days (e.g. --days 30).")
    ap.add_argument("--incomplete-only", action="store_true",
                    help="Delete only records where checkOut is null (incomplete attendance).")
    ap.add_argument("--yes",             action="store_true",
                    help="Skip the confirmation prompt.")
    args = ap.parse_args()

    base    = args.url.rstrip("/")
    headers = {
        "apikey":        args.key,
        "Authorization": f"Bearer {args.key}",
        "Content-Type":  "application/json",
    }

    # ── Build PostgREST filters from CLI flags ────────────────────────────────
    filters = {}
    desc_parts = []
    if args.days is not None:
        cutoff = (datetime.now() - timedelta(days=args.days)).strftime("%Y-%m-%d")
        filters["date"] = f"lt.{cutoff}"
        desc_parts.append(f"older than {args.days} day(s) (before {cutoff})")
    if args.incomplete_only:
        filters["checkOut"] = "is.null"
        desc_parts.append("incomplete (checkOut is null)")

    desc = ", ".join(desc_parts) if desc_parts else "ALL"

    # ── 1. Count matching rows ────────────────────────────────────────────────
    params_count = {"select": "id", **filters} if filters else {"select": "id"}
    r = requests.get(
        f"{base}/rest/v1/attendance",
        headers={**headers, "Prefer": "count=exact", "Range": "0-0"},
        params=params_count,
    )
    if not r.ok:
        sys.exit(f"❌  Could not read attendance table: {r.status_code} {r.text}")
    # Content-Range looks like "0-0/123" — the part after "/" is the total.
    content_range = r.headers.get("Content-Range", "*/0")
    try:
        total = int(content_range.split("/")[-1])
    except ValueError:
        total = 0

    print(f"Matching rows: {total}  ({desc})")
    if total == 0:
        print("Nothing to delete. Done.")
        return

    # ── 2. Optional CSV backup ────────────────────────────────────────────────
    if args.backup:
        backup_path = (
            f"attendance_backup_{datetime.now().strftime('%Y%m%d_%H%M%S')}.csv"
            if args.backup == "auto" else args.backup
        )
        print(f"Backing up {total} row(s) to {backup_path} …")
        params_backup = {"select": "*", "order": "checkInTimestamp.asc.nullslast", **filters}
        rb = requests.get(
            f"{base}/rest/v1/attendance",
            headers=headers,
            params=params_backup,
        )
        if not rb.ok:
            sys.exit(f"❌  Backup read failed: {rb.status_code} {rb.text}")
        rows = rb.json()
        with open(backup_path, "w", newline="", encoding="utf-8") as f:
            writer = csv.DictWriter(f, fieldnames=CSV_COLS, extrasaction="ignore")
            writer.writeheader()
            for row in rows:
                writer.writerow(row)
        print(f"✅  Backup written: {backup_path} ({len(rows)} rows)")

    # ── 3. Confirm ────────────────────────────────────────────────────────────
    if not args.yes:
        print(f"\n⚠️  This will PERMANENTLY DELETE {total} matching attendance record(s) ({desc}). This cannot be undone.")
        answer = input('Type "DELETE" to confirm: ').strip()
        if answer != "DELETE":
            sys.exit("Aborted — no rows were deleted.")

    # ── 4. Delete matching rows ────────────────────────────────────────────────
    # PostgREST refuses an unfiltered DELETE, so fall back to id=not.is.null
    # when no specific filters are given. return=representation lets us count
    # exactly how many were removed.
    params_delete = filters if filters else {"id": "not.is.null"}
    rd = requests.delete(
        f"{base}/rest/v1/attendance",
        headers={**headers, "Prefer": "return=representation"},
        params=params_delete,
    )
    if not rd.ok:
        sys.exit(f"❌  Delete failed: {rd.status_code} {rd.text}")

    try:
        deleted = len(rd.json())
    except ValueError:
        deleted = total
    print(f"✅  Deleted {deleted} matching attendance row(s).")


if __name__ == "__main__":
    main()
