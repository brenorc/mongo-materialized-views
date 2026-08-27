// Approach 3 — the Atlas Function deployed by 05_setup_triggers.sh.
//
// One function serves three Database Triggers (one per source collection).
// Each INSERT invokes it with the change event; it normalizes that single
// document into sale lines and applies atomic $inc upserts to the
// `sales_rollup_live` collection.
//
// Note what is DIFFERENT from the batch pipeline: there is no window and no
// $group here. Each invocation sees exactly one document, so the rollup can
// only be maintained with atomic counters — this is the structural limit of
// per-document triggers that the explainer talks about. Sums and counts
// work; averages, distinct counts or top-N would not.
//
// This demo treats sales as append-only and only subscribes to INSERT.
// Handling updates/deletes would require pre-images to subtract the old
// values — see docs/03-database-triggers.md.

exports = async function (changeEvent) {
  const doc = changeEvent.fullDocument;
  const sourceColl = changeEvent.ns.coll;

  const round2 = (n) => Math.round(n * 100) / 100;
  const dayOf = (d) => d.toISOString().slice(0, 10);

  // Normalize the single changed document into unified sale lines —
  // the same contract as scripts/lib/normalize.js, expressed in JS.
  let lines = [];
  if (sourceColl === "sales_online") {
    const day = dayOf(doc.orderedAt);
    lines = doc.items.map((i) => ({
      day, channel: "online", region: doc.region,
      sku: i.sku, product: i.product,
      units: i.qty, revenue: round2(i.qty * i.unitPrice),
    }));
  } else if (sourceColl === "sales_instore") {
    const day = dayOf(doc.soldAt);
    lines = doc.lines.map((l) => ({
      day, channel: "instore", region: doc.storeRegion,
      sku: l.productSku, product: l.productName,
      units: l.units, revenue: round2(l.units * l.unitPrice),
    }));
  } else if (sourceColl === "sales_partners") {
    lines = [{
      day: doc.sale_date, channel: "partner", region: doc.market,
      sku: doc.product_sku, product: doc.product_name,
      units: doc.quantity, revenue: doc.gross_value,
    }];
  } else {
    return; // not a collection we know
  }

  const rollup = context.services
    .get("mongodb-atlas")
    .db("mongo_analytics")
    .collection("sales_rollup_live");

  // Atomic upserts: concurrent invocations across the three triggers never
  // lose increments. A read-modify-write here would.
  const now = new Date();
  const ops = lines.map((l) => ({
    updateOne: {
      filter: { _id: { day: l.day, channel: l.channel, region: l.region, sku: l.sku } },
      update: {
        $inc: { units: l.units, revenue: l.revenue, orderLines: 1 },
        $set: {
          day: l.day, channel: l.channel, region: l.region,
          sku: l.sku, product: l.product, updatedAt: now,
        },
      },
      upsert: true,
    },
  }));
  await rollup.bulkWrite(ops, { ordered: false });
};
