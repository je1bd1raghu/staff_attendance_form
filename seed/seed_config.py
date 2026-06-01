#!/usr/bin/env python3
"""
seed_config.py
--------------
Reads config.json and upserts it into the Supabase `config` table.
Also optionally seeds attendance from a CSV file.

Requirements:
    pip install requests --break-system-packages

Usage:
    python seed_config.py --url https://xxxx.supabase.co --key YOUR_SERVICE_ROLE_KEY
    python seed_config.py --url https://xxxx.supabase.co --key YOUR_SERVICE_ROLE_KEY --config path/to/config.json
    python seed_config.py --url https://xxxx.supabase.co --key YOUR_SERVICE_ROLE_KEY --attendance attendance.csv
"""

import argparse
import csv
import json
import sys
import requests

def main():
    ap = argparse.ArgumentParser(description="Seed Supabase from local files.")
    ap.add_argument("--url",        required=True, help="Supabase project URL, e.g. https://xxxx.supabase.co")
    ap.add_argument("--key",        required=True, help="Supabase service role key (Settings → API)")
    ap.add_argument("--config",     default="config.json",   help="Path to config.json (default: config.json)")
    ap.add_argument("--attendance", default=None,            help="Path to attendance CSV to migrate (optional)")
    args = ap.parse_args()

    base    = args.url.rstrip("/")
    headers = {
        "apikey":        args.key,
        "Authorization": f"Bearer {args.key}",
        "Content-Type":  "application/json",
        "Prefer":        "resolution=merge-duplicates",   # upsert
    }

    # ── Seed config ───────────────────────────────────────────────────────────
    print(f"Reading {args.config} …")
    try:
        with open(args.config, "r", encoding="utf-8") as f:
            config_data = json.load(f)
    except FileNotFoundError:
        sys.exit(f"ERROR: {args.config} not found.")
    except json.JSONDecodeError as e:
        sys.exit(f"ERROR: Invalid JSON in {args.config}: {e}")

    emp_count = len(config_data.get("employees", []))
    loc_count = len(config_data.get("locations", []))
    print(f"  {emp_count} employees, {loc_count} locations.")

    # Upsert into config table (id=1 is always the single config row)
    r = requests.post(
        f"{base}/rest/v1/config",
        headers=headers,
        json={"id": 1, "data": config_data},
    )
    if r.ok:
        print(f"✅  Config upserted → config table (id=1)")
    else:
        print(f"❌  Config upsert failed: {r.status_code} {r.text}")
        sys.exit(1)

    # ── Seed attendance (optional) ────────────────────────────────────────────
    if args.attendance:
        print(f"\nReading {args.attendance} …")
        try:
            with open(args.attendance, "r", encoding="utf-8") as f:
                reader = csv.DictReader(f)
                rows = [dict(r) for r in reader]
        except FileNotFoundError:
            sys.exit(f"ERROR: {args.attendance} not found.")

        if not rows:
            print("  No rows found in CSV — skipping.")
        else:
            print(f"  {len(rows)} attendance rows to insert.")
            # Clean rows: replace empty strings with None, strip whitespace
            cleaned = []
            for row in rows:
                cleaned.append({
                    k: (v.strip() if v.strip() != "" else None)
                    for k, v in row.items()
                })

            # Insert in batches of 500 (Supabase limit)
            BATCH = 500
            inserted = 0
            for i in range(0, len(cleaned), BATCH):
                batch = cleaned[i:i + BATCH]
                r = requests.post(
                    f"{base}/rest/v1/attendance",
                    headers={**headers, "Prefer": "return=minimal"},
                    json=batch,
                )
                if r.ok:
                    inserted += len(batch)
                    print(f"  Inserted rows {i+1}–{min(i+BATCH, len(cleaned))} ✓")
                else:
                    print(f"  ❌ Batch {i//BATCH + 1} failed: {r.status_code} {r.text}")
                    sys.exit(1)
            print(f"✅  {inserted} attendance rows inserted.")

    print("\nDone.")

if __name__ == "__main__":
    main()
