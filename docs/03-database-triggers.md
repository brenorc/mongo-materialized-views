# 3 · Per-document Atlas Database Triggers

**Near real time, event by event.** Three Database Triggers — one per source
collection — fire an Atlas Function on every INSERT. The function normalizes
that single document and applies atomic `$inc` upserts to
`sales_rollup_live`. Freshness drops from "next scheduled run" to seconds.

```sh
# provision everything (idempotent): app, linked cluster, function, 3 triggers
bash scripts/05_setup_triggers.sh

# watch it work
mongosh "$MONGODB_URI" --quiet --file scripts/01_live_writer.js     # terminal 1
mongosh "$MONGODB_URI" --quiet --eval \
  'db.getSiblingDB("mongo_analytics").sales_rollup_live.find().sort({updatedAt:-1}).limit(3)'  # terminal 2

# remove the triggers + function when done
bash scripts/05_setup_triggers.sh teardown
```

The provisioning script drives the App Services Admin API with the same Atlas
API key as the rest of the demo; the deployed function source lives in
[`scripts/lib/trigger_function.js`](../scripts/lib/trigger_function.js). The
result is also visible in the Atlas UI under **Triggers**.

## How it works

Every insert invokes the function with one change event. The function maps
the document to unified sale lines (same contract as the batch pipeline, but
expressed in JavaScript) and upserts each line's rollup row:

```js
{ $inc: { units, revenue, orderLines: 1 }, $set: { ...dimensions, updatedAt } }
```

The `$inc` is the load-bearing detail: increments are atomic, so concurrent
invocations across the three triggers never lose updates. A read-modify-write
here would, under exactly the concurrency this approach is meant to handle.

## What to show the customer

- **Latency.** Insert a sale, read the rollup a second later — it's there.
  In our validation run, 117 sale lines across 12 writer rounds landed with
  totals matching a raw recount **exactly** (240 units, 19,368.62 revenue).
- **Where the ceiling is.** Everything in this function works because sums
  and counts are incrementable. Ask the customer: *"now add average basket
  size, or distinct customers per day."* There is no window and no `$group`
  in sight — each invocation sees one document. That is the structural limit,
  not a tuning problem.

## Known limits (the aging path of this approach)

- **Inserts only.** This demo treats sales as append-only. Updates/deletes
  require Document Preimages on the trigger so the function can *subtract*
  the old values — more state, more code, more failure modes.
- **No ordering, no replay window.** Three independent triggers race; there
  is no way to reprocess "the last 10 minutes" if a function bug ships.
  Backfilling history is a separate batch job anyway (triggers only see
  changes after they're enabled) — which is why approach 2 usually still
  exists alongside this one.
- **Cost scales with write volume**, one invocation per document, whether or
  not anyone is querying.
- **Float drift.** Thousands of `$inc` on doubles can drift cents from a
  clean recompute. The batch view remains the reconciliation of record.

**Next:** [4 · Stream processing](04-stream-processing.md)
