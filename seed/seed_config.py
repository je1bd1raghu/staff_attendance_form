#!/usr/bin/env python3
"""
seed_config.py
--------------
Interactive two-way sync between local files and the Supabase backend.

  • Config        push  local config.json  → server   (upsert into `config`, id=1)
                  pull  server             → local config.json
  • Attendance    push  local CSV          → server   (upsert into `attendance`)
                  pull  server             → local CSV

Run with no arguments for an interactive menu (it will prompt for the URL/key
and the action). All prompts have sensible defaults, and any destructive write
to a local file or the server asks for confirmation first.

Writes (push) need the Supabase SERVICE ROLE key, because RLS only allows anon
to SELECT. Reads (pull) work with either key. Get the key from the Supabase
dashboard → Settings → API → service_role.

Requirements:
    pip install requests --break-system-packages

Usage:
    # Fully interactive — prompts for everything:
    python seed_config.py

    # Provide credentials up front, still shows the action menu:
    python seed_config.py --url https://xxxx.supabase.co --key SERVICE_ROLE_KEY

    # Run one action and exit (no menu):
    python seed_config.py --url ... --key ... --action push-config
    python seed_config.py --url ... --key ... --action pull-config        --config config.json
    python seed_config.py --url ... --key ... --action push-attendance    --attendance att.csv
    python seed_config.py --url ... --key ... --action pull-attendance    --attendance att.csv
"""

import argparse
import csv
import getpass
import json
import os
import sys
import requests

# Full attendance columns (matches the Supabase table + app.js CSV_COLS,
# with id/created_at so a pulled CSV can be pushed straight back).
ATT_COLS = [
    "id", "employeeId", "name", "designation", "date",
    "checkIn", "checkInTimestamp", "checkOut", "checkOutTimestamp",
    "location", "lat", "lng", "deviceId", "created_at",
]
BATCH = 500  # Supabase insert limit per request


# ── small prompt helpers ────────────────────────────────────────────────────────
def ask(prompt, default=None):
    suffix = f" [{default}]" if default else ""
    val = input(f"{prompt}{suffix}: ").strip()
    return val or (default or "")


def confirm(prompt):
    return input(f"{prompt} (y/N): ").strip().lower() in ("y", "yes")


def get_credentials(args):
    """Resolve URL + service-role key from args, prompting for whatever is missing."""
    url = args.url or ask("Supabase project URL (https://xxxx.supabase.co)")
    if not url:
        sys.exit("A Supabase URL is required.")
    key = args.key
    if not key:
        key = getpass.getpass("Supabase service_role key (input hidden): ").strip()
    if not key:
        sys.exit("A Supabase key is required.")
    base = url.rstrip("/")
    headers = {
        "apikey":        key,
        "Authorization": f"Bearer {key}",
        "Content-Type":  "application/json",
    }
    return base, headers


def clean_row(row):
    """Strip whitespace; turn empty strings into None so they become SQL NULLs."""
    return {k: (v.strip() if isinstance(v, str) and v.strip() != "" else None)
            for k, v in row.items()}


# ── CONFIG ──────────────────────────────────────────────────────────────────────
def push_config(base, headers, path):
    print(f"\nReading {path} …")
    try:
        with open(path, "r", encoding="utf-8") as f:
            config_data = json.load(f)
    except FileNotFoundError:
        print(f"❌  {path} not found.")
        return
    except json.JSONDecodeError as e:
        print(f"❌  Invalid JSON in {path}: {e}")
        return

    est = len(config_data.get("establishments", []))
    emp = len(config_data.get("employees", []))
    loc = len(config_data.get("locations", []))
    print(f"  {est} establishments, {emp} employees, {loc} locations.")
    if not confirm("Push this config to the server (overwrites config id=1)?"):
        print("Skipped.")
        return

    r = requests.post(
        f"{base}/rest/v1/config",
        headers={**headers, "Prefer": "resolution=merge-duplicates"},
        json={"id": 1, "data": config_data},
    )
    if r.ok:
        print("✅  Config pushed → config table (id=1)")
    else:
        print(f"❌  Config push failed: {r.status_code} {r.text}")


def pull_config(base, headers, path):
    print("\nFetching config from server …")
    r = requests.get(
        f"{base}/rest/v1/config",
        headers=headers,
        params={"id": "eq.1", "select": "data"},
    )
    if not r.ok:
        print(f"❌  Config read failed: {r.status_code} {r.text}")
        return
    rows = r.json()
    if not rows:
        print("❌  No config row (id=1) found on the server.")
        return
    config_data = rows[0].get("data", {})
    est = len(config_data.get("establishments", []))
    emp = len(config_data.get("employees", []))
    loc = len(config_data.get("locations", []))
    print(f"  Server has {est} establishments, {emp} employees, {loc} locations.")

    if os.path.exists(path) and not confirm(f"{path} exists — overwrite it?"):
        print("Skipped.")
        return
    with open(path, "w", encoding="utf-8") as f:
        json.dump(config_data, f, indent=2, ensure_ascii=False)
        f.write("\n")
    print(f"✅  Config pulled → {path}")


# ── ATTENDANCE ──────────────────────────────────────────────────────────────────
def count_attendance(base, headers):
    r = requests.get(
        f"{base}/rest/v1/attendance",
        headers={**headers, "Prefer": "count=exact", "Range": "0-0"},
        params={"select": "id"},
    )
    if not r.ok:
        return None
    try:
        return int(r.headers.get("Content-Range", "*/0").split("/")[-1])
    except ValueError:
        return 0


def push_attendance(base, headers, path):
    print(f"\nReading {path} …")
    try:
        with open(path, "r", encoding="utf-8") as f:
            rows = [clean_row(r) for r in csv.DictReader(f)]
    except FileNotFoundError:
        print(f"❌  {path} not found.")
        return
    if not rows:
        print("  No rows found in CSV — nothing to push.")
        return

    has_ids = all(r.get("id") for r in rows)
    mode = "upsert (match on id)" if has_ids else "insert (new rows)"
    print(f"  {len(rows)} attendance row(s) to push — {mode}.")
    if not confirm("Push these rows to the server?"):
        print("Skipped.")
        return

    # When every row carries an id, upsert so re-pushing a pulled CSV updates
    # in place instead of duplicating. Otherwise insert fresh rows.
    prefer = "resolution=merge-duplicates" if has_ids else "return=minimal"
    params = {"on_conflict": "id"} if has_ids else None

    pushed = 0
    for i in range(0, len(rows), BATCH):
        batch = rows[i:i + BATCH]
        r = requests.post(
            f"{base}/rest/v1/attendance",
            headers={**headers, "Prefer": prefer},
            params=params,
            json=batch,
        )
        if r.ok:
            pushed += len(batch)
            print(f"  Pushed rows {i + 1}–{min(i + BATCH, len(rows))} ✓")
        else:
            print(f"  ❌ Batch {i // BATCH + 1} failed: {r.status_code} {r.text}")
            return
    print(f"✅  {pushed} attendance row(s) pushed.")


def pull_attendance(base, headers, path):
    total = count_attendance(base, headers)
    if total is None:
        print("❌  Could not read the attendance table.")
        return
    print(f"\nServer has {total} attendance row(s).")
    if total == 0:
        print("Nothing to pull.")
        return
    if os.path.exists(path) and not confirm(f"{path} exists — overwrite it?"):
        print("Skipped.")
        return

    r = requests.get(
        f"{base}/rest/v1/attendance",
        headers=headers,
        params={"select": "*", "order": "checkInTimestamp.asc.nullslast"},
    )
    if not r.ok:
        print(f"❌  Attendance read failed: {r.status_code} {r.text}")
        return
    rows = r.json()
    with open(path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=ATT_COLS, extrasaction="ignore")
        writer.writeheader()
        for row in rows:
            writer.writerow(row)
    print(f"✅  {len(rows)} attendance row(s) pulled → {path}")


# ── MENU ────────────────────────────────────────────────────────────────────────
ACTIONS = {
    "push-config":     ("Push config      (local JSON → server)", lambda b, h, a: push_config(b, h, a.config)),
    "pull-config":     ("Pull config      (server → local JSON)", lambda b, h, a: pull_config(b, h, a.config)),
    "push-attendance": ("Push attendance  (local CSV  → server)", lambda b, h, a: push_attendance(b, h, a.attendance)),
    "pull-attendance": ("Pull attendance  (server → local CSV )", lambda b, h, a: pull_attendance(b, h, a.attendance)),
}
MENU_ORDER = ["push-config", "pull-config", "push-attendance", "pull-attendance"]


def run_menu(base, headers, args):
    while True:
        print("\n── Attendance sync ─────────────────────────────")
        for i, key in enumerate(MENU_ORDER, 1):
            print(f"  {i}. {ACTIONS[key][0]}")
        print("  q. Quit")
        choice = input("Choose an option: ").strip().lower()
        if choice in ("q", "quit", "exit", ""):
            print("Bye.")
            return
        if choice.isdigit() and 1 <= int(choice) <= len(MENU_ORDER):
            ACTIONS[MENU_ORDER[int(choice) - 1]][1](base, headers, args)
        elif choice in ACTIONS:
            ACTIONS[choice][1](base, headers, args)
        else:
            print("  Not a valid option.")


def main():
    ap = argparse.ArgumentParser(description="Interactive push/pull for Supabase config + attendance.")
    ap.add_argument("--url",        default=None, help="Supabase project URL (prompted if omitted)")
    ap.add_argument("--key",        default=None, help="Supabase service_role key (prompted if omitted)")
    ap.add_argument("--config",     default="config.json", help="Local config JSON path (default: config.json)")
    ap.add_argument("--attendance", default="attendance.csv", help="Local attendance CSV path (default: attendance.csv)")
    ap.add_argument("--action", choices=list(ACTIONS), default=None,
                    help="Run one action and exit instead of showing the menu.")
    args = ap.parse_args()

    base, headers = get_credentials(args)

    if args.action:
        ACTIONS[args.action][1](base, headers, args)
    else:
        run_menu(base, headers, args)


if __name__ == "__main__":
    main()
