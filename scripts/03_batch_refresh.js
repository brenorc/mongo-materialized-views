// Approach 2 — scheduled batch refresh of a materialized view.
//
// Recomputes the rollup collection `sales_rollup` from the three sources
// using the SAME normalization pipelines as the query-time approach, and
// upserts the result with $merge.
//
// Idempotent by construction: each run deterministically recomputes every
// day it touches from source and replaces those rollup rows wholesale.
// Running it twice in a row produces byte-identical results.
//
// Incremental by watermark: a run only recomputes days that could have
// changed since the previous run (with a lateness buffer for stragglers).
//
// Run from the repo root:
//   set -a; source .env; set +a
//   mongosh "$MONGODB_URI" --quiet --file scripts/03_batch_refresh.js
//
// Options (environment variables):
//   FULL=1               rebuild the whole view from scratch
//   LATENESS_HOURS=48    how far behind the watermark to re-scan (default 48)
//
// In production you would run this from an Atlas Scheduled Trigger or any
// cron — the script is a single aggregate() call per source window.

load("scripts/lib/guard.js");
load("scripts/lib/normalize.js");

const DB_NAME = process.env.MONGODB_DATABASE || "mongo_analytics";
const FULL = process.env.FULL === "1";
const LATENESS_HOURS = parseInt(process.env.LATENESS_HOURS || "48", 10);

const dbx = db.getSiblingDB(DB_NAME);
const META_ID = "sales_rollup";
const startedAt = new Date();

// ── 1. Decide the recompute window ──────────────────────────────────────────
const meta = dbx.analytics_meta.findOne({ _id: META_ID });
let sinceDay = null; // null = full rebuild
if (!FULL && meta && meta.lastRunAt) {
  const cutoff = new Date(meta.lastRunAt.getTime() - LATENESS_HOURS * 3600 * 1000);
  sinceDay = cutoff.toISOString().slice(0, 10);
}

if (sinceDay === null) {
  print("Mode: FULL rebuild (no watermark found or FULL=1)");
  dbx.sales_rollup.drop();
} else {
  print(`Mode: incremental — recomputing days >= ${sinceDay} ` +
        `(watermark ${meta.lastRunAt.toISOString()} minus ${LATENESS_HOURS}h lateness buffer)`);
}

// Per-source window filters. These run BEFORE normalization, on indexed
// fields, so an incremental run only reads the tail of each collection.
const sinceDate = sinceDay ? new Date(sinceDay + "T00:00:00Z") : null;
const matchOnline = sinceDate ? [{ $match: { orderedAt: { $gte: sinceDate } } }] : [];
const matchInstore = sinceDate ? [{ $match: { soldAt: { $gte: sinceDate } } }] : [];
const matchPartners = sinceDay ? [{ $match: { sale_date: { $gte: sinceDay } } }] : [];

// ── 2. Recompute the window and upsert into the view ────────────────────────
const pipeline = [
  ...matchOnline,
  ...NORMALIZE_ONLINE,
  { $unionWith: { coll: "sales_instore", pipeline: [...matchInstore, ...NORMALIZE_INSTORE] } },
  { $unionWith: { coll: "sales_partners", pipeline: [...matchPartners, ...NORMALIZE_PARTNERS] } },
  ...ROLLUP_GROUP,
  { $set: { updatedAt: "$$NOW" } },
  {
    $merge: {
      into: "sales_rollup",
      on: "_id",
      whenMatched: "replace",   // deterministic recompute → replace is what makes reruns idempotent
      whenNotMatched: "insert",
    },
  },
];

const t0 = Date.now();
dbx.sales_online.aggregate(pipeline);
const elapsed = Date.now() - t0;

// ── 3. Advance the watermark and index the view ─────────────────────────────
dbx.analytics_meta.updateOne(
  { _id: META_ID },
  { $set: { lastRunAt: startedAt }, $inc: { runs: 1 } },
  { upsert: true }
);
// Covering the demo's access patterns: by product over time, and by day.
dbx.sales_rollup.createIndex({ sku: 1, day: 1 });
dbx.sales_rollup.createIndex({ day: 1, region: 1 });

// ── 4. Report ───────────────────────────────────────────────────────────────
const rollupCount = dbx.sales_rollup.countDocuments();
const totals = dbx.sales_rollup
  .aggregate([{ $group: { _id: null, revenue: { $sum: "$revenue" }, units: { $sum: "$units" } } }])
  .toArray()[0];

print(`\nRefreshed in ${elapsed} ms`);
print(`sales_rollup: ${rollupCount} rows (grain: day × channel × region × product)`);
print(`View totals: ${totals.units} units, revenue ${totals.revenue.toFixed(2)}`);
print(`Watermark advanced to ${startedAt.toISOString()}`);
