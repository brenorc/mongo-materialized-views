#!/usr/bin/env bash
# Approach 4 — provision the Atlas Stream Processing workspace.
#
# Creates (idempotently, via the Atlas Administration API):
#   - a Stream Processing workspace "analytics-demo" (tier SP10, AWS us-east-1,
#     same region as the cluster so change streams don't cross regions)
#   - a Connection Registry entry "BrenoM10Conn" pointing at the cluster,
#     used both as the $source (change streams) and the $merge target
#
# Then prints the mongosh command to reach the workspace.
#
# COST: an SP10 workspace bills per hour while it exists (see the Atlas
# pricing page). Delete it when you are done:
#   bash scripts/06_setup_stream_workspace.sh teardown
#
# Usage, from the repo root:
#   set -a; source .env; set +a
#   bash scripts/06_setup_stream_workspace.sh

set -euo pipefail
cd "$(dirname "$0")/.."

python3 - "${1:-setup}" <<'PY'
import json, os, subprocess, sys

PUB = os.environ["MONGODB_ATLAS_PUBLIC_API_KEY"]
PRIV = os.environ["MONGODB_ATLAS_PRIVATE_API_KEY"]
GROUP = os.environ["MONGODB_ATLAS_PROJECT_ID"]
CLUSTER = os.environ.get("ATLAS_CLUSTER_NAME", "BrenoM10")
WORKSPACE = os.environ.get("ASP_WORKSPACE_NAME", "analytics-demo")
CONNECTION = os.environ.get("ASP_CONNECTION_NAME", "BrenoM10Conn")
MODE = sys.argv[1]

BASE = f"https://cloud.mongodb.com/api/atlas/v2/groups/{GROUP}/streams"
ACCEPT = "application/vnd.atlas.2024-05-30+json"

def call(method, url, body=None):
    cmd = ["curl", "-sS", "--digest", "-u", f"{PUB}:{PRIV}",
           "-H", f"Accept: {ACCEPT}", "-H", "Content-Type: application/json",
           "-X", method, url]
    if body is not None:
        cmd += ["-d", json.dumps(body)]
    out = subprocess.run(cmd, capture_output=True, text=True).stdout
    d = json.loads(out) if out.strip() else {}
    if isinstance(d, dict) and d.get("errorCode"):
        raise SystemExit(f"{method} {url} -> {d['errorCode']}: {d.get('detail')}")
    return d

if MODE == "teardown":
    call("DELETE", f"{BASE}/{WORKSPACE}")
    print(f"deleted workspace '{WORKSPACE}' (billing for it stops here)")
    raise SystemExit(0)

# ── 1. Workspace ────────────────────────────────────────────────────────────
existing = {w["name"]: w for w in call("GET", BASE).get("results", [])}
if WORKSPACE in existing:
    ws = existing[WORKSPACE]
    print(f"workspace '{WORKSPACE}' already exists")
else:
    ws = call("POST", BASE, {
        "name": WORKSPACE,
        "dataProcessRegion": {"cloudProvider": "AWS", "region": "VIRGINIA_USA"},
        "streamConfig": {"tier": "SP10"},
    })
    print(f"created workspace '{WORKSPACE}' (SP10, AWS us-east-1)")

# ── 2. Cluster connection in the Connection Registry ────────────────────────
conns = {c["name"]: c for c in call("GET", f"{BASE}/{WORKSPACE}/connections").get("results", [])}
if CONNECTION in conns:
    print(f"connection '{CONNECTION}' already exists")
else:
    call("POST", f"{BASE}/{WORKSPACE}/connections", {
        "name": CONNECTION,
        "type": "Cluster",
        "clusterName": CLUSTER,
        "dbRoleToExecute": {"role": "readWriteAnyDatabase", "type": "BUILT_IN"},
    })
    print(f"created connection '{CONNECTION}' -> cluster {CLUSTER} (readWriteAnyDatabase)")

# ── 3. Print how to reach it ────────────────────────────────────────────────
ws = call("GET", f"{BASE}/{WORKSPACE}")
host = ws["hostnames"][0]
print(f"\nworkspace hostname: {host}")
print("connect with your Atlas database user, e.g.:")
print(f'  mongosh "mongodb://{host}/" --tls --authenticationDatabase admin -u <db_user> -p')
PY
