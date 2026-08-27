# 4 · Atlas Stream Processing → continuous materialized view

**Near real time, done with aggregation instead of counters.** One managed
stream processor consumes the change streams of all three collections,
normalizes in flight, aggregates inside **10-second tumbling windows** — a
real `$group`, not per-document `$inc` — and merges each window's partial
sums into `sales_rollup_stream`.

```sh
# 1. provision the workspace + cluster connection (billable — see Cost)
bash scripts/06_setup_stream_workspace.sh

# 2. create and start the processor (runs against the WORKSPACE, not the cluster;
#    step 1 prints the exact hostname)
mongosh "mongodb://<workspace-hostname>/" --tls --authenticationDatabase admin \
  -u "$DB_USER" -p "$DB_PASS" --quiet --file scripts/07_stream_processor.js

# 3. demo: run the live writer, watch sales_rollup_stream fill in ~10s batches
mongosh "$MONGODB_URI" --quiet --file scripts/01_live_writer.js

# control (same file, ACTION env var): stats | stop | start | drop
ACTION=stop mongosh "mongodb://<workspace-hostname>/" ... --file scripts/07_stream_processor.js

# teardown of the workspace itself (stops billing)
bash scripts/06_setup_stream_workspace.sh teardown
```

## How the pipeline reads

```
$source           database-level change stream on mongo_analytics
                  (insert-only filter INSIDE the source — see gotcha #1)
$project          $switch on ns.coll → unified sale lines (same contract
                  as scripts/lib/normalize.js)
$tumblingWindow   10s windows; inner pipeline: $unwind → $group → $set
$merge            accumulate partials into sales_rollup_stream
                  (whenMatched pipeline using $$new)
```

The window is the argument of this whole approach: it gives the stream a
bounded set of events, so the SAME `$group` from the batch pipeline runs
continuously. Averages, distinct counts, top-N — all normal again, where the
trigger approach hit a wall. A dead-letter queue (`asp_dlq`) catches bad
documents instead of dropping them silently.

In our validation run, 20 writer rounds produced **415 units / 39,373.92
revenue / 211 lines** — an exact match against a raw recount, DLQ empty.

## Two gotchas we hit for real (tell them — this is the good part)

1. **Filter inside `$source`, not after it.** A database-level change stream
   sees *everything* in `mongo_analytics` — including the rollup collections
   the other approaches write. Our first attempt configured
   `fullDocument: "required"` and promptly FAILED: the stream demanded
   post-images for the trigger approach's own `$inc` updates on
   `sales_rollup_live`. The fix: put the
   `$match { operationType: "insert", ns.coll: [...] }` in
   `$source.config.pipeline`, where it runs inside the change stream itself —
   and drop the `fullDocument` config entirely, since insert events always
   carry the full document natively.
2. **Windows close on event time — set an `idleTimeout`.** When the traffic
   burst stopped, the last window stayed open waiting for newer events to
   advance the watermark, and the tail of the totals sat unflushed. The
   `idleTimeout: 15s` on the window closes it when the source goes quiet.
   Without it, your demo ends with numbers mysteriously short.

## Honest notes for production

- **At-least-once + accumulating merge:** a crash between checkpoint and
  merge could double-apply one window. Fine for a live dashboard; the batch
  view (approach 2) is the reconciliation of record. This pairing —
  stream for today, nightly batch recompute for closed days — is the most
  common production setup.
- **Backfill:** the processor starts reading changes from creation time.
  History comes from one `FULL=1` batch run into the same grain, or
  `$source.config.initialSync` on supported setups.

## Cost

The SP10 workspace bills per hour while it exists (cents/hour — see the Atlas
pricing page). The processor is currently **stopped**; `ACTION=start` resumes
from its checkpoint. Run the teardown when the demo cycle is over.

**Next:** [5 · Lakehouse: Iceberg on S3](05-lakehouse-iceberg.md)
