// Side-by-side: the same business question answered two ways.
//
//   A. Query-time $unionWith over the three raw collections (approach 1)
//   B. A find/aggregate on the pre-aggregated `sales_rollup` view (approach 2)
//
// Same numbers, very different cost — and the gap widens as history grows,
// because A re-reads everything while B reads a few indexed rollup rows.
//
// Run from the repo root (after 03_batch_refresh.js):
//   set -a; source .env; set +a
//   mongosh "$MONGODB_URI" --quiet --file scripts/04_compare_query_vs_rollup.js
//
// Same optional filters as 02: SKU, REGION, FROM, TO.

load("scripts/lib/guard.js");
load("scripts/lib/normalize.js");

const DB_NAME = process.env.MONGODB_DATABASE || "mongo_analytics";
const dbx = db.getSiblingDB(DB_NAME);

const filter = {};
if (process.env.SKU) filter.sku = process.env.SKU;
if (process.env.REGION) filter.region = process.env.REGION;
if (process.env.FROM || process.env.TO) {
  filter.day = {};
  if (process.env.FROM) filter.day.$gte = process.env.FROM;
  if (process.env.TO) filter.day.$lte = process.env.TO;
}

const report = [
  {
    $group: {
      _id: { sku: "$sku", product: "$product" },
      revenue: { $sum: "$revenue" },
      units: { $sum: "$units" },
    },
  },
  {
    $project: {
      _id: 0, sku: "$_id.sku", product: "$_id.product",
      revenue: { $round: ["$revenue", 2] }, units: 1,
    },
  },
  { $sort: { revenue: -1 } },
  { $limit: 5 },
];

print(`Question: top products by revenue, filters ${Object.keys(filter).length ? JSON.stringify(filter) : "(none)"}\n`);

// ── A. From the raw collections, at query time ─────────────────────────────
const rawPipeline = [
  ...NORMALIZE_ONLINE,
  { $unionWith: { coll: "sales_instore", pipeline: NORMALIZE_INSTORE } },
  { $unionWith: { coll: "sales_partners", pipeline: NORMALIZE_PARTNERS } },
  ...(Object.keys(filter).length ? [{ $match: filter }] : []),
  ...report,
];
let t0 = Date.now();
const fromRaw = dbx.sales_online.aggregate(rawPipeline).toArray();
const rawMs = Date.now() - t0;

// ── B. From the materialized view ──────────────────────────────────────────
const viewPipeline = [
  ...(Object.keys(filter).length ? [{ $match: filter }] : []),
  ...report,
];
t0 = Date.now();
const fromView = dbx.sales_rollup.aggregate(viewPipeline).toArray();
const viewMs = Date.now() - t0;

// ── Results ────────────────────────────────────────────────────────────────
const sourceDocs =
  dbx.sales_online.estimatedDocumentCount() +
  dbx.sales_instore.estimatedDocumentCount() +
  dbx.sales_partners.estimatedDocumentCount();

print("A. query-time union            B. materialized view");
for (let i = 0; i < Math.max(fromRaw.length, fromView.length); i++) {
  const a = fromRaw[i], b = fromView[i];
  print(
    `${a ? (a.sku + "  " + a.revenue.toFixed(2)).padEnd(28) : "".padEnd(28)}   ` +
    `${b ? b.sku + "  " + b.revenue.toFixed(2) : ""}`
  );
}

const agree = JSON.stringify(fromRaw) === JSON.stringify(fromView);
print(`\nSame answer from both paths: ${agree ? "YES" : "NO — view is stale, run 03_batch_refresh.js"}`);
print(`A: ${rawMs} ms scanning ${sourceDocs} source documents`);
print(`B: ${viewMs} ms reading ${dbx.sales_rollup.countDocuments(filter)} pre-aggregated rows`);
print(`Speedup: ${(rawMs / Math.max(viewMs, 1)).toFixed(1)}x — and B's cost no longer grows with history.`);
if (!agree) {
  print("\n(Disagreement is itself didactic: it shows the freshness gap of a batch view.)");
}
