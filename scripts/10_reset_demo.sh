#!/usr/bin/env bash
# Reset the whole demo to a clean, CONSISTENT starting point.
#
# After this script, the same question ("sales by channel for product X")
# returns IDENTICAL numbers from all four executable scenarios — the raw
# union, the batch view, the trigger view and the stream view — until you
# start the live writer.
#
# What it does, in an order that prevents double counting:
#   1. drop the stream processor          (so the seed doesn't flow through it)
#   2. disable the three triggers         (same reason)
#   3. reseed the three source collections (~10k sales each)
#   4. full batch refresh  -> sales_rollup
#   5. backfill            -> sales_rollup_live + sales_rollup_stream
#   6. re-enable the triggers             (fresh change streams from "now")
#   7. recreate + START the stream processor (fresh change stream from "now")
#   8. verify: run the demo query against all four targets and compare
#
# Usage, from the repo root:
#   set -a; source .env; set +a
#   bash scripts/10_reset_demo.sh
#
# SKIP_STREAM=1 skips steps 1 and 7 (reset without the ASP workspace).
# ASP_HOSTNAME=<workspace-hostname> skips the API lookup of the workspace —
#   useful when the Atlas API key's IP access list blocks your current IP
#   (the workspace itself follows the PROJECT access list, not the key's).
# NOTE: step 7 leaves the processor RUNNING (the demo needs it live) — the
# SP10 workspace bills while it exists; tear it down after the demo cycle.

set -euo pipefail
cd "$(dirname "$0")/.."

SP_USER=$(python3 -c "import os,urllib.parse as u; print(u.urlparse(os.environ['MONGODB_URI']).username)")
SP_PASS=$(python3 -c "import os,urllib.parse as u; print(u.urlparse(os.environ['MONGODB_URI']).password)")

sp_host() {
  python3 - <<'PY'
import json, os, subprocess
pub, priv = os.environ["MONGODB_ATLAS_PUBLIC_API_KEY"], os.environ["MONGODB_ATLAS_PRIVATE_API_KEY"]
gid = os.environ["MONGODB_ATLAS_PROJECT_ID"]
ws = os.environ.get("ASP_WORKSPACE_NAME", "analytics-demo")
out = subprocess.run(["curl","-s","--digest","-u",f"{pub}:{priv}",
    "-H","Accept: application/vnd.atlas.2024-05-30+json",
    f"https://cloud.mongodb.com/api/atlas/v2/groups/{gid}/streams/{ws}"],
    capture_output=True, text=True).stdout
d = json.loads(out)
print(d["hostnames"][0] if "hostnames" in d else "")
PY
}

if [ "${SKIP_STREAM:-0}" != "1" ]; then
  SP_HOST="${ASP_HOSTNAME:-$(sp_host)}"
  if [ -z "$SP_HOST" ]; then
    echo "!! stream workspace not found — run scripts/06_setup_stream_workspace.sh first,"
    echo "   or re-run with SKIP_STREAM=1. Aborting so the reset stays consistent."
    exit 1
  fi
  echo "== 1/8 drop stream processor =="
  ACTION=drop mongosh "mongodb://$SP_HOST/" --tls --authenticationDatabase admin \
    -u "$SP_USER" -p "$SP_PASS" --quiet --file scripts/07_stream_processor.js
else
  echo "== 1/8 skipped (SKIP_STREAM=1) =="
fi

echo "== 2/8 disable triggers =="
bash scripts/05_setup_triggers.sh disable

echo "== 3/8 reseed source collections =="
mongosh "$MONGODB_URI" --quiet --file scripts/00_seed.js | head -5

echo "== 4/8 full batch refresh -> sales_rollup =="
mongosh "$MONGODB_URI" --quiet --eval '
db.getSiblingDB(process.env.MONGODB_DATABASE || "mongo_analytics").analytics_meta.drop()' >/dev/null
FULL=1 mongosh "$MONGODB_URI" --quiet --file scripts/03_batch_refresh.js | tail -4

echo "== 5/8 backfill -> sales_rollup_live + sales_rollup_stream =="
mongosh "$MONGODB_URI" --quiet --file scripts/08_backfill_rollups.js

echo "== 6/8 re-enable triggers =="
bash scripts/05_setup_triggers.sh enable
# Reseeding DROPS the source collections, which invalidates the change
# streams the triggers had before the reset — a plain re-enable would fail
# with InvalidResumeToken. Resume discards the stale tokens and opens fresh
# change streams. No events are lost: nothing has been written since enable.
bash scripts/05_setup_triggers.sh resume

if [ "${SKIP_STREAM:-0}" != "1" ]; then
  echo "== 7/8 recreate + start stream processor =="
  ACTION=create mongosh "mongodb://$SP_HOST/" --tls --authenticationDatabase admin \
    -u "$SP_USER" -p "$SP_PASS" --quiet --file scripts/07_stream_processor.js
else
  echo "== 7/8 skipped (SKIP_STREAM=1) =="
fi

echo "== 8/8 verify: same query, four targets =="
SKU="${SKU:-SKU-001}"
declare -a TOTALS=()
for target in union batch live stream; do
  if [ "$target" = "stream" ] && [ "${SKIP_STREAM:-0}" = "1" ]; then continue; fi
  line=$(TARGET=$target SKU=$SKU mongosh "$MONGODB_URI" --quiet --file scripts/09_demo_query.js | grep '^TOTAL')
  TOTALS+=("$line")
  printf '  %-7s %s\n' "$target" "$line"
done
if [ "$(printf '%s\n' "${TOTALS[@]}" | sort -u | wc -l | tr -d ' ')" = "1" ]; then
  echo "ALL TARGETS AGREE — demo is at a consistent starting point."
else
  echo "!! targets disagree — do not start the demo; investigate before presenting."
  exit 1
fi
