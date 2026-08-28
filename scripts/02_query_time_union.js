// Approach 1 — query-time aggregation with $unionWith.
//
// No materialization at all: every query normalizes and aggregates the three
// source collections from scratch. Always fresh, zero moving parts — and the
// cost grows with history, because each run re-reads everything.
//
// Run from the repo root:
//   set -a; source .env; set +a
//   mongosh "$MONGODB_URI" --quiet --file scripts/02_query_time_union.js
//
// Optional filters (environment variables):
//   SKU=SKU-001         filter by product
//   REGION=EMEA         filter by region
//   FROM=2026-08-01     inclusive day lower bound
//   TO=2026-08-27       inclusive day upper bound

load("scripts/lib/guard.js");
load("scripts/lib/normalize.js");

const DB_NAME = process.env.MONGODB_DATABASE || "mongo_analytics";
const dbx = db.getSiblingDB(DB_NAME);

// Build the post-normalization filter from the environment.
const filter = {};
if (process.env.SKU) filter.sku = process.env.SKU;
if (process.env.REGION) filter.region = process.env.REGION;
if (process.env.FROM || process.env.TO) {
  filter.day = {};
  if (process.env.FROM) filter.day.$gte = process.env.FROM;
  if (process.env.TO) filter.day.$lte = process.env.TO;
}

// One pipeline, three collections: normalize the base collection, then union
// in the other two — each normalized with its own pipeline — then filter,
// group to the rollup grain, and aggregate again for the report.
const pipeline = [
  ...NORMALIZE_ONLINE,
  { $unionWith: { coll: "sales_instore", pipeline: NORMALIZE_INSTORE } },
  { $unionWith: { coll: "sales_partners", pipeline: NORMALIZE_PARTNERS } },
  ...(Object.keys(filter).length ? [{ $match: filter }] : []),
  ...ROLLUP_GROUP,
  // Final report: revenue by product across the filtered window.
  {
    $group: {
      _id: { sku: "$sku", product: "$product" },
      revenue: { $sum: "$revenue" },
      units: { $sum: "$units" },
      days: { $addToSet: "$day" },
    },
  },
  {
    $project: {
      _id: 0,
      sku: "$_id.sku",
      product: "$_id.product",
      revenue: { $round: ["$revenue", 2] },
      units: 1,
      daysWithSales: { $size: "$days" },
    },
  },
  { $sort: { revenue: -1 } },
];

const sourceDocs =
  dbx.sales_online.estimatedDocumentCount() +
  dbx.sales_instore.estimatedDocumentCount() +
  dbx.sales_partners.estimatedDocumentCount();

print(`Query-time aggregation over ${sourceDocs} source documents`);
print(`Filters: ${Object.keys(filter).length ? JSON.stringify(filter) : "(none — full history)"}\n`);

const t0 = Date.now();
const results = dbx.sales_online.aggregate(pipeline).toArray();
const elapsed = Date.now() - t0;

print("sku      product                  units   revenue   days");
for (const r of results) {
  print(
    `${r.sku}  ${r.product.padEnd(22)} ${String(r.units).padStart(6)} ` +
    `${String(r.revenue.toFixed(2)).padStart(10)} ${String(r.daysWithSales).padStart(5)}`
  );
}

print(`\nElapsed: ${elapsed} ms — and every single query pays this again.`);
print("The filter runs AFTER normalization: all three collections are read in full each time.");
