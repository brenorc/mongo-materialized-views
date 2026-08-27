# 0 · Setup and demo data

Everything runs against a real Atlas cluster from plain `mongosh` scripts — no
frameworks, no build step. All scripts are run from the repository root.

## Prerequisites

- `mongosh` (2.x) and `python3` on your PATH
- An Atlas cluster (this demo was built against an M20, MongoDB 9.0)
- A database user with read/write access
- For the trigger and stream-processing approaches: an Atlas API key with
  **Project Owner** on the project that contains the cluster
- Copy `.env.example` to `.env` and fill it in — `.env` is gitignored

Load the environment once per shell:

```sh
set -a; source .env; set +a
```

## The scenario

Three systems write sales to three collections in the `mongo_analytics`
database, each with its own document shape:

| Collection | Written by | Shape quirk |
| --- | --- | --- |
| `sales_online` | web store | `items` array, `orderedAt` date |
| `sales_instore` | point of sale | `lines` array, its own field names (`soldAt`, `storeRegion`) |
| `sales_partners` | partner feed | flat, one product per document, **date as a string** |

The goal of every approach: one queryable rollup at the grain
**day × channel × region × product**, filterable by product, date and region.

## Seed ~10k sales per collection

```sh
mongosh "$MONGODB_URI" --quiet --file scripts/00_seed.js
```

Spreads 30k sales over the last 90 days, weighted so some products are clearly
best-sellers. Re-running drops and reseeds the three source collections (the
rollup collections are owned by each approach's own script).

## Simulate live traffic

```sh
mongosh "$MONGODB_URI" --quiet --file scripts/01_live_writer.js
```

Inserts 1–3 documents per collection every second until Ctrl+C. Every
approach in this demo is judged by how it reacts to this stream. Tune with
`WRITER_INTERVAL_MS` and `WRITER_MAX_ROUNDS`.

## One idea to keep in view

The normalization logic — "turn each source shape into a unified sale line" —
is written **once**, in [`scripts/lib/normalize.js`](../scripts/lib/normalize.js):

```
{ ts, day, channel, region, sku, product, units, revenue }
```

Every approach that follows reuses that same contract. What changes between
approaches is *when the pipeline runs* and *where the result lands* — never
the business logic. That is the sentence to remember through the whole demo.

**Next:** [1 · Query-time aggregation](01-query-time-aggregation.md)
