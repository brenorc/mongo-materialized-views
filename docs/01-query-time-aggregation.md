# 1 · Query-time aggregation ($unionWith)

**The baseline.** No materialization: every query normalizes and aggregates
the three source collections from scratch, with `$unionWith` stitching them
together in a single pipeline.

```sh
mongosh "$MONGODB_URI" --quiet --file scripts/02_query_time_union.js

# with filters
SKU=SKU-001 mongosh "$MONGODB_URI" --quiet --file scripts/02_query_time_union.js
REGION=EMEA FROM=2026-08-01 TO=2026-08-27 \
  mongosh "$MONGODB_URI" --quiet --file scripts/02_query_time_union.js
```

## How it works

One aggregation, anchored on `sales_online`:

```
normalize(online)
  → $unionWith { sales_instore,  pipeline: normalize(instore) }
  → $unionWith { sales_partners, pipeline: normalize(partners) }
  → $match  (product / date / region filters)
  → $group  (rollup grain, then the report)
```

Each `$unionWith` carries that collection's own normalization pipeline from
[`scripts/lib/normalize.js`](../scripts/lib/normalize.js) — the three shapes
become one stream of unified sale lines, and everything after that is an
ordinary aggregation.

## What to show the customer

- **It is always fresh.** Run the live writer in a second terminal, re-run the
  query: new sales appear immediately. No pipeline to operate, nothing to
  deploy — this is the right *first* implementation, and the honest baseline
  to measure the others against.
- **It re-reads everything, every time.** The script prints the elapsed time
  and the number of source documents scanned (~550 ms over 30k documents on
  an M20). The `$match` can only apply *after* normalization, so even a
  narrow filter pays the full scan.
- **The cost grows with history, not with traffic.** Twice the retained data
  is twice the work per query — for every user, on every dashboard refresh.
  That sentence is the whole motivation for the rest of the demo.

**Next:** [2 · Batch materialized view](02-batch-materialized-view.md)
