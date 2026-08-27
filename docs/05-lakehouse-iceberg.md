# 5 · Stream processing → Apache Iceberg on S3 (lakehouse)

**Same processor, different destination — and a different audience.** Instead
of merging into an Atlas collection, the final stage becomes
[`$iceberg`](https://www.mongodb.com/docs/atlas/atlas-stream-processing/sp-agg-iceberg/),
writing Iceberg v2 tables to S3 that Snowflake, Databricks, Athena or Trino
query directly. MongoDB leaves the read path entirely.

> This chapter is a step-by-step, not an executed implementation: it requires
> an AWS account (S3 bucket + Glue catalog + IAM role) that this demo
> environment does not have. Everything up to the sink is identical to
> approach 4, so the delta is small and precise.

## When this is the right move

- Sales analysis must join finance/inventory/marketing data that already
  lives in a warehouse;
- Analysts live in Snowflake/Databricks and want sales to appear *there*;
- You want years of history at object-storage cost, in an open format.

And the counterpoint to say out loud: **the lake is not a serving layer**. An
application that needs one rollup row in milliseconds still needs an Atlas
collection (approach 2 or 4). Many production setups run both sinks from the
same source — one processor merging into Atlas for the app, another writing
history to Iceberg for the analysts.

## Steps

1. **AWS side** — an S3 bucket (e.g. `acme-analytics`), AWS Glue as the
   Iceberg catalog, and an IAM role Atlas can assume with write access to the
   bucket + Glue.
2. **Authorize Atlas → AWS**: Atlas UI → Project Integrations → AWS IAM Role
   (or `cloudProviderAccess` via the Admin API): create the trust
   relationship, note the role ID.
3. **Add an S3 connection to the workspace's Connection Registry** (same
   pattern as `06_setup_stream_workspace.sh`, `type: "S3"` plus the role):

   ```json
   { "name": "salesLake", "type": "S3", "aws": { "roleId": "<role-id>" } }
   ```

4. **Create the lake processor** — identical `$source` + normalization +
   window as `07_stream_processor.js`, but the sink becomes:

   ```js
   {
     $iceberg: {
       connectionName: "salesLake",
       bucket: "acme-analytics",
       path: "iceberg-warehouse/",
       databaseName: "sales",
       tableName: "sales_rollup",
       mode: "cdc",              // applies row-level upserts by idFieldName
       idFieldName: "_id",
       catalog: { type: "glue" }
     }
   }
   ```

   Constraints that matter: `$iceberg` must be the **last** stage, one per
   pipeline, and sinks are mutually exclusive — a processor writes to a
   collection *or* to the lake, so "both" means two processors on the same
   source. Supported on SP10/SP30/SP50.

5. **Query from the engine of choice** — the Glue catalog makes the table
   appear automatically. Athena:

   ```sql
   SELECT day, region, SUM(revenue) AS revenue
   FROM sales.sales_rollup
   WHERE sku = 'SKU-001' AND day BETWEEN '2026-08-01' AND '2026-08-27'
   GROUP BY day, region ORDER BY day;
   ```

## Operational notes

- **Visibility follows the commit cadence**, not the event — rows appear when
  files are committed to the table. Tune commit intervals; do not promise
  per-second freshness on the lake.
- **Small files are the classic failure mode**: frequent commits produce many
  tiny Parquet files, and Iceberg tables need periodic compaction (Glue/
  engine-side) to stay fast.
- **Schema evolution is handled** by Iceberg v2 + the catalog as the rollup
  shape evolves — one of the main reasons to prefer `$iceberg` over plain
  `$emit`-to-S3 JSON.

**Back to:** [README](../README.md)
