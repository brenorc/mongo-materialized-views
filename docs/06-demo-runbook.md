# Demo runbook — presenting the five scenarios

A presenter's script for the full demonstration. Every scenario follows the
same three beats: **introduce the concept → run the same business question →
read the result and discuss trade-offs.** The question never changes:

> *"Give me the sales report by channel for one specific product."*
> (default: `SKU-001`, Trail Running Shoes)

What changes is who answers it — and how fresh, how fast, and how expensive
that answer is. Total stage time: ~25–30 minutes.

---

## Before the audience arrives (T-15 min)

1. **Cluster must be running.** This demo cluster auto-pauses daily at 20:00;
   a paused cluster suspends the triggers and fails the stream processor.
   Resume it first if needed.
2. **Load the environment** in two terminals (main + writer):

   ```sh
   set -a; source .env; set +a
   ```

3. **Reset the demo** (main terminal). One command reseeds everything,
   rebuilds all three rollup views from the same data, restarts the live
   capture paths, and *verifies* that all four executable targets agree:

   ```sh
   bash scripts/10_reset_demo.sh
   ```

   Do not present unless it ends with
   `ALL TARGETS AGREE — demo is at a consistent starting point.`
   The reset leaves the stream processor **running** — that is what the demo
   needs. (If the Atlas API rejects your IP, add it to the API key's access
   list, or pass `ASP_HOSTNAME=<workspace-hostname>` to skip the lookup.)

4. Keep the second terminal ready with the live writer command (below) —
   **do not run it yet**.

---

## Act 0 — Set the scene (2 min)

**Say:** "Three systems record sales — the web store, the point of sale, and
a partner feed. Three collections, three different document shapes, one
business question. I'll answer that same question five different ways, and
the differences between the answers ARE the architecture decision."

Optionally show one document from each collection to make the shape problem
concrete:

```sh
mongosh "$MONGODB_URI" --quiet --eval '
const d = db.getSiblingDB("mongo_analytics");
printjson(d.sales_online.findOne({}, {_id:0}));
printjson(d.sales_instore.findOne({}, {_id:0}));
printjson(d.sales_partners.findOne({}, {_id:0}));'
```

Point at `sale_date: "2026-08-25"` in the partner document — a *string*.
"Someone always sends dates as strings. Remember it — every approach has to
absorb this."

---

## Scenario 1 — Query-time aggregation (4 min)

**Introduce:** "The honest baseline: no precomputation at all. One
aggregation normalizes all three shapes with `$unionWith` and answers
straight from the raw data."

**Run:**

```sh
TARGET=union mongosh "$MONGODB_URI" --quiet --file scripts/09_demo_query.js
```

**Discuss:** note the TOTAL line and the elapsed time — *write the TOTAL on
the whiteboard; it is the reference for everything that follows.*

- ✅ Always fresh, zero moving parts, zero extra storage.
- ❌ Reads all ~30k documents for one product's report — the filter can only
  apply *after* normalization. Twice the history = twice the cost, for every
  user, on every refresh. "This is the approach you outgrow, not the one you
  skip."

## Scenario 2 — Batch materialized view (4 min)

**Introduce:** "Same pipeline, run once on a schedule, result stored in a
collection — computed once, served thousands of times."

**Run:**

```sh
TARGET=batch mongosh "$MONGODB_URI" --quiet --file scripts/09_demo_query.js
```

**Discuss:** the numbers are **identical to scenario 1, to the cent** — same
business logic, different runtime. Faster here, and its cost stays flat as
history grows.

- ✅ Cheapest to operate (a cron / Scheduled Trigger and one script);
  idempotent refresh (`scripts/03_batch_refresh.js` — run it twice live if
  asked); recomputes are trivially safe.
- ❌ Stale between runs. "Every number you just saw is correct *as of the
  last refresh*. Whether that's fine is a business question — and the next
  three scenarios are for when the answer is no."

---

## ⚡ The turn — start live traffic (1 min)

**Say:** "So far the world was frozen. Let's fix that — sales are happening
*right now*." In the **second terminal**:

```sh
mongosh "$MONGODB_URI" --quiet --file scripts/01_live_writer.js
```

Leave it running for the rest of the demo, visible if possible.

> Skipping this step is also a valid (shorter) demo: without the writer, all
> remaining scenarios return exactly the whiteboard TOTAL, proving all four
> paths agree. With the writer, scenarios 3–5 each answer at *their* moment —
> slightly different, all ahead of scenario 2. That divergence is the point.

## Scenario 3 — Database Triggers (5 min)

**Introduce:** "First near-real-time option: a trigger per collection fires a
function on every insert, which increments the rollup with atomic `$inc`.
Event by event, no batches."

**Run** (wait ~10 s after starting the writer):

```sh
TARGET=live mongosh "$MONGODB_URI" --quiet --file scripts/09_demo_query.js
```

**Discuss:** the TOTAL is now **ahead of the whiteboard** — these are sales
from the last seconds. Run scenario 2's query again to show batch standing
still while this one moves.

- ✅ Seconds of latency; no new infrastructure; fits event-shaped side
  effects (notify, enrich) naturally.
- ❌ One invocation per document — cost scales with write volume. And the
  structural limit: each invocation sees ONE document, so only incrementable
  metrics work. "Ask me for average basket size or distinct customers and
  this approach hits a wall — there is no `$group` here, only counters."

## Scenario 4 — Stream processing → collection (5 min)

**Introduce:** "Same freshness goal, different engine: one managed stream
processor consumes all three change streams, aggregates inside 10-second
windows with a real `$group`, and merges each window into the view. Windows
give the stream what triggers never have: a bounded set to aggregate over."

**Run:**

```sh
TARGET=stream mongosh "$MONGODB_URI" --quiet --file scripts/09_demo_query.js
```

**Discuss:** also ahead of the whiteboard; run it twice 15 s apart to show it
climbing in window-sized steps. If asked why its TOTAL can differ by a few
units from scenario 3's: *they answer at different instants, each within
seconds of the truth* — run `TARGET=live` and `TARGET=stream` back to back to
show them converge.

- ✅ Full aggregation language in-flight (averages, distinct, top-N all work);
  checkpointing + dead-letter queue; analytics compute off the operational
  cluster; same `$group` as the batch pipeline.
- ❌ A component to size and monitor, billed while it exists; windows and
  late-event policy are decisions you must own.

## Scenario 5 — Stream processing → lakehouse (4 min)

**Introduce:** "Last scenario changes a different question: not *how fresh*,
but *where do users query?* Same processor, same pipeline — the sink becomes
`$iceberg`, writing open Iceberg tables on S3. MongoDB leaves the read path."

**Important:** this table is a **frozen snapshot**, generated once by Atlas
Stream Processing and then deliberately stopped — so there is no live
cross-cloud integration to fail on stage. Its numbers match the *reference
state* you wrote on the whiteboard, not the live-writer totals from scenarios
3–4. Say that out loud; it is the honest framing and it avoids the obvious
question.

**Run** (or, better, paste the SQL into the Athena console so the audience
sees lakehouse tooling rather than a terminal):

```sh
bash scripts/13_athena_demo_query.sh
```

```sql
SELECT channel, SUM(units) AS units, ROUND(SUM(revenue), 2) AS revenue
FROM sales.sales_rollup
WHERE sku = 'SKU-001'
GROUP BY channel ORDER BY channel;
```

**Discuss:** the numbers are identical to the MongoDB batch view, down to the
cent — `13828 units / 1721533.59`. Point at the byte count Athena reports.

- ✅ Sales data now sits next to finance and inventory in the warehouse, at
  object-storage cost, in an open format any engine reads; the heaviest scans
  never touch the operational cluster.
- ❌ The lake is **not** a serving layer — an app needing one row in
  milliseconds still wants scenario 2 or 4; visibility follows the commit
  cadence, not the event; and you now operate a catalog and a query engine.
  "Which is why real setups often run both sinks from the same source."

**If asked "was this really written by MongoDB?"** — yes: show
`docs/05-lakehouse-iceberg.md`, the `$iceberg` stage, and the Glue table with
`table_type=ICEBERG`. Optional deep cut for a technical audience: the
type-casting gotcha, where 5,544 of 12,140 rows landed in the dead-letter
queue because `$round` returns int for whole values and Iceberg columns are
statically typed. It lands well with data engineers.

---

## Closing (2 min)

Stop the writer (Ctrl+C). Optional encore: run the batch refresh and then
scenario 2's query again — batch catches up to the others, "and that pairing,
stream for today plus nightly batch as the reconciliation of record, is the
most common production answer."

Recap on one slide (or the [explainer](../mongodb-analytics-approaches.html)):
freshness on one axis, where-users-query on the other; the normalization was
written once and every scenario reused it.

**After the demo:** the SP10 workspace bills while it exists —
`ACTION=stop` the processor, or `bash scripts/06_setup_stream_workspace.sh
teardown` to remove the workspace.

---

## If something breaks mid-demo

| Symptom | Cause | Fix |
| --- | --- | --- |
| Writer prints rounds but Atlas counts stay frozen at 10k | That terminal never loaded `.env`, so `mongosh "$MONGODB_URI"` connected to **localhost** and the sales went to a local mongod | `set -a; source .env; set +a` in that terminal and restart the writer. (Scripts now refuse to run without `MONGODB_URI` — if you see rounds printing, the env is loaded.) |
| Scenario 3 TOTAL not moving | Triggers suspended (cluster paused earlier, or reseed invalidated their change streams) | `bash scripts/05_setup_triggers.sh resume` |
| Scenario 4 TOTAL not moving | Processor FAILED (e.g. cluster pause) or not started | `ACTION=start` via `scripts/07_stream_processor.js`; check `ACTION=stats` |
| Scenario 4 short by a few units with writer stopped | Last window waiting for its idle timeout | Wait ~25 s and re-run the query |
| Atlas API returns `IP_ADDRESS_NOT_ON_ACCESS_LIST` | Your IP changed | Add it to the API key's access list; `ASP_HOSTNAME=<host>` keeps the reset working meanwhile |
| Targets disagree at reset | Something wrote during the reset window | Just run `bash scripts/10_reset_demo.sh` again |
