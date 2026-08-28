# 5 · Stream processing → Apache Iceberg on S3 (lakehouse)

**Same processor, different destination — and a different audience.** Instead
of merging into an Atlas collection, the final stage becomes `$iceberg`,
writing Apache Iceberg v2 tables to S3, catalogued in AWS Glue and queried by
Athena, Snowflake, Databricks or Trino. MongoDB leaves the read path entirely.

## The demo strategy: generate once, freeze, replay

Cross-cloud plumbing is the least reliable thing to do live on stage. So this
scenario is built **once, for real** — Atlas Stream Processing genuinely wrote
these Parquet files — and then frozen:

1. The stream processor writes the Iceberg table from `sales_rollup`.
2. The processor is **dropped**. Nothing keeps running, nothing bills.
3. Every future demo just runs the same Athena query against the same frozen
   table. No live integration to fail in front of a customer.

You can still tell the story truthfully: *"these files were written by
MongoDB, by the same processor you saw in scenario 4 — only the sink stage
changed."*

## What was actually built

| Resource | Value |
| --- | --- |
| S3 bucket | `mongo-analytics-lake-<account-id>` |
| Iceberg warehouse | `s3://<bucket>/iceberg-warehouse/sales/sales_rollup/` |
| Glue catalog database | `sales` (table `sales_rollup`, `table_type=ICEBERG`) |
| IAM role | `mongodb-atlas-lakehouse-demo` (trusted by the Atlas AWS account + external id) |
| Atlas connection | `salesLake` (type `S3`) in workspace `analytics-demo` |
| Athena workgroup | `mongodb-lakehouse-demo` (query results preset to `s3://<bucket>/athena-results/`) |
| Snapshot result | **12,140 rows, 1,030 objects, DLQ empty** |

Reproduce or rebuild it:

```sh
set -a; source .env; set +a
export AWS_REGION=us-east-1

# 1. bucket, Glue db, IAM role, Atlas trust, salesLake connection (idempotent)
bash scripts/11_setup_lakehouse_aws.sh

# 2. one-time snapshot: sales_rollup -> Iceberg (run against the WORKSPACE)
export LAKE_BUCKET=mongo-analytics-lake-<account-id>
ACTION=create mongosh "mongodb://<workspace-hostname>/" --tls \
  --authenticationDatabase admin -u "$DB_USER" -p "$DB_PASS" \
  --quiet --file scripts/12_lakehouse_snapshot.js

# 3. watch until output == input and dlq == 0, then freeze
ACTION=stats ...          # repeat every ~20s
ACTION=drop  ...          # freeze the snapshot

# 4. query it
bash scripts/13_athena_demo_query.sh
```

## The pipeline delta

Everything upstream is identical to scenario 4. Only the source and the sink
change:

```js
{ $source: { connectionName: "atlasCluster", db: "mongo_analytics",
             coll: "sales_rollup",
             initialSync: { enable: true } } },     // replay existing rows
// ... flatten _id, cast numerics (see gotcha 3) ...
{ $iceberg: {
    connectionName: "salesLake",
    bucket: "mongo-analytics-lake-<account-id>",
    path: "iceberg-warehouse",       // NO trailing slash (gotcha 2)
    databaseName: "sales",
    tableName: "sales_rollup",
    mode: "cdc",                     // row-level upserts keyed by idFieldName
    idFieldName: "_id",
    catalog: { type: "glue" } } }
```

`$iceberg` must be the **last** stage, one per pipeline, and sinks are
mutually exclusive — a processor writes to a collection *or* to the lake. Two
audiences means two processors on the same source.

## The result: identical numbers, different engine

The demo question, asked of Athena and of MongoDB:

```
Athena / Iceberg on S3                 MongoDB batch view
channel     units      revenue         channel     units     revenue
instore      4838    628456.20         instore      4838    628456.20
online       5155    669634.50         online       5155    669634.50
partner      3835    423442.89         partner      3835    423442.89
TOTAL       13828   1721533.59         TOTAL       13828   1721533.59
(1068 ms, 275 KB scanned)              (367 ms)
```

That is the slide: **same answer, and MongoDB is not in the read path.**

## Three gotchas we hit for real

1. **The S3 connection body is not what you'd guess.** It takes the AWS role
   **ARN**, not the Atlas `roleId`:
   `{"name":"salesLake","type":"S3","aws":{"roleArn":"arn:aws:iam::...","testBucket":"..."}}`.
   Passing `roleId` returns `Invalid attribute roleId specified`.
2. **`path` must not end with `/`** — despite the docs example showing one.
   A trailing slash fails with `Invalid $iceberg.path: cannot end with a '/'`.
3. **Cast your numerics, or lose half your rows.** Our first run put **5,544
   of 12,140 documents in the dead-letter queue** with:

   > `Unexpected BSON type of int for iceberg column name revenue of type double`

   MongoDB's `$round` returns an **int** when the value is whole (`236`) and a
   **double** otherwise (`236.5`). Iceberg infers the column type from the
   first rows it sees and then statically enforces it, so every whole-valued
   row was rejected. The fix is an explicit `$toDouble` / `$toLong` on every
   numeric before `$iceberg` — after which the same run produced 12,140 of
   12,140 rows with an empty DLQ.

   This is worth showing a customer: it is the fundamental impedance mismatch
   between a dynamically typed document store and a statically typed table
   format, and it fails *quietly into the DLQ* rather than crashing.

Also worth knowing: the IAM role needs `s3:ListAllMyBuckets` (account-wide)
in addition to bucket-scoped permissions, or the connection test fails with
"Unable to authorize AWS connection". And allow a minute for IAM propagation
before Atlas can assume a freshly created role.

## Operational notes for production

- **Visibility follows the commit cadence**, not the event — rows appear when
  files are committed. Do not promise per-second freshness on the lake.
- **Small files are the classic failure mode**: frequent commits produce many
  tiny Parquet files (we wrote 1,030 objects for 12k rows); Iceberg tables
  need periodic compaction to stay fast.
- **The lake is not a serving layer.** An app needing one row in milliseconds
  still wants scenario 2 or 4. Real setups often run both sinks from one
  source.
- **Schema evolution** is handled by Iceberg v2 + the catalog as the rollup
  shape changes — the main reason to prefer `$iceberg` over `$emit`-to-JSON.

## Teardown

The snapshot is static: it costs only S3 storage (~3 MB). To remove it:

```sh
aws glue delete-table --database-name sales --name sales_rollup
aws s3 rm s3://mongo-analytics-lake-<account-id>/iceberg-warehouse --recursive
aws athena delete-work-group --work-group mongodb-lakehouse-demo
```

Note the Athena workgroup is a *separate* one on purpose: this AWS account is
shared, and setting a query-result location on the default `primary` workgroup
would change it for everyone else using the account.

**Back to:** [README](../README.md) · [Demo runbook](06-demo-runbook.md)
