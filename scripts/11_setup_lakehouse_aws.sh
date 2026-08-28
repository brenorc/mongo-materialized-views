#!/usr/bin/env bash
# Scenario 5 — provision the AWS side and the Atlas↔AWS trust, idempotently:
#
#   1. S3 bucket for the Iceberg warehouse (default: mongo-analytics-lake-<account>)
#   2. AWS Glue database `sales` (the Iceberg catalog)
#   3. Atlas Cloud Provider Access entry + IAM role Atlas can assume
#      (trust policy pinned to the Atlas AWS account + external id)
#   4. Inline policy on that role: this bucket + the Glue catalog
#   5. `salesLake` S3 connection in the stream workspace's Connection Registry
#
# Usage, from the repo root (AWS credentials + Atlas key in .env):
#   set -a; source .env; set +a
#   export AWS_REGION=us-east-1
#   bash scripts/11_setup_lakehouse_aws.sh
#
# Overrides: LAKE_BUCKET, LAKE_GLUE_DB (default sales), LAKE_IAM_ROLE
# (default mongodb-atlas-lakehouse-demo), ASP_WORKSPACE_NAME (analytics-demo).

set -euo pipefail
cd "$(dirname "$0")/.."

export AWS_REGION="${AWS_REGION:-us-east-1}"
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
LAKE_BUCKET="${LAKE_BUCKET:-mongo-analytics-lake-$ACCOUNT_ID}"
LAKE_GLUE_DB="${LAKE_GLUE_DB:-sales}"
LAKE_IAM_ROLE="${LAKE_IAM_ROLE:-mongodb-atlas-lakehouse-demo}"
WORKSPACE="${ASP_WORKSPACE_NAME:-analytics-demo}"
CONNECTION="salesLake"

echo "== 1/5 S3 bucket: $LAKE_BUCKET =="
if aws s3api head-bucket --bucket "$LAKE_BUCKET" 2>/dev/null; then
  echo "  already exists"
else
  aws s3api create-bucket --bucket "$LAKE_BUCKET" >/dev/null   # us-east-1: no LocationConstraint
  echo "  created"
fi

echo "== 2/5 Glue database: $LAKE_GLUE_DB =="
if aws glue get-database --name "$LAKE_GLUE_DB" >/dev/null 2>&1; then
  echo "  already exists"
else
  aws glue create-database --database-input "{\"Name\":\"$LAKE_GLUE_DB\"}"
  echo "  created"
fi

echo "== 3/5 Atlas Cloud Provider Access + IAM role: $LAKE_IAM_ROLE =="
CPA=$(python3 - <<'PY'
import json, os, subprocess
pub, priv = os.environ["MONGODB_ATLAS_PUBLIC_API_KEY"], os.environ["MONGODB_ATLAS_PRIVATE_API_KEY"]
gid = os.environ["MONGODB_ATLAS_PROJECT_ID"]
base = f"https://cloud.mongodb.com/api/atlas/v2/groups/{gid}/cloudProviderAccess"
def call(method, url, body=None):
    cmd = ["curl","-sS","--digest","-u",f"{pub}:{priv}",
           "-H","Accept: application/vnd.atlas.2023-01-01+json",
           "-H","Content-Type: application/json","-X",method,url]
    if body is not None: cmd += ["-d", json.dumps(body)]
    return json.loads(subprocess.run(cmd, capture_output=True, text=True).stdout or "{}")
roles = call("GET", base).get("awsIamRoles", [])
role = next((r for r in roles if os.environ["LAKE_IAM_ROLE"] in (r.get("iamAssumedRoleArn") or "")), None)
if role is None:
    unassigned = next((r for r in roles if not r.get("iamAssumedRoleArn")), None)
    role = unassigned or call("POST", base, {"providerName": "AWS"})
print(json.dumps({"roleId": role["roleId"],
                  "atlasAccount": role["atlasAWSAccountArn"],
                  "externalId": role["atlasAssumedRoleExternalId"],
                  "authorized": bool(role.get("iamAssumedRoleArn"))}))
PY
)
ROLE_ID=$(echo "$CPA" | python3 -c "import json,sys; print(json.load(sys.stdin)['roleId'])")
ATLAS_ACCOUNT=$(echo "$CPA" | python3 -c "import json,sys; print(json.load(sys.stdin)['atlasAccount'])")
EXTERNAL_ID=$(echo "$CPA" | python3 -c "import json,sys; print(json.load(sys.stdin)['externalId'])")
AUTHORIZED=$(echo "$CPA" | python3 -c "import json,sys; print(json.load(sys.stdin)['authorized'])")
echo "  Atlas roleId=$ROLE_ID (authorized=$AUTHORIZED)"

TRUST=$(cat <<JSON
{"Version":"2012-10-17","Statement":[{"Effect":"Allow",
  "Principal":{"AWS":"$ATLAS_ACCOUNT"},
  "Action":"sts:AssumeRole",
  "Condition":{"StringEquals":{"sts:ExternalId":"$EXTERNAL_ID"}}}]}
JSON
)
if aws iam get-role --role-name "$LAKE_IAM_ROLE" >/dev/null 2>&1; then
  aws iam update-assume-role-policy --role-name "$LAKE_IAM_ROLE" --policy-document "$TRUST"
  echo "  IAM role exists — trust policy refreshed"
else
  aws iam create-role --role-name "$LAKE_IAM_ROLE" --assume-role-policy-document "$TRUST" >/dev/null
  echo "  IAM role created"
fi
ROLE_ARN=$(aws iam get-role --role-name "$LAKE_IAM_ROLE" --query Role.Arn --output text)

echo "== 4/5 role policy: S3 bucket + Glue catalog =="
aws iam put-role-policy --role-name "$LAKE_IAM_ROLE" --policy-name lakehouse-access \
  --policy-document "$(cat <<JSON
{"Version":"2012-10-17","Statement":[
 {"Effect":"Allow","Action":"s3:ListAllMyBuckets","Resource":"*"},
 {"Effect":"Allow","Action":["s3:ListBucket","s3:GetBucketLocation"],
  "Resource":"arn:aws:s3:::$LAKE_BUCKET"},
 {"Effect":"Allow","Action":["s3:GetObject","s3:PutObject","s3:DeleteObject"],
  "Resource":"arn:aws:s3:::$LAKE_BUCKET/*"},
 {"Effect":"Allow","Action":["glue:GetDatabase","glue:GetDatabases","glue:CreateTable",
   "glue:GetTable","glue:GetTables","glue:UpdateTable","glue:CreateDatabase"],
  "Resource":["arn:aws:glue:$AWS_REGION:$ACCOUNT_ID:catalog",
   "arn:aws:glue:$AWS_REGION:$ACCOUNT_ID:database/$LAKE_GLUE_DB",
   "arn:aws:glue:$AWS_REGION:$ACCOUNT_ID:table/$LAKE_GLUE_DB/*"]}]}
JSON
)"
echo "  policy attached"

if [ "$AUTHORIZED" != "True" ]; then
  echo "  authorizing the role with Atlas (retries while IAM propagates)..."
  python3 - "$ROLE_ID" "$ROLE_ARN" <<'PY'
import json, os, subprocess, sys, time
role_id, role_arn = sys.argv[1], sys.argv[2]
pub, priv = os.environ["MONGODB_ATLAS_PUBLIC_API_KEY"], os.environ["MONGODB_ATLAS_PRIVATE_API_KEY"]
gid = os.environ["MONGODB_ATLAS_PROJECT_ID"]
url = f"https://cloud.mongodb.com/api/atlas/v2/groups/{gid}/cloudProviderAccess/{role_id}"
body = json.dumps({"providerName": "AWS", "iamAssumedRoleArn": role_arn})
for attempt in range(8):
    out = subprocess.run(["curl","-sS","--digest","-u",f"{pub}:{priv}",
        "-H","Accept: application/vnd.atlas.2023-01-01+json",
        "-H","Content-Type: application/json","-X","PATCH",url,"-d",body],
        capture_output=True, text=True).stdout
    d = json.loads(out or "{}")
    if d.get("iamAssumedRoleArn"):
        print(f"  authorized after attempt {attempt+1}"); break
    time.sleep(15)
else:
    raise SystemExit(f"  could not authorize role: {out[:300]}")
PY
fi

echo "== 5/5 '$CONNECTION' S3 connection in workspace '$WORKSPACE' =="
python3 - "$ROLE_ARN" "$LAKE_BUCKET" <<'PY'
import json, os, subprocess, sys
role_arn, bucket = sys.argv[1], sys.argv[2]
pub, priv = os.environ["MONGODB_ATLAS_PUBLIC_API_KEY"], os.environ["MONGODB_ATLAS_PRIVATE_API_KEY"]
gid = os.environ["MONGODB_ATLAS_PROJECT_ID"]
ws = os.environ.get("ASP_WORKSPACE_NAME", "analytics-demo")
base = f"https://cloud.mongodb.com/api/atlas/v2/groups/{gid}/streams/{ws}/connections"
def call(method, url, body=None):
    cmd = ["curl","-sS","--digest","-u",f"{pub}:{priv}",
           "-H","Accept: application/vnd.atlas.2024-05-30+json",
           "-H","Content-Type: application/json","-X",method,url]
    if body is not None: cmd += ["-d", json.dumps(body)]
    return json.loads(subprocess.run(cmd, capture_output=True, text=True).stdout or "{}")
existing = {c["name"] for c in call("GET", base).get("results", [])}
if "salesLake" in existing:
    print("  already exists")
else:
    r = call("POST", base, {"name": "salesLake", "type": "S3",
                            "aws": {"roleArn": role_arn, "testBucket": bucket}})
    if r.get("errorCode"): raise SystemExit(f"  failed: {r.get('detail')}")
    print("  created")
PY

echo
echo "Lakehouse plumbing ready:"
echo "  bucket:      s3://$LAKE_BUCKET"
echo "  glue db:     $LAKE_GLUE_DB"
echo "  iam role:    $ROLE_ARN"
echo "  connection:  $CONNECTION (workspace $WORKSPACE)"
echo "Next: scripts/12_lakehouse_snapshot.js against the workspace."