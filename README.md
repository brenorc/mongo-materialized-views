# Unified Sales Analytics on MongoDB

A self-contained HTML explainer comparing four ways to merge updates from several
MongoDB collections into a single pre-aggregated analytical collection.

## The question this answers

A customer keeps sales in three separate collections — online, in-store, and partner —
each written by a different system, each with a slightly different shape. Their users
want one analytical view they can query: revenue and order counts rolled up by day,
region, and channel.

The aggregation itself is the easy part. What actually decides the architecture is
**when the pipeline runs** and **where the result lands**. The document walks through
four answers to that, with the trade-offs of each.

## Contents

| File | What it is |
| --- | --- |
| [`mongodb-analytics-approaches.html`](mongodb-analytics-approaches.html) | The explainer. Open it in any browser — no build step, no server. |

The page is written for a customer audience: it assumes familiarity with MongoDB but
explains each approach from scratch, with an animated diagram per approach, a
comparison table, and a decision framework.

## The four approaches

| Approach | Freshness | Users query | Trigger model |
| --- | --- | --- | --- |
| Scheduled batch refresh | hours to a day | Atlas collection | A scheduler fires a pipeline (`$unionWith` → `$group` → `$merge`) |
| Per-document triggers | seconds | Atlas collection | Each change event invokes an Atlas Database Trigger function |
| Stream processing → collection | seconds | Atlas collection | A continuous Atlas Stream Processing job with `$tumblingWindow` + `$merge` |
| Stream processing → lakehouse | seconds to minutes | Snowflake, Databricks, Athena, Trino | The same processor, sinking to Apache Iceberg on S3 via `$iceberg` |

Two points the document argues, which are easy to get wrong:

- **Triggers are the wrong tool for aggregation.** Each invocation sees a single
  document with no window, so every rollup becomes a hand-rolled atomic counter.
  They are a good fit for *projecting* documents, not for maintaining aggregates.
- **These are not four competing products.** They are four runtimes for broadly the
  same aggregation pipeline, and production setups commonly combine two — for
  example, stream processing for today's numbers plus a nightly batch that
  recomputes closed days from source.

## Viewing it

Open the file directly:

```sh
open mongodb-analytics-approaches.html    # macOS
```

It is fully self-contained — all CSS, JavaScript, and SVG are inline, and the only
external request is to Google Fonts. It adapts to light and dark themes, and honours
`prefers-reduced-motion` by disabling the diagram animations.

## Accuracy

Stage syntax in the code samples was checked against the MongoDB documentation, but
the snippets are deliberately simplified for readability — real pipelines carry more
normalization and date handling. Check the docs for complete syntax, supported
processor tiers, and current limits before building anything:

- [On-Demand Materialized Views](https://www.mongodb.com/docs/manual/core/materialized-views/)
- [Atlas Database Triggers](https://www.mongodb.com/docs/atlas/atlas-ui/triggers/database-triggers/)
- [Atlas Stream Processing](https://www.mongodb.com/docs/atlas/atlas-stream-processing/)
- [`$iceberg` for AWS S3 buckets](https://www.mongodb.com/products/updates/now-ga-iceberg-for-aws-s3-buckets/)

## Status

This repository holds the explainer only. None of the four flows are implemented here.
