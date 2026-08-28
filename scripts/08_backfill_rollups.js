// Backfill `sales_rollup_live` and `sales_rollup_stream` from the source
// collections — used by the demo reset (10_reset_demo.sh).
//
// Why this exists: triggers and stream processors only see NEW inserts.
// After reseeding, their rollups would start empty and the five scenarios
// could never agree. Every CDC approach in real life ships with exactly this
// batch backfill for history — the reset just makes that explicit.
//
// Must run while the triggers are DISABLED and the stream processor is
// DROPPED, so the backfilled rows are not double-counted by live capture.
//
//   mongosh "$MONGODB_URI" --quiet --file scripts/08_backfill_rollups.js

load("scripts/lib/guard.js");
load("scripts/lib/normalize.js");

const DB_NAME = process.env.MONGODB_DATABASE || "mongo_analytics";
const dbx = db.getSiblingDB(DB_NAME);

for (const target of ["sales_rollup_live", "sales_rollup_stream"]) {
  dbx[target].drop();
  const t0 = Date.now();
  dbx.sales_online.aggregate([
    ...NORMALIZE_ONLINE,
    { $unionWith: { coll: "sales_instore", pipeline: NORMALIZE_INSTORE } },
    { $unionWith: { coll: "sales_partners", pipeline: NORMALIZE_PARTNERS } },
    ...ROLLUP_GROUP,
    { $set: { updatedAt: "$$NOW" } },
    { $merge: { into: target, on: "_id", whenMatched: "replace", whenNotMatched: "insert" } },
  ]);
  dbx[target].createIndex({ sku: 1, day: 1 });
  dbx[target].createIndex({ day: 1, region: 1 });
  print(`${target}: backfilled ${dbx[target].countDocuments()} rows in ${Date.now() - t0} ms`);
}
