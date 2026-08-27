// Approach 4 — the continuous stream processor.
//
// Runs against the STREAM PROCESSING WORKSPACE (not the cluster!):
//
//   set -a; source .env; set +a
//   mongosh "mongodb://<workspace-hostname>/" --tls --authenticationDatabase admin \
//     -u <db_user> -p <password> --quiet --file scripts/07_stream_processor.js
//
// (06_setup_stream_workspace.sh prints the exact hostname.)
//
// What it builds — one processor, `salesRollupProcessor`:
//   $source          database-level change stream on mongo_analytics
//   $match           inserts into the three source collections only
//   normalization    $switch per collection → unified sale lines (same
//                    contract as scripts/lib/normalize.js)
//   $tumblingWindow  10-second windows running the SAME $group as the batch
//   $merge           accumulates each window's partial sums into
//                    sales_rollup_stream ($$new pipeline on match)
//
// Control via environment variable ACTION: create (default) | stats | stop |
// start | drop. `create` is idempotent — it drops and recreates, then starts.

const ACTION = process.env.ACTION || "create";
const NAME = "salesRollupProcessor";
const CONN = process.env.ASP_CONNECTION_NAME || "BrenoM10Conn";
const DB = process.env.MONGODB_DATABASE || "mongo_analytics";
const SOURCES = ["sales_online", "sales_instore", "sales_partners"];

// ── The pipeline ────────────────────────────────────────────────────────────

// A database-level change stream sees EVERYTHING in mongo_analytics —
// including the rollup collections this demo's other approaches write to.
// The filter therefore lives INSIDE the $source (config.pipeline): it runs
// within the change stream itself, so irrelevant events never even enter the
// processor. Insert events always carry `fullDocument` natively, so no
// pre/post-image configuration is needed for an insert-only stream.
const source = {
  $source: {
    connectionName: CONN,
    db: DB, // database-level change stream: one processor covers all three collections
    config: {
      pipeline: [{ $match: { operationType: "insert", "ns.coll": { $in: SOURCES } } }],
    },
  },
};

// Normalize each change event into an array of unified sale lines.
// Same shapes as scripts/lib/normalize.js, expressed as a $switch because a
// single stream carries all three document shapes.
const normalize = {
  $project: {
    lines: {
      $switch: {
        branches: [
          {
            case: { $eq: ["$ns.coll", "sales_online"] },
            then: {
              $map: {
                input: "$fullDocument.items",
                as: "i",
                in: {
                  day: { $dateToString: { date: "$fullDocument.orderedAt", format: "%Y-%m-%d" } },
                  channel: "online",
                  region: "$fullDocument.region",
                  sku: "$$i.sku",
                  product: "$$i.product",
                  units: "$$i.qty",
                  revenue: { $round: [{ $multiply: ["$$i.qty", "$$i.unitPrice"] }, 2] },
                },
              },
            },
          },
          {
            case: { $eq: ["$ns.coll", "sales_instore"] },
            then: {
              $map: {
                input: "$fullDocument.lines",
                as: "l",
                in: {
                  day: { $dateToString: { date: "$fullDocument.soldAt", format: "%Y-%m-%d" } },
                  channel: "instore",
                  region: "$fullDocument.storeRegion",
                  sku: "$$l.productSku",
                  product: "$$l.productName",
                  units: "$$l.units",
                  revenue: { $round: [{ $multiply: ["$$l.units", "$$l.unitPrice"] }, 2] },
                },
              },
            },
          },
        ],
        default: [
          {
            day: "$fullDocument.sale_date",
            channel: "partner",
            region: "$fullDocument.market",
            sku: "$fullDocument.product_sku",
            product: "$fullDocument.product_name",
            units: "$fullDocument.quantity",
            revenue: "$fullDocument.gross_value",
          },
        ],
      },
    },
  },
};

// Aggregate correctly over a bounded set of events: the window is what makes
// $group possible in a stream — the structural advantage over per-document
// triggers, which never see more than one document at a time.
const window = {
  $tumblingWindow: {
    interval: { size: NumberInt(10), unit: "second" },
    // Windows close when event time passes their end — which requires newer
    // events. idleTimeout closes the last window when traffic pauses, so the
    // tail of a burst still lands without waiting for the next sale.
    idleTimeout: { size: NumberInt(15), unit: "second" },
    pipeline: [
      { $unwind: "$lines" },
      { $replaceRoot: { newRoot: "$lines" } },
      {
        $group: {
          _id: { day: "$day", channel: "$channel", region: "$region", sku: "$sku" },
          product: { $first: "$product" },
          units: { $sum: "$units" },
          revenue: { $sum: "$revenue" },
          orderLines: { $sum: 1 },
        },
      },
      {
        $set: {
          day: "$_id.day", channel: "$_id.channel",
          region: "$_id.region", sku: "$_id.sku",
          revenue: { $round: ["$revenue", 2] },
        },
      },
    ],
  },
};

// Each window emits PARTIAL sums for its 10 seconds; the merge accumulates
// them into the running totals. At-least-once delivery means a crash between
// checkpoint and merge could double-apply one window — acceptable for a
// dashboard, and the batch view (03) remains the reconciliation of record.
const merge = {
  $merge: {
    into: { connectionName: CONN, db: DB, coll: "sales_rollup_stream" },
    on: "_id",
    whenMatched: [
      {
        $set: {
          product: "$$new.product",
          units: { $add: ["$units", "$$new.units"] },
          revenue: { $round: [{ $add: ["$revenue", "$$new.revenue"] }, 2] },
          orderLines: { $add: ["$orderLines", "$$new.orderLines"] },
          day: "$$new.day", channel: "$$new.channel",
          region: "$$new.region", sku: "$$new.sku",
          updatedAt: "$$NOW",
        },
      },
    ],
    whenNotMatched: "insert",
  },
};

const pipeline = [source, normalize, window, merge];

// Failed documents land in a dead-letter queue on the cluster instead of
// being silently dropped.
const options = { dlq: { connectionName: CONN, db: DB, coll: "asp_dlq" } };

// ── Actions ─────────────────────────────────────────────────────────────────

function exists() {
  return sp.listStreamProcessors().some((p) => p.name === NAME);
}

if (ACTION === "create") {
  if (exists()) {
    try { sp[NAME].stop(); } catch (e) { /* was not running */ }
    sp[NAME].drop();
    print(`dropped existing processor ${NAME}`);
  }
  sp.createStreamProcessor(NAME, pipeline, options);
  sp[NAME].start();
  print(`created and started ${NAME}`);
  print(`  windows: 10s tumbling | sink: ${DB}.sales_rollup_stream | dlq: ${DB}.asp_dlq`);
} else if (ACTION === "stats") {
  printjson(sp[NAME].stats());
} else if (ACTION === "stop") {
  sp[NAME].stop();
  print(`stopped ${NAME} (definition kept — ACTION=start resumes from its checkpoint)`);
} else if (ACTION === "start") {
  sp[NAME].start();
  print(`started ${NAME}`);
} else if (ACTION === "drop") {
  try { sp[NAME].stop(); } catch (e) { /* was not running */ }
  sp[NAME].drop();
  print(`dropped ${NAME}`);
} else {
  print(`unknown ACTION '${ACTION}' — use create | stats | stop | start | drop`);
}
