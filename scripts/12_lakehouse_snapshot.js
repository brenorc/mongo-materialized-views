// Scenario 5 — one-time snapshot: sales_rollup → Apache Iceberg on S3.
//
// Runs against the STREAM PROCESSING WORKSPACE (same connection pattern as
// 07_stream_processor.js). Creates a short-lived processor that:
//
//   $source    the batch materialized view `sales_rollup`, with
//              initialSync — existing rows flow through as if inserted
//   $replaceRoot / $set   flatten the composite _id into a string row key
//   $iceberg   CDC-mode writes into Iceberg v2 tables on S3 (Glue catalog)
//
// The demo strategy is deliberate: generate the lake data ONCE from a
// coherent rollup state, then freeze it. Live demos query the frozen table
// in Athena — no cross-cloud moving parts on stage.
//
//   ACTION=create (default) | stats | stop | drop
//   LAKE_BUCKET must be set (11_setup_lakehouse_aws.sh prints it).

const ACTION = process.env.ACTION || "create";
const NAME = "lakeSnapshotProcessor";
const CONN = process.env.ASP_CONNECTION_NAME || "BrenoM10Conn";
const DB = process.env.MONGODB_DATABASE || "mongo_analytics";
const BUCKET = process.env.LAKE_BUCKET;
const GLUE_DB = process.env.LAKE_GLUE_DB || "sales";

if (ACTION === "create" && !BUCKET) {
  print("ERROR: LAKE_BUCKET is not set — export it (11_setup_lakehouse_aws.sh prints the name).");
  quit(1);
}

const pipeline = [
  {
    $source: {
      connectionName: CONN,
      db: DB,
      coll: "sales_rollup",
      initialSync: { enable: true },   // replay existing rows, then keep following changes
      config: { fullDocument: "required" },
    },
  },
  { $match: { operationType: { $in: ["insert", "update", "replace"] } } },
  { $replaceRoot: { newRoot: "$fullDocument" } },
  // Iceberg CDC mode keys rows by idFieldName; a composite document _id is
  // awkward there, so flatten it into a deterministic string.
  //
  // The casts are NOT cosmetic. Iceberg columns are statically typed, and the
  // table's schema is inferred from the first documents it sees. BSON is
  // dynamically typed: `$round` returns an int when the value is whole (236)
  // and a double otherwise (236.5), so a `revenue` column typed double
  // rejects every whole-valued row with
  //   "Unexpected BSON type of int for iceberg column revenue of type double".
  // Casting every numeric explicitly makes the type stable across all rows.
  {
    $set: {
      _id: { $concat: ["$day", "|", "$channel", "|", "$region", "|", "$sku"] },
      revenue: { $toDouble: "$revenue" },
      units: { $toLong: "$units" },
      orderLines: { $toLong: "$orderLines" },
    },
  },
  {
    $iceberg: {
      connectionName: "salesLake",
      bucket: BUCKET,
      path: "iceberg-warehouse",   // no trailing slash — the API rejects it

      databaseName: GLUE_DB,
      tableName: "sales_rollup",
      mode: "cdc",
      idFieldName: "_id",
      catalog: { type: "glue" },
    },
  },
];

const options = { dlq: { connectionName: CONN, db: DB, coll: "asp_dlq" } };

function exists() {
  return sp.listStreamProcessors().some((p) => p.name === NAME);
}

if (ACTION === "create") {
  if (exists()) {
    try { sp[NAME].stop(); } catch (e) { /* not running */ }
    sp[NAME].drop();
    print(`dropped existing ${NAME}`);
  }
  sp.createStreamProcessor(NAME, pipeline, options);
  sp[NAME].start();
  print(`created and started ${NAME}`);
  print(`  ${DB}.sales_rollup --(initialSync + cdc)--> s3://${BUCKET}/iceberg-warehouse/ (glue db '${GLUE_DB}')`);
  print("Watch progress with ACTION=stats; drop it once the row counts match.");
} else if (ACTION === "stats") {
  const s = sp[NAME].stats();
  print(`state=${s.state} input=${s.stats.inputMessageCount} output=${s.stats.outputMessageCount} dlq=${s.stats.dlqMessageCount}`);
  if (s.errorMsg) print("errorMsg:", s.errorMsg);
} else if (ACTION === "stop") {
  sp[NAME].stop();
  print(`stopped ${NAME}`);
} else if (ACTION === "drop") {
  if (exists()) {
    try { sp[NAME].stop(); } catch (e) { /* not running */ }
    sp[NAME].drop();
    print(`dropped ${NAME} — the lake table is now a frozen snapshot`);
  } else {
    print(`${NAME} does not exist — nothing to drop`);
  }
} else {
  print(`unknown ACTION '${ACTION}' — use create | stats | stop | drop`);
}
