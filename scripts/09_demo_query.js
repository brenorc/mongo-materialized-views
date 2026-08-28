// THE demo query — one business question, asked of every scenario:
//
//   "Sales report by channel for one specific product."
//
// Identical output format for every target, so the audience can compare
// results (and timings) side by side across scenarios.
//
//   TARGET=union   mongosh "$MONGODB_URI" --quiet --file scripts/09_demo_query.js
//   TARGET=batch   ...   (reads sales_rollup)
//   TARGET=live    ...   (reads sales_rollup_live,   maintained by triggers)
//   TARGET=stream  ...   (reads sales_rollup_stream, maintained by ASP)
//
// Options: SKU (default SKU-001).

load("scripts/lib/guard.js");
load("scripts/lib/normalize.js");

const DB_NAME = process.env.MONGODB_DATABASE || "mongo_analytics";
const TARGET = process.env.TARGET || "union";
const SKU = process.env.SKU || "SKU-001";
const dbx = db.getSiblingDB(DB_NAME);

// The report itself: identical for every target once we have unified lines
// or rollup rows to read.
const report = [
  { $match: { sku: SKU } },
  {
    $group: {
      _id: "$channel",
      product: { $first: "$product" },
      units: { $sum: "$units" },
      revenue: { $sum: "$revenue" },
    },
  },
  { $project: { _id: 0, channel: "$_id", product: 1, units: 1, revenue: { $round: ["$revenue", 2] } } },
  { $sort: { channel: 1 } },
];

const TARGETS = {
  union: {
    label: "query-time $unionWith over the 3 raw collections",
    run: () =>
      dbx.sales_online.aggregate([
        ...NORMALIZE_ONLINE,
        { $unionWith: { coll: "sales_instore", pipeline: NORMALIZE_INSTORE } },
        { $unionWith: { coll: "sales_partners", pipeline: NORMALIZE_PARTNERS } },
        ...report,
      ]),
  },
  batch:  { label: "materialized view `sales_rollup` (scheduled batch)",        run: () => dbx.sales_rollup.aggregate(report) },
  live:   { label: "materialized view `sales_rollup_live` (database triggers)", run: () => dbx.sales_rollup_live.aggregate(report) },
  stream: { label: "materialized view `sales_rollup_stream` (stream processing)", run: () => dbx.sales_rollup_stream.aggregate(report) },
};

if (!TARGETS[TARGET]) {
  print(`unknown TARGET '${TARGET}' — use union | batch | live | stream`);
  quit(1);
}

const t0 = Date.now();
const rows = TARGETS[TARGET].run().toArray();
const elapsed = Date.now() - t0;

print(`Sales by channel — ${SKU}${rows[0] ? " (" + rows[0].product + ")" : ""}`);
print(`Source: ${TARGETS[TARGET].label}\n`);
print("channel     units     revenue");
let tu = 0, tr = 0;
for (const r of rows) {
  tu += Number(r.units); tr += r.revenue;
  print(`${r.channel.padEnd(9)} ${String(r.units).padStart(7)} ${r.revenue.toFixed(2).padStart(12)}`);
}
print(`${"TOTAL".padEnd(9)} ${String(tu).padStart(7)} ${tr.toFixed(2).padStart(12)}`);
print(`\n(${elapsed} ms)`);
