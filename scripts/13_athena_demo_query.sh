#!/usr/bin/env bash
# Scenario 5 — run the demo question against the frozen Iceberg table in
# Athena, printing the same channel/units/revenue table as 09_demo_query.js.
#
# Usage (AWS credentials in .env):
#   set -a; source .env; set +a
#   export AWS_REGION=us-east-1
#   bash scripts/13_athena_demo_query.sh            # default SKU-001
#   SKU=SKU-007 bash scripts/13_athena_demo_query.sh
#
# For the live demo itself, prefer pasting the same SQL into the Athena
# console — the audience sees the lakehouse tooling, not a terminal.

set -euo pipefail
export AWS_REGION="${AWS_REGION:-us-east-1}"
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
LAKE_BUCKET="${LAKE_BUCKET:-mongo-analytics-lake-$ACCOUNT_ID}"
LAKE_GLUE_DB="${LAKE_GLUE_DB:-sales}"
SKU="${SKU:-SKU-001}"

SQL="SELECT channel, SUM(units) AS units, ROUND(SUM(revenue), 2) AS revenue
FROM ${LAKE_GLUE_DB}.sales_rollup
WHERE sku = '${SKU}'
GROUP BY channel
ORDER BY channel;"

echo "Sales by channel — ${SKU} (source: Iceberg on s3://${LAKE_BUCKET}, via Athena)"
echo
# Use the dedicated workgroup so the CLI and the Athena console behave
# identically. It carries the query-result location, so none is passed here.
# ATHENA_WORKGROUP=primary falls back to an explicit result location.
WORKGROUP="${ATHENA_WORKGROUP:-mongodb-lakehouse-demo}"
if aws athena get-work-group --work-group "$WORKGROUP" >/dev/null 2>&1; then
  QID=$(aws athena start-query-execution \
    --work-group "$WORKGROUP" \
    --query-string "$SQL" \
    --query-execution-context "Database=${LAKE_GLUE_DB},Catalog=AwsDataCatalog" \
    --query QueryExecutionId --output text)
else
  echo "(workgroup '$WORKGROUP' not found — falling back to an explicit result location)" >&2
  QID=$(aws athena start-query-execution \
    --query-string "$SQL" \
    --query-execution-context "Database=${LAKE_GLUE_DB},Catalog=AwsDataCatalog" \
    --result-configuration "OutputLocation=s3://${LAKE_BUCKET}/athena-results/" \
    --query QueryExecutionId --output text)
fi

for _ in $(seq 1 30); do
  STATE=$(aws athena get-query-execution --query-execution-id "$QID" \
    --query QueryExecution.Status.State --output text)
  case "$STATE" in
    SUCCEEDED) break ;;
    FAILED|CANCELLED)
      aws athena get-query-execution --query-execution-id "$QID" \
        --query QueryExecution.Status.StateChangeReason --output text
      exit 1 ;;
    *) sleep 2 ;;
  esac
done

# `--output text` flattens every cell onto one line, so parse the JSON:
aws athena get-query-results --query-execution-id "$QID" --output json | python3 -c '
import json, sys
rows = json.load(sys.stdin)["ResultSet"]["Rows"]
print("channel     units      revenue")
tu = tr = 0
for r in rows[1:]:                      # rows[0] is the header
    ch, u, rev = (c.get("VarCharValue") for c in r["Data"])
    tu += int(u); tr += float(rev)
    print(f"{ch:<9} {int(u):>7} {float(rev):>12.2f}")
print("{:<9} {:>7} {:>12.2f}".format("TOTAL", tu, tr))'

STATS=$(aws athena get-query-execution --query-execution-id "$QID" \
  --query 'QueryExecution.Statistics.[EngineExecutionTimeInMillis,DataScannedInBytes]' --output text)
echo
echo "($(echo "$STATS" | awk '{print $1}') ms, $(echo "$STATS" | awk '{print $2}') bytes scanned — MongoDB is not in this read path)"
