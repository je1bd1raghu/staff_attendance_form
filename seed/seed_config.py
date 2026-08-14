#!/usr/bin/env python3
"""
seed_config.py
--------------
Toolkit for the Staff Attendance app: config/attendance sync to Supabase, plus
running the database migration and redeploying the Cloudflare Worker.

  • Config        push  local config.json  → server   (upsert into `config`, id=1)
                  pull  server             → local config.json
  • Attendance    push  local CSV          → server   (upsert into `attendance`)
                  pull  server             → local CSV
  • Migration     run migrations/*.sql through the Supabase Management API
                  (needs a Personal Access Token + project ref — see below)
  • Deploy        run `wrangler deploy` for the Cloudflare Worker
                  (no Supabase credentials needed)

Run with no arguments for an interactive menu (it will prompt for anything
missing). All prompts have sensible defaults, and any destructive write asks
for confirmation first (skip all of them with --yes).

Writes (push) need the Supabase SERVICE ROLE key, because RLS only allows anon
to SELECT. Reads (pull) work with either key. Get the key from the Supabase
dashboard → Settings → API → service_role.

The migration action needs a Supabase Personal Access Token (dashboard →
Account → Access Tokens) plus the project ref. The ref is auto-derived from the
Supabase URL when possible, and the token can be provided up front with
--sb-token or the SUPABASE_ACCESS_TOKEN environment variable.

Requirements:
    pip install requests --break-system-packages
    npm i -g wrangler        # only needed for the deploy action

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

    # Run the deviceToken migration (ref auto-derived from --url):
    python seed_config.py --action migrate --url https://xxxx.supabase.co \
                          --sb-token SUPABASE_PAT

    # Redeploy the worker — no Supabase credentials needed:
    python seed_config.py --action deploy
    python seed_config.py --action deploy --wrangler-args --env production

    # Non-interactive: skip every confirmation prompt:
    python seed_config.py --yes --action push-config --url ... --key ...
"""

import argparse
import csv
import getpass
import json
import os
import re
import shlex
import subprocess
import sys
from pathlib import Path
import requests

# Script lives in seed/; the Worker project is one level up (wrangler.toml).
SCRIPT_DIR   = Path(__file__).resolve().parent
PROJECT_ROOT = SCRIPT_DIR.parent
MANAGEMENT_API = "https://api.supabase.com"

# Full attendance columns (matches the Supabase table + app.js CSV_COLS,
# with id/created_at so a pulled CSV can be pushed straight back).
ATT_COLS = [
    "id", "employeeId", "name", "designation", "date",
    "checkIn", "checkInTimestamp", "checkOut", "checkOutTimestamp",
    "location", "lat", "lng", "deviceId", "deviceToken", "created_at",
]
BATCH = 500  # Supabase insert limit per request


# ── small prompt helpers ────────────────────────────────────────────────────────
CONFIRM_ALL = False  # set by --yes; skips every confirmation prompt


def ask(prompt, default=None):
    suffix = f" [{default}]" if default else ""
    val = input(f"{prompt}{suffix}: ").strip()
    return val or (default or "")


def confirm(prompt):
    if CONFIRM_ALL:
        return True
    return input(f"{prompt} (y/N): ").strip().lower() in ("y", "yes")


def get_credentials(args, optional=False):
    """Resolve URL + service-role key from args, prompting for whatever is missing.

    With optional=True, missing credentials are returned as None instead of
    prompting — used by actions (e.g. migrate) that can work from just a ref and
    a Personal Access Token."""
    url = (args.url or "").strip()
    if optional and not url:
        return None, None
    if not url:
        url = ask("Supabase project URL (https://xxxx.supabase.co)")
        if not url:
            sys.exit("A Supabase URL is required.")
    key = (args.key or "").strip()
    if optional:
        if not key:
            return url.rstrip("/"), None
    else:
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


def req(method, url, **kwargs):
    """requests call that never raises — on a network error prints a friendly
    message and returns None (callers treat None as 'give up')."""
    kwargs.setdefault("timeout", 30)
    try:
        return requests.request(method, url, **kwargs)
    except requests.RequestException as e:
        print(f"❌  Could not reach {url} — check the URL and your connection. ({type(e).__name__})")
        return None


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

    r = req("POST", f"{base}/rest/v1/config",
            headers={**headers, "Prefer": "resolution=merge-duplicates"},
            json={"id": 1, "data": config_data})
    if r is None:
        return
    if r.ok:
        print("✅  Config pushed → config table (id=1)")
    else:
        print(f"❌  Config push failed: {r.status_code} {r.text}")


def pull_config(base, headers, path):
    print("\nFetching config from server …")
    r = req("GET", f"{base}/rest/v1/config",
            headers=headers,
            params={"id": "eq.1", "select": "data"})
    if r is None:
        return
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
    r = req("GET", f"{base}/rest/v1/attendance",
            headers={**headers, "Prefer": "count=exact", "Range": "0-0"},
            params={"select": "id"})
    if r is None or not r.ok:
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
        r = req("POST", f"{base}/rest/v1/attendance",
                headers={**headers, "Prefer": prefer},
                params=params,
                json=batch)
        if r is None:
            return
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

    r = req("GET", f"{base}/rest/v1/attendance",
            headers=headers,
            params={"select": "*", "order": "checkInTimestamp.asc.nullslast"})
    if r is None:
        return
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


# ── MIGRATION + DEPLOY ──────────────────────────────────────────────────────────
def derive_ref(url):
    """Pull the project ref out of a Supabase URL: https://xxxx.supabase.co → xxxx."""
    m = re.search(r"https?://([^.]+)\.supabase\.co", url or "")
    return m.group(1) if m else None


def column_present(base, headers, column):
    """Check whether `column` exists on the attendance table. Returns
    True/False, or None when it can't be determined (no creds, network error, etc.)."""
    if not base or not headers:
        return None
    try:
        r = requests.get(
            f"{base}/rest/v1/attendance",
            headers=headers,
            params={"select": column, "limit": 1},
            timeout=15,
        )
    except requests.RequestException:
        return None
    if r.ok:
        return True
    if r.status_code == 400:
        return False
    return None


def pick_migrations(args):
    """Explicit --migration file, or every *.sql in seed/migrations/ in order."""
    if args.migration:
        p = Path(args.migration)
        if not p.is_absolute():
            for c in (SCRIPT_DIR / p, PROJECT_ROOT / p):
                if c.is_file():
                    return [c]
            sys.exit(f"❌  Migration file not found: {p} (looked in seed/ and project root)")
        if p.is_file():
            return [p]
        sys.exit(f"❌  Migration file not found: {p}")
    mig_dir = SCRIPT_DIR / "migrations"
    files = sorted(mig_dir.glob("*.sql")) if mig_dir.is_dir() else []
    if not files:
        sys.exit("❌  No migrations found in seed/migrations/. Pass --migration path/file.sql")
    return files


def run_migration(args):
    """Run migration SQL through the Supabase Management API.

    Credentials: project ref (--ref, or auto-derived from --url, or the
    SUPABASE_PROJECT_REF env var) + Personal Access Token (--sb-token, or the
    SUPABASE_ACCESS_TOKEN env var). The SQL itself is idempotent, so re-running
    is safe."""
    files = pick_migrations(args)

    url = (args.url or "").strip()
    ref = (args.ref or os.environ.get("SUPABASE_PROJECT_REF") or "").strip()
    if not ref:
        ref = derive_ref(url)
    if not ref:
        ref = ask("Supabase project ref (the xxxx in https://xxxx.supabase.co)")
    if not ref:
        sys.exit("A Supabase project ref is required (--ref).")

    token = (args.sb_token or os.environ.get("SUPABASE_ACCESS_TOKEN") or "").strip()
    if not token:
        token = getpass.getpass("Supabase Personal Access Token (input hidden): ").strip()
    if not token:
        sys.exit("A Supabase Personal Access Token is required (--sb-token).")

    print(f"\n  Project ref : {ref}")
    print("  Migrations  :")
    for f in files:
        print(f"    • {f.name}")
    if not confirm("Run the migration(s) against the Supabase database?"):
        print("Skipped.")
        return

    base, headers = get_credentials(args, optional=True)
    for f in files:
        sql = f.read_text(encoding="utf-8")
        m = re.search(r'add column\s+if not exists\s+"?(\w+)"?', sql)
        if m and base and headers:
            present = column_present(base, headers, m.group(1))
            if present:
                print(f"⏭  {f.name}: column '{m.group(1)}' already exists — nothing to do.")
                continue
            if present is False:
                print(f"  {f.name}: column '{m.group(1)}' missing — will add it.")
            else:
                print(f"  {f.name}: could not verify column (continuing anyway).")
        else:
            print(f"  {f.name}: running …")

        r = requests.post(
            f"{MANAGEMENT_API}/v1/projects/{ref}/database/query",
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
            json={"query": sql},
        )
        if r.ok:
            print(f"✅  {f.name}: ran successfully.")
        else:
            msg = {
                401: "401 — invalid access token (check --sb-token)",
                403: "403 — token cannot access this project",
                404: f"404 — project ref '{ref}' not found (check --ref)",
            }.get(r.status_code, f"{r.status_code}")
            print(f"❌  {f.name}: migration failed — {msg}")
            if r.text.strip():
                print(r.text[:500])
            return


def deploy_worker(args):
    """Run `wrangler deploy` for the Worker. Needs no Supabase credentials."""
    cmd = ["wrangler", "deploy"]
    if args.wrangler_args:
        cmd += shlex.split(args.wrangler_args)
    print(f"\n  Command : {' '.join(cmd)}")
    print(f"  Folder  : {PROJECT_ROOT}")
    if not confirm("Deploy the Worker now?"):
        print("Skipped.")
        return
    try:
        r = subprocess.run(cmd, cwd=PROJECT_ROOT)
    except FileNotFoundError:
        print("❌  'wrangler' not found — install it with:  npm i -g wrangler")
        return
    if r.returncode == 0:
        print("✅  Worker deployed.")
    else:
        print(f"❌  wrangler exited with code {r.returncode}.")


# ── MENU ────────────────────────────────────────────────────────────────────────
def ensure_creds(fn):
    """Wrap a sync action so it lazily grabs credentials if the menu never did
    (e.g. the user only came to deploy the Worker)."""
    def wrapped(base, headers, args):
        if not headers:
            base, headers = get_credentials(args)
        return fn(base, headers, args)
    return wrapped


ACTIONS = {
    "push-config":     ("Push config      (local JSON → server)", ensure_creds(lambda b, h, a: push_config(b, h, a.config))),
    "pull-config":     ("Pull config      (server → local JSON)", ensure_creds(lambda b, h, a: pull_config(b, h, a.config))),
    "push-attendance": ("Push attendance  (local CSV  → server)", ensure_creds(lambda b, h, a: push_attendance(b, h, a.attendance))),
    "pull-attendance": ("Pull attendance  (server → local CSV )", ensure_creds(lambda b, h, a: pull_attendance(b, h, a.attendance))),
    "migrate":         ("Run migrations   (Supabase SQL)",       lambda b, h, a: run_migration(a)),
    "deploy":          ("Deploy worker    (wrangler)",           lambda b, h, a: deploy_worker(a)),
}
MENU_ORDER = ["push-config", "pull-config", "push-attendance", "pull-attendance", "migrate", "deploy"]


def run_menu(base, headers, args):
    while True:
        print("\n── Staff Attendance toolkit ────────────────────")
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
    global CONFIRM_ALL
    ap = argparse.ArgumentParser(description="Sync Supabase config + attendance, run migrations, deploy the Worker.")
    ap.add_argument("--url",        default=None, help="Supabase project URL (prompted if omitted)")
    ap.add_argument("--key",        default=None, help="Supabase service_role key (prompted if omitted)")
    ap.add_argument("--config",     default="config.json", help="Local config JSON path (default: config.json)")
    ap.add_argument("--attendance", default="attendance.csv", help="Local attendance CSV path (default: attendance.csv)")
    ap.add_argument("--ref",        default=None, help="Supabase project ref (default: auto-derived from --url)")
    ap.add_argument("--sb-token",   default=None, help="Supabase Personal Access Token (or SUPABASE_ACCESS_TOKEN env)")
    ap.add_argument("--migration",  default=None, help="Run only this migration file (default: all in seed/migrations/)")
    ap.add_argument("--wrangler-args", default=None, help="Extra args for wrangler deploy, e.g. '--env production'")
    ap.add_argument("--yes",        action="store_true", help="Skip all confirmation prompts")
    ap.add_argument("--action", choices=list(ACTIONS), default=None,
                    help="Run one action and exit instead of showing the menu.")
    args = ap.parse_args()

    CONFIRM_ALL = args.yes

    if args.action:
        if args.action in ("migrate", "deploy"):
            base, headers = None, None
        else:
            base, headers = get_credentials(args)
        ACTIONS[args.action][1](base, headers, args)
    else:
        base, headers = get_credentials(args, optional=True)
        run_menu(base, headers, args)


if __name__ == "__main__":
    main()
