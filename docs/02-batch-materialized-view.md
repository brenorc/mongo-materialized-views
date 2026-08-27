# 2 · Scheduled batch → materialized view

**The classic on-demand materialized view.** The same pipeline as approach 1,
but its result is written to a collection with `$merge` — computed once,
served many times. Freshness becomes whatever your schedule is.

```sh
# refresh (incremental after the first run)
mongosh "$MONGODB_URI" --quiet --file scripts/03_batch_refresh.js

# force a full rebuild
FULL=1 mongosh "$MONGODB_URI" --quiet --file scripts/03_batch_refresh.js

# the payoff: same question, raw union vs. the view, timed side by side
mongosh "$MONGODB_URI" --quiet --file scripts/04_compare_query_vs_rollup.js
```

## How it works

`scripts/03_batch_refresh.js` writes `sales_rollup` at the grain
**day × channel × region × product** and is built around two properties:

- **Idempotent.** Each run deterministically recomputes every day it touches
  from source, and `$merge { whenMatched: "replace" }` swaps those rollup rows
  wholesale. Run it twice — the result is identical. There is no "+= applied
  twice" failure mode, which is what makes it safe to retry and re-schedule.
- **Incremental.** A watermark in `analytics_meta` records the last run. The
  next run only recomputes days that could have changed since — with a 48h
  lateness buffer (`LATENESS_HOURS`) so back-dated corrections and late
  partner files are re-absorbed. The window `$match` runs on indexed date
  fields *before* normalization, so an incremental run reads only the tail of
  each collection.

In production, this exact script is what you would run from an Atlas
Scheduled Trigger or any cron.

## What to show the customer

- **Run it twice.** Same totals both times, second run faster (only ~3 days
  recomputed). Idempotency is a property you demonstrate, not claim.
- **Run the comparison.** Both paths return byte-identical answers; the view
  is ~4x faster even at this toy scale — and its cost stays flat as history
  grows, while the raw union's cost keeps climbing.
- **Show the staleness, honestly.** Start the live writer, run the comparison
  again: the two paths now disagree, because the view hasn't refreshed. That
  disagreement *is* the trade-off of this approach — a number between
  refreshes is at most one schedule interval old. If that is acceptable
  (daily reports, morning dashboards), stop here; this is the cheapest
  approach to operate. If not, continue.

## Known limits (say them before the customer finds them)

- **Deletes.** A recompute-and-replace never removes a rollup row whose
  source days were entirely deleted outside the recompute window. If hard
  deletes happen, widen the window or rebuild with `FULL=1`.
- **The refresh burst competes with production traffic.** At real scale,
  point the aggregation at an analytics node (read preference / node tags).

**Next:** [3 · Per-document triggers](03-database-triggers.md)
