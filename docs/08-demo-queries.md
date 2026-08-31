# 8 · Demo queries — copy, paste, run

Every query on this page is **self-contained**: no `load()`, no environment
variables, no helper scripts. Paste it straight into `mongosh` and it runs.
Scenario 5 is SQL, for the Athena query editor.

The scripts in [`scripts/`](../scripts) are the automated version of exactly
these queries — use them for setup and for the T-15 check. Use *this* page
when you want to type in front of a customer, or when someone asks you to send
"just the queries".

---

## Before you start

```sh
mongosh "mongodb+srv://<user>:<password>@<cluster>.mongodb.net/"
```

```js
use mongo_analytics
```

**One product, all five scenarios.** Every query below filters the same SKU,
so the answers are directly comparable:

```js
const SKU = "SKU-001";     // Trail Running Shoes
```

Catalog is `SKU-001` … `SKU-012` — see [`scripts/lib/catalog.js`](../scripts/lib/catalog.js).

**To time any query**, wrap it:

```js
const t0 = Date.now();
const rows = db.sales_rollup.aggregate([ /* ... */ ]).toArray();
print(`${Date.now() - t0} ms`);
console.table(rows);
```

---

## Act 0 — the shape problem (optional opener)

Three collections, three different document shapes. This is the whole reason
the demo exists:

```js
printjson(db.sales_online.findOne({}, { _id: 0 }));
printjson(db.sales_instore.findOne({}, { _id: 0 }));
printjson(db.sales_partners.findOne({}, { _id: 0 }));
```

Point at `sale_date: "2026-08-25"` in the partner document — a **string**.
Every approach has to absorb that.

```js
// how much data we are talking about
for (const c of ["sales_online", "sales_instore", "sales_partners"]) {
  print(`${c.padEnd(16)} ${db.getCollection(c).countDocuments()}`);
}
```

---

## Scenario 1 — Aggregation Pipeline (`$unionWith`)

Nothing is precomputed. One pipeline normalizes all three shapes at query
time and answers straight from the raw collections.

```js
db.sales_online.aggregate([
  // ── normalize: web orders ────────────────────────────────────────────────
  { $unwind: "$items" },
  { $project: {
      _id: 0,
      day: { $dateToString: { date: "$orderedAt", format: "%Y-%m-%d" } },
      channel: { $literal: "online" },
      region: "$region",
      sku: "$items.sku",
      product: "$items.product",
      units: "$items.qty",
      revenue: { $round: [{ $multiply: ["$items.qty", "$items.unitPrice"] }, 2] },
  } },

  // ── normalize: point of sale ─────────────────────────────────────────────
  { $unionWith: {
      coll: "sales_instore",
      pipeline: [
        { $unwind: "$lines" },
        { $project: {
            _id: 0,
            day: { $dateToString: { date: "$soldAt", format: "%Y-%m-%d" } },
            channel: { $literal: "instore" },
            region: "$storeRegion",
            sku: "$lines.productSku",
            product: "$lines.productName",
            units: "$lines.units",
            revenue: { $round: [{ $multiply: ["$lines.units", "$lines.unitPrice"] }, 2] },
        } },
      ],
  } },

  // ── normalize: partner feed (dates arrive as strings) ────────────────────
  { $unionWith: {
      coll: "sales_partners",
      pipeline: [
        { $project: {
            _id: 0,
            day: "$sale_date",
            channel: { $literal: "partner" },
            region: "$market",
            sku: "$product_sku",
            product: "$product_name",
            units: "$quantity",
            revenue: "$gross_value",
        } },
      ],
  } },

  // ── the report ───────────────────────────────────────────────────────────
  { $match: { sku: SKU } },
  { $group: {
      _id: "$channel",
      product: { $first: "$product" },
      units: { $sum: "$units" },
      revenue: { $sum: "$revenue" },
  } },
  { $project: { _id: 0, channel: "$_id", product: 1, units: 1,
                revenue: { $round: ["$revenue", 2] } } },
  { $sort: { channel: 1 } },
]);
```

**The line to say:** `$match` sits *after* normalization — it has to, because
the three collections name the product field differently. Every run reads all
three collections in full.

---

## Scenario 2 — Materialized Views (`sales_rollup`)

Two different queries live here, and the interesting one is the **write**.

### 2a · The query that BUILDS the view (`$merge`)

Paste this once — the same three normalization pipelines from scenario 1, now
as reusable constants, plus the grouping that defines the rollup grain:

```js
const NORMALIZE_ONLINE = [
  { $unwind: "$items" },
  { $project: {
      _id: 0,
      day: { $dateToString: { date: "$orderedAt", format: "%Y-%m-%d" } },
      channel: { $literal: "online" },
      region: "$region",
      sku: "$items.sku",
      product: "$items.product",
      units: "$items.qty",
      revenue: { $round: [{ $multiply: ["$items.qty", "$items.unitPrice"] }, 2] },
  } },
];

const NORMALIZE_INSTORE = [
  { $unwind: "$lines" },
  { $project: {
      _id: 0,
      day: { $dateToString: { date: "$soldAt", format: "%Y-%m-%d" } },
      channel: { $literal: "instore" },
      region: "$storeRegion",
      sku: "$lines.productSku",
      product: "$lines.productName",
      units: "$lines.units",
      revenue: { $round: [{ $multiply: ["$lines.units", "$lines.unitPrice"] }, 2] },
  } },
];

const NORMALIZE_PARTNERS = [
  { $project: {
      _id: 0,
      day: "$sale_date",
      channel: { $literal: "partner" },
      region: "$market",
      sku: "$product_sku",
      product: "$product_name",
      units: "$quantity",
      revenue: "$gross_value",
  } },
];

// The rollup grain: day × channel × region × product.
const ROLLUP_GROUP = [
  { $group: {
      _id: { day: "$day", channel: "$channel", region: "$region", sku: "$sku" },
      product: { $first: "$product" },
      units: { $sum: "$units" },
      revenue: { $sum: "$revenue" },
      orderLines: { $sum: 1 },
  } },
  // Copy the key fields to the top level so the view can be filtered and
  // indexed without reaching into _id.
  { $set: {
      day: "$_id.day", channel: "$_id.channel",
      region: "$_id.region", sku: "$_id.sku",
      revenue: { $round: ["$revenue", 2] },
  } },
];
```

**Full rebuild** — every day, from scratch:

```js
db.sales_rollup.drop();

db.sales_online.aggregate([
  ...NORMALIZE_ONLINE,
  { $unionWith: { coll: "sales_instore",  pipeline: NORMALIZE_INSTORE } },
  { $unionWith: { coll: "sales_partners", pipeline: NORMALIZE_PARTNERS } },
  ...ROLLUP_GROUP,
  { $set: { updatedAt: "$$NOW" } },
  { $merge: {
      into: "sales_rollup",
      on: "_id",
      whenMatched: "replace",     // ← the whole answer to "is it overwritten?"
      whenNotMatched: "insert",
  } },
]);
```

**Incremental refresh** — the version you would actually schedule. Identical
pipeline, with a window filter in front of each source and a watermark:

```js
const startedAt = new Date();                 // capture BEFORE reading
const LATENESS_HOURS = 48;                    // how far back to re-scan

const meta = db.analytics_meta.findOne({ _id: "sales_rollup" });
const sinceDay  = new Date(meta.lastRunAt.getTime() - LATENESS_HOURS * 3600e3)
                    .toISOString().slice(0, 10);
const sinceDate = new Date(sinceDay + "T00:00:00Z");
print(`recomputing days >= ${sinceDay}`);

db.sales_online.aggregate([
  { $match: { orderedAt: { $gte: sinceDate } } },          // indexed, pre-normalization
  ...NORMALIZE_ONLINE,
  { $unionWith: { coll: "sales_instore", pipeline: [
      { $match: { soldAt: { $gte: sinceDate } } },
      ...NORMALIZE_INSTORE ] } },
  { $unionWith: { coll: "sales_partners", pipeline: [
      { $match: { sale_date: { $gte: sinceDay } } },       // string date, string compare
      ...NORMALIZE_PARTNERS ] } },
  ...ROLLUP_GROUP,
  { $set: { updatedAt: "$$NOW" } },
  { $merge: { into: "sales_rollup", on: "_id",
              whenMatched: "replace", whenNotMatched: "insert" } },
]);

// advance the watermark so the next run starts where this one began
db.analytics_meta.updateOne(
  { _id: "sales_rollup" },
  { $set: { lastRunAt: startedAt }, $inc: { runs: 1 } },
  { upsert: true },
);

// the indexes the read query depends on (createIndex is idempotent)
db.sales_rollup.createIndex({ sku: 1, day: 1 });
db.sales_rollup.createIndex({ day: 1, region: 1 });
```

### Recreated or updated incrementally? — both, on two different axes

This is the question worth answering carefully, because "incremental" means
two unrelated things here:

| Axis | What happens | Controlled by |
| --- | --- | --- |
| **Which rows are recomputed** | Only days inside the watermark window. Rows for older days are never read and never touched. | the `$match` window + `analytics_meta.lastRunAt` |
| **How a recomputed row lands** | The row is **overwritten wholesale** — the new document replaces the old one entirely. | `whenMatched: "replace"` |

So the view is **incrementally refreshed, but each touched row is fully
recomputed and replaced.** Never partially updated, never accumulated.

That combination is what makes the job **idempotent**: the row for
`2026-08-26 / online / EMEA / SKU-001` is derived deterministically from the
source documents for that day, so running the refresh twice — or ten times —
produces byte-identical results. A crashed run is fixed by running it again;
there is no "did it apply twice?" question to answer.

Three contrasts worth saying out loud:

- **Why not `$out`?** `$out` replaces the *entire* collection. It would throw
  away the days outside the window, forcing a full rebuild every run, and it
  leaves the view empty or partial while it writes. `$merge` touches only the
  keys it produces, and readers never see a gap.
- **Why not `$inc`?** That is scenario 3's model: accumulate deltas. It is
  fresher, but it is *not* idempotent — applying the same event twice
  corrupts the total. `replace` recomputes from source instead of adjusting.
- **Why the 48-hour lateness buffer?** A sale can arrive after its day has
  been rolled up (the partner file lands late). Re-scanning the last two days
  every run absorbs stragglers, and because the rewrite is a replace, doing
  that work redundantly costs time but can never corrupt a number.

Verify the idempotency claim in front of the customer — run the incremental
block twice and compare:

```js
db.sales_rollup.aggregate([
  { $group: { _id: null, rows: { $sum: 1 }, units: { $sum: "$units" },
              revenue: { $sum: "$revenue" } } },
]);
```

### 2b · The query that READS the view

All the work above happened on a schedule. What the user runs is this:

```js
db.sales_rollup.aggregate([
  { $match: { sku: SKU } },
  { $group: {
      _id: "$channel",
      product: { $first: "$product" },
      units: { $sum: "$units" },
      revenue: { $sum: "$revenue" },
  } },
  { $project: { _id: 0, channel: "$_id", product: 1, units: 1,
                revenue: { $round: ["$revenue", 2] } } },
  { $sort: { channel: 1 } },
]);
```

Same numbers as scenario 1, a fraction of the work — and flat as history
grows, because it reads rollup rows instead of sale lines.

```js
// what a rollup row looks like
db.sales_rollup.findOne({ sku: SKU });

// how old is this view?
db.sales_rollup.find().sort({ updatedAt: -1 }).limit(1).next().updatedAt;

// the watermark the next incremental run will resume from
db.analytics_meta.find().toArray();
```

---

## Scenario 3 — Atlas Triggers (`sales_rollup_live`)

### 3a · The process that BUILDS the collection

**This one does not run in `mongosh`.** The write path is an Atlas Function
invoked by three Database Triggers — deployed by
[`scripts/05_setup_triggers.sh`](../scripts/05_setup_triggers.sh), or pasted
into **Atlas → Triggers → Functions**:

```js
exports = async function (changeEvent) {
  const doc = changeEvent.fullDocument;
  const round2 = (n) => Math.round(n * 100) / 100;
  const dayOf = (d) => d.toISOString().slice(0, 10);

  // Normalize ONE document — the same contract as the pipelines in 2a,
  // rewritten in JavaScript because a function is not an aggregation.
  let lines = [];
  if (changeEvent.ns.coll === "sales_online") {
    const day = dayOf(doc.orderedAt);
    lines = doc.items.map((i) => ({
      day, channel: "online", region: doc.region,
      sku: i.sku, product: i.product,
      units: i.qty, revenue: round2(i.qty * i.unitPrice),
    }));
  } else if (changeEvent.ns.coll === "sales_instore") {
    const day = dayOf(doc.soldAt);
    lines = doc.lines.map((l) => ({
      day, channel: "instore", region: doc.storeRegion,
      sku: l.productSku, product: l.productName,
      units: l.units, revenue: round2(l.units * l.unitPrice),
    }));
  } else {
    lines = [{
      day: doc.sale_date, channel: "partner", region: doc.market,
      sku: doc.product_sku, product: doc.product_name,
      units: doc.quantity, revenue: doc.gross_value,
    }];
  }

  const rollup = context.services.get("mongodb-atlas")
    .db("mongo_analytics").collection("sales_rollup_live");

  // Atomic upserts: concurrent invocations never lose increments.
  // A read-modify-write here would.
  const now = new Date();
  await rollup.bulkWrite(lines.map((l) => ({
    updateOne: {
      filter: { _id: { day: l.day, channel: l.channel, region: l.region, sku: l.sku } },
      update: {
        $inc: { units: l.units, revenue: l.revenue, orderLines: 1 },
        $set: { day: l.day, channel: l.channel, region: l.region,
                sku: l.sku, product: l.product, updatedAt: now },
      },
      upsert: true,
    },
  })), { ordered: false });
};
```

And the trigger that calls it — one per source collection, `INSERT` only:

```json
{
  "name": "onInsert_sales_online",
  "type": "DATABASE",
  "function_id": "<id of the function above>",
  "config": {
    "service_id": "<linked cluster>",
    "database": "mongo_analytics",
    "collection": "sales_online",
    "operation_types": ["INSERT"],
    "full_document": true
  },
  "disabled": false
}
```

Repeat for `sales_instore` and `sales_partners`. All three point at the same
function — that is why the function has to branch on `changeEvent.ns.coll`.

**There is no CREATE step for the collection.** `upsert: true` creates
`sales_rollup_live` on the first sale that arrives, and each `_id` on first
touch. Nothing declares a schema.

**Reproduce one trigger invocation by hand**, to show exactly what a single
event does to the rollup:

```js
// ⚠️ Only with the triggers DISABLED — otherwise this double-counts the order.
const doc = db.sales_online.find().sort({ orderedAt: -1 }).limit(1).next();
const day = doc.orderedAt.toISOString().slice(0, 10);
const round2 = (n) => Math.round(n * 100) / 100;

db.sales_rollup_live.bulkWrite(doc.items.map((i) => ({
  updateOne: {
    filter: { _id: { day, channel: "online", region: doc.region, sku: i.sku } },
    update: {
      $inc: { units: i.qty, revenue: round2(i.qty * i.unitPrice), orderLines: 1 },
      $set: { day, channel: "online", region: doc.region, sku: i.sku,
              product: i.product, updatedAt: new Date() },
    },
    upsert: true,
  },
})), { ordered: false });
```

**Bootstrapping history.** Triggers only see inserts that happen *after* they
exist, so the collection starts empty and can never agree with the batch view
until you backfill it. Every CDC approach in production ships with exactly
this batch job — run it with the triggers **disabled**, using the constants
from [2a](#2a--the-query-that-builds-the-view-merge):

```js
db.sales_rollup_live.drop();

db.sales_online.aggregate([
  ...NORMALIZE_ONLINE,
  { $unionWith: { coll: "sales_instore",  pipeline: NORMALIZE_INSTORE } },
  { $unionWith: { coll: "sales_partners", pipeline: NORMALIZE_PARTNERS } },
  ...ROLLUP_GROUP,
  { $set: { updatedAt: "$$NOW" } },
  { $merge: { into: "sales_rollup_live", on: "_id",
              whenMatched: "replace", whenNotMatched: "insert" } },
]);

db.sales_rollup_live.createIndex({ sku: 1, day: 1 });
```

Worth pointing out on stage: the *bootstrap* of the trigger approach is
scenario 2's pipeline. The triggers only maintain it from there.

### 3b · The query that READS the collection

Identical to scenario 2's read query, different collection:

```js
db.sales_rollup_live.aggregate([
  { $match: { sku: SKU } },
  { $group: {
      _id: "$channel",
      product: { $first: "$product" },
      units: { $sum: "$units" },
      revenue: { $sum: "$revenue" },
  } },
  { $project: { _id: 0, channel: "$_id", product: 1, units: 1,
                revenue: { $round: ["$revenue", 2] } } },
  { $sort: { channel: 1 } },
]);
```

Show that it moves in real time — run it twice with the live writer going:

```js
db.sales_rollup_live.find().sort({ updatedAt: -1 }).limit(1).next();
```

**The query that exposes the structural limit.** Ask for something that is not
an incrementable counter and the collection simply cannot answer it:

```js
// average units per order line — NOT derivable from $inc counters alone
db.sales_rollup_live.aggregate([
  { $match: { sku: SKU } },
  { $group: { _id: "$channel", avgUnitsPerLine: { $avg: "$units" } } },
]);
```

That average is per *rollup row*, not per sale — the real answer was lost at
write time, because each trigger invocation saw exactly one document.

---

## Scenario 4 — Stream Processing (`sales_rollup_stream`)

### 4a · The process that BUILDS the collection

**Connect to the Stream Processing workspace, not to the cluster** — this is
the step people get wrong:

```sh
# 06_setup_stream_workspace.sh prints the hostname
mongosh "mongodb://<workspace-hostname>/" --tls \
  --authenticationDatabase admin -u <db_user> -p
```

The whole processor, as one paste:

```js
sp.createStreamProcessor("salesRollupProcessor", [
  // ── source: ONE database-level change stream covers all three collections ──
  { $source: {
      connectionName: "atlasCluster",
      db: "mongo_analytics",
      config: {
        // The filter lives INSIDE the source, so it runs in the change stream
        // itself and irrelevant events never enter the processor. Insert
        // events carry fullDocument natively — no pre/post-image config needed.
        pipeline: [
          { $match: { operationType: "insert",
                      "ns.coll": { $in: ["sales_online", "sales_instore", "sales_partners"] } } },
        ],
      },
  } },

  // ── normalize: one $switch, because one stream carries three shapes ────────
  { $project: {
      lines: { $switch: {
        branches: [
          { case: { $eq: ["$ns.coll", "sales_online"] },
            then: { $map: { input: "$fullDocument.items", as: "i", in: {
              day: { $dateToString: { date: "$fullDocument.orderedAt", format: "%Y-%m-%d" } },
              channel: "online", region: "$fullDocument.region",
              sku: "$$i.sku", product: "$$i.product", units: "$$i.qty",
              revenue: { $round: [{ $multiply: ["$$i.qty", "$$i.unitPrice"] }, 2] },
            } } } },
          { case: { $eq: ["$ns.coll", "sales_instore"] },
            then: { $map: { input: "$fullDocument.lines", as: "l", in: {
              day: { $dateToString: { date: "$fullDocument.soldAt", format: "%Y-%m-%d" } },
              channel: "instore", region: "$fullDocument.storeRegion",
              sku: "$$l.productSku", product: "$$l.productName", units: "$$l.units",
              revenue: { $round: [{ $multiply: ["$$l.units", "$$l.unitPrice"] }, 2] },
            } } } },
        ],
        default: [{
          day: "$fullDocument.sale_date", channel: "partner",
          region: "$fullDocument.market", sku: "$fullDocument.product_sku",
          product: "$fullDocument.product_name", units: "$fullDocument.quantity",
          revenue: "$fullDocument.gross_value",
        }],
      } },
  } },

  // ── the window: what makes $group possible on an unbounded stream ─────────
  { $tumblingWindow: {
      interval: { size: NumberInt(10), unit: "second" },
      // Windows close when event time passes their end, which needs newer
      // events. idleTimeout closes the last window when traffic pauses.
      idleTimeout: { size: NumberInt(15), unit: "second" },
      pipeline: [
        { $unwind: "$lines" },
        { $replaceRoot: { newRoot: "$lines" } },
        { $group: {
            _id: { day: "$day", channel: "$channel", region: "$region", sku: "$sku" },
            product: { $first: "$product" },
            units: { $sum: "$units" },
            revenue: { $sum: "$revenue" },
            orderLines: { $sum: 1 },
        } },
        { $set: {
            day: "$_id.day", channel: "$_id.channel",
            region: "$_id.region", sku: "$_id.sku",
            revenue: { $round: ["$revenue", 2] },
        } },
      ],
  } },

  // ── sink: ACCUMULATE each window's partial sums into the running totals ───
  { $merge: {
      into: { connectionName: "atlasCluster", db: "mongo_analytics",
              coll: "sales_rollup_stream" },
      on: "_id",
      whenMatched: [
        { $set: {
            product: "$$new.product",
            units: { $add: ["$units", "$$new.units"] },
            revenue: { $round: [{ $add: ["$revenue", "$$new.revenue"] }, 2] },
            orderLines: { $add: ["$orderLines", "$$new.orderLines"] },
            day: "$$new.day", channel: "$$new.channel",
            region: "$$new.region", sku: "$$new.sku",
            updatedAt: "$$NOW",
        } },
      ],
      whenNotMatched: "insert",
  } },
], {
  // failed documents land here instead of being silently dropped
  dlq: { connectionName: "atlasCluster", db: "mongo_analytics", coll: "asp_dlq" },
});

sp.salesRollupProcessor.start();
```

Lifecycle, from the same shell:

```js
sp.listStreamProcessors();
sp.salesRollupProcessor.stats();      // inputMessageCount / outputMessageCount / dlqMessageCount
sp.salesRollupProcessor.stop();       // definition kept — start() resumes from its checkpoint
sp.salesRollupProcessor.drop();       // delete it (do this when the demo ends: SP10 bills hourly)
```

**Note the sink is an accumulating `$merge`, not a `replace`.** Each window
emits *partial* sums for its 10 seconds, so the pipeline in `whenMatched` adds
them to what is already there. Compare with scenario 2, where `replace` was
what made reruns safe: here, at-least-once delivery means a crash between
checkpoint and merge could double-apply one window. That is acceptable for a
dashboard — and it is precisely why the nightly batch stays the reconciliation
of record.

**The collection is created by the first `$merge`**, exactly like the trigger
case. And exactly like the trigger case, the processor only sees new inserts,
so history needs the same backfill — with the processor **dropped**:

```js
// run on the CLUSTER connection, with the constants from 2a
db.sales_rollup_stream.drop();

db.sales_online.aggregate([
  ...NORMALIZE_ONLINE,
  { $unionWith: { coll: "sales_instore",  pipeline: NORMALIZE_INSTORE } },
  { $unionWith: { coll: "sales_partners", pipeline: NORMALIZE_PARTNERS } },
  ...ROLLUP_GROUP,
  { $set: { updatedAt: "$$NOW" } },
  { $merge: { into: "sales_rollup_stream", on: "_id",
              whenMatched: "replace", whenNotMatched: "insert" } },
]);

db.sales_rollup_stream.createIndex({ sku: 1, day: 1 });
```

### 4b · The query that READS the collection

Identical query again:

```js
db.sales_rollup_stream.aggregate([
  { $match: { sku: SKU } },
  { $group: {
      _id: "$channel",
      product: { $first: "$product" },
      units: { $sum: "$units" },
      revenue: { $sum: "$revenue" },
  } },
  { $project: { _id: 0, channel: "$_id", product: 1, units: 1,
                revenue: { $round: ["$revenue", 2] } } },
  { $sort: { channel: 1 } },
]);
```

Freshness and health, while the writer runs:

```js
db.sales_rollup_stream.find().sort({ updatedAt: -1 }).limit(1).next().updatedAt;
db.asp_dlq.countDocuments();     // dead-letter queue — should be 0
```

---

## All four, side by side

One paste, four collections, the same question — this is the slide that makes
the point:

```js
const report = [
  { $match: { sku: SKU } },
  { $group: { _id: "$channel", units: { $sum: "$units" }, revenue: { $sum: "$revenue" } } },
  { $project: { _id: 0, channel: "$_id", units: 1, revenue: { $round: ["$revenue", 2] } } },
  { $sort: { channel: 1 } },
];

for (const [label, coll] of [
  ["batch   (2)", "sales_rollup"],
  ["triggers(3)", "sales_rollup_live"],
  ["stream  (4)", "sales_rollup_stream"],
]) {
  const t0 = Date.now();
  const rows = db.getCollection(coll).aggregate(report).toArray();
  const u = rows.reduce((a, r) => a + r.units, 0);
  const v = rows.reduce((a, r) => a + r.revenue, 0);
  print(`${label}  units=${String(u).padStart(6)}  revenue=${v.toFixed(2).padStart(12)}  (${Date.now() - t0} ms)`);
}
```

With the live writer **stopped**, all three totals match to the cent. With it
**running**, 3 and 4 run ahead of 2 — which is the freshness axis of the
evaluation matrix, made visible in one screen.

---

## Scenario 5 — ASP with `$iceberg` (Athena SQL)

### 5a · The process that BUILDS the table

Two halves: AWS resources created once, then a stream processor that writes
the table and registers it in the catalog.

**AWS side** — provisioned by
[`scripts/11_setup_lakehouse_aws.sh`](../scripts/11_setup_lakehouse_aws.sh):

- an **S3 bucket** (`mongo-analytics-lake-<account-id>`) for the warehouse;
- a **Glue database** named `sales` — the catalog Athena reads;
- an **IAM role** trusted by the Atlas AWS account with an external id. It
  needs `s3:ListAllMyBuckets` **account-wide** on top of the bucket-scoped
  permissions, or the connection test fails with *"Unable to authorize AWS
  connection"*;
- an **Atlas connection** named `salesLake` in the workspace's Connection
  Registry. The body takes the role **ARN**, not the Atlas `roleId` — passing
  `roleId` returns `Invalid attribute roleId specified`:

  ```json
  { "name": "salesLake", "type": "S3",
    "aws": { "roleArn": "arn:aws:iam::<account-id>:role/mongodb-atlas-lakehouse-demo",
             "testBucket": "mongo-analytics-lake-<account-id>" } }
  ```

**MongoDB side** — same workspace connection as scenario 4:

```sh
mongosh "mongodb://<workspace-hostname>/" --tls \
  --authenticationDatabase admin -u <db_user> -p
```

```js
sp.createStreamProcessor("lakeSnapshotProcessor", [
  // Source the batch view, not the raw collections: initialSync replays every
  // existing row as if it were just inserted, then keeps following changes.
  { $source: {
      connectionName: "atlasCluster",
      db: "mongo_analytics",
      coll: "sales_rollup",
      initialSync: { enable: true },
      config: { fullDocument: "required" },
  } },
  { $match: { operationType: { $in: ["insert", "update", "replace"] } } },
  { $replaceRoot: { newRoot: "$fullDocument" } },

  // Iceberg CDC keys rows by idFieldName, so flatten the composite _id into a
  // deterministic string.
  //
  // The casts are NOT cosmetic. Iceberg columns are statically typed and the
  // schema is inferred from the first documents seen; BSON is dynamically
  // typed, and $round returns an int for a whole value (236) and a double
  // otherwise (236.5). Without these casts a `revenue` column typed double
  // rejects every whole-valued row — quietly, into the DLQ.
  { $set: {
      _id: { $concat: ["$day", "|", "$channel", "|", "$region", "|", "$sku"] },
      revenue: { $toDouble: "$revenue" },
      units: { $toLong: "$units" },
      orderLines: { $toLong: "$orderLines" },
  } },

  { $iceberg: {
      connectionName: "salesLake",
      bucket: "mongo-analytics-lake-<account-id>",
      path: "iceberg-warehouse",     // NO trailing slash — the API rejects it
      databaseName: "sales",
      tableName: "sales_rollup",
      mode: "cdc",                   // row-level upserts keyed by idFieldName
      idFieldName: "_id",
      catalog: { type: "glue" },
  } },
], {
  dlq: { connectionName: "atlasCluster", db: "mongo_analytics", coll: "asp_dlq" },
});

sp.lakeSnapshotProcessor.start();
```

`$iceberg` must be the **last** stage, there is one per pipeline, and sinks
are mutually exclusive — a processor writes to a collection *or* to the lake.
Two audiences means two processors on the same source.

**Watch it fill, then freeze it:**

```js
sp.lakeSnapshotProcessor.stats();   // repeat until output == input and dlq == 0
sp.lakeSnapshotProcessor.drop();    // the table is now a static snapshot
```

**There is no `CREATE TABLE` anywhere.** MongoDB writes the Parquet files
*and* registers the table in the Glue catalog, including the column types it
inferred. Athena discovers it — that is the point of an open table format,
and it is the single best thing to show a data-platform team. Prove it in the
query editor:

```sql
SHOW CREATE TABLE sales.sales_rollup;
```

Read out `table_type='ICEBERG'`, the S3 `location`, and `revenue double` /
`units bigint` — the schema MongoDB chose when it wrote the table.

### 5b · The query that READS the table

Not MongoDB: Athena, over Iceberg files on S3. In the console, set **Data
source** `AwsDataCatalog` and **Database** `sales`, on workgroup
`mongodb-lakehouse-demo`.

```sql
SELECT channel,
       SUM(units)             AS units,
       ROUND(SUM(revenue), 2) AS revenue
FROM sales.sales_rollup
WHERE sku = 'SKU-001'
GROUP BY channel
ORDER BY channel;
```

Same numbers as the MongoDB batch view, down to the cent — and MongoDB is not
in this read path.

Worth running while you are there:

```sql
-- the whole rollup, one row per grain
SELECT COUNT(*) FROM sales.sales_rollup;

-- the question the lake answers that MongoDB alone cannot:
-- full SQL over years of history, joinable to finance and inventory tables
SELECT day, SUM(revenue) AS revenue
FROM sales.sales_rollup
WHERE sku = 'SKU-001'
GROUP BY day
ORDER BY day;
```

Point at **Run time** and **Data scanned** under the result panel — that is
the lakehouse cost model, made visible.

---

## Extra angles, if the customer asks

All against `sales_rollup` (swap the collection for any other scenario).

```js
// by region instead of channel — same grain, no re-engineering
db.sales_rollup.aggregate([
  { $match: { sku: SKU } },
  { $group: { _id: "$region", units: { $sum: "$units" }, revenue: { $sum: "$revenue" } } },
  { $sort: { revenue: -1 } },
]);

// top 5 products overall
db.sales_rollup.aggregate([
  { $group: { _id: { sku: "$sku", product: "$product" }, revenue: { $sum: "$revenue" } } },
  { $project: { _id: 0, sku: "$_id.sku", product: "$_id.product",
                revenue: { $round: ["$revenue", 2] } } },
  { $sort: { revenue: -1 } },
  { $limit: 5 },
]);

// one product, one week, day by day
db.sales_rollup.aggregate([
  { $match: { sku: SKU, day: { $gte: "2026-08-20", $lte: "2026-08-27" } } },
  { $group: { _id: "$day", revenue: { $sum: "$revenue" }, units: { $sum: "$units" } } },
  { $sort: { _id: 1 } },
]);

// how many rows does the rollup hold, versus the raw collections?
db.sales_rollup.countDocuments();
```

That last one is the compression argument: tens of thousands of sale lines
collapse into a few thousand rollup rows, and every report reads the small
collection.

**Back to:** [Demo runbook](06-demo-runbook.md) · [Evaluation matrix](07-evaluation-matrix.md) · [README](../README.md)
