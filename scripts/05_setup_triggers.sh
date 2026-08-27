#!/usr/bin/env bash
# Approach 3 — provision the Database Triggers programmatically.
#
# Creates (idempotently, all via the App Services Admin API):
#   - the project's "Triggers" app (the same one the Atlas UI creates)
#   - a linked data source pointing at the cluster
#   - one Atlas Function (scripts/lib/trigger_function.js)
#   - three Database Triggers (INSERT on each source collection) → the function
#
# Usage, from the repo root:
#   set -a; source .env; set +a
#   bash scripts/05_setup_triggers.sh            # create/update everything
#   bash scripts/05_setup_triggers.sh teardown   # delete the three triggers + function
#
# Requires: MONGODB_ATLAS_PUBLIC_API_KEY / _PRIVATE_API_KEY with Project Owner
# on MONGODB_ATLAS_PROJECT_ID, python3, curl. No other dependencies.

set -euo pipefail
cd "$(dirname "$0")/.."

python3 - "${1:-setup}" <<'PY'
import json, os, sys, urllib.request

BASE = "https://services.cloud.mongodb.com/api/admin/v3.0"
PUB = os.environ["MONGODB_ATLAS_PUBLIC_API_KEY"]
PRIV = os.environ["MONGODB_ATLAS_PRIVATE_API_KEY"]
GROUP = os.environ["MONGODB_ATLAS_PROJECT_ID"]
CLUSTER = os.environ.get("ATLAS_CLUSTER_NAME", "BrenoM10")
DB = os.environ.get("MONGODB_DATABASE", "mongo_analytics")
MODE = sys.argv[1]

SOURCES = ["sales_online", "sales_instore", "sales_partners"]
FUNC_NAME = "processSaleEvent"
SERVICE_NAME = "mongodb-atlas"

def call(method, path, body=None, token=None):
    req = urllib.request.Request(BASE + path, method=method)
    req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    data = json.dumps(body).encode() if body is not None else None
    try:
        with urllib.request.urlopen(req, data) as r:
            raw = r.read()
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        detail = e.read().decode()
        raise SystemExit(f"{method} {path} -> HTTP {e.code}: {detail}")

# ── 1. Exchange the Atlas API key for an App Services access token ──────────
token = call("POST", "/auth/providers/mongodb-cloud/login",
             {"username": PUB, "apiKey": PRIV})["access_token"]
print("authenticated with App Services Admin API")

# ── 2. Find or create the project's Triggers app ────────────────────────────
apps = call("GET", f"/groups/{GROUP}/apps?product=atlas", token=token)
app = next(iter(apps), None)
if app is None:
    app = call("POST", f"/groups/{GROUP}/apps?product=atlas",
               {"name": "Triggers", "deployment_model": "GLOBAL"}, token=token)
    print(f"created Triggers app: {app['client_app_id']}")
else:
    print(f"found Triggers app: {app['client_app_id']}")
app_path = f"/groups/{GROUP}/apps/{app['_id']}"

# ── 3. Link the cluster as a data source ────────────────────────────────────
services = call("GET", f"{app_path}/services", token=token)
svc = next((s for s in services if s["name"] == SERVICE_NAME), None)
if svc is None:
    svc = call("POST", f"{app_path}/services",
               {"name": SERVICE_NAME, "type": "mongodb-atlas",
                "config": {"clusterName": CLUSTER}}, token=token)
    print(f"linked cluster {CLUSTER} as service '{SERVICE_NAME}'")
else:
    print(f"service '{SERVICE_NAME}' already linked")

if MODE == "teardown":
    trigs = call("GET", f"{app_path}/triggers", token=token)
    for t in trigs:
        if t["name"].startswith("onInsert_sales_"):
            call("DELETE", f"{app_path}/triggers/{t['_id']}", token=token)
            print(f"deleted trigger {t['name']}")
    funcs = call("GET", f"{app_path}/functions", token=token)
    for f in funcs:
        if f["name"] == FUNC_NAME:
            call("DELETE", f"{app_path}/functions/{f['_id']}", token=token)
            print(f"deleted function {FUNC_NAME}")
    raise SystemExit(0)

# ── 4. Create or update the shared function ────────────────────────────────
source = open("scripts/lib/trigger_function.js").read()
funcs = call("GET", f"{app_path}/functions", token=token)
fn = next((f for f in funcs if f["name"] == FUNC_NAME), None)
body = {"name": FUNC_NAME, "private": True, "run_as_system": True, "source": source}
if fn is None:
    fn = call("POST", f"{app_path}/functions", body, token=token)
    print(f"created function {FUNC_NAME}")
else:
    call("PUT", f"{app_path}/functions/{fn['_id']}", body, token=token)
    print(f"updated function {FUNC_NAME}")

# ── 5. One INSERT trigger per source collection, all calling the function ───
trigs = call("GET", f"{app_path}/triggers", token=token)
for coll in SOURCES:
    name = f"onInsert_{coll}"
    cfg = {
        "name": name,
        "type": "DATABASE",
        "function_id": fn["_id"],
        "config": {
            "service_id": svc["_id"],
            "database": DB,
            "collection": coll,
            "operation_types": ["INSERT"],
            "full_document": True,
        },
        "disabled": False,
    }
    existing = next((t for t in trigs if t["name"] == name), None)
    if existing is None:
        call("POST", f"{app_path}/triggers", cfg, token=token)
        print(f"created trigger {name} ({DB}.{coll})")
    else:
        call("PUT", f"{app_path}/triggers/{existing['_id']}", cfg, token=token)
        print(f"updated trigger {name} ({DB}.{coll})")

print("\nDone. Inserts into the three source collections now maintain "
      f"'{DB}.sales_rollup_live' in near real time.")
PY
