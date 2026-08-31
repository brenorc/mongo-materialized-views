# Evaluation matrix — scoring the five scenarios

A scoring rubric for the pros-and-cons discussion. Five criteria, 0–5 stars
each, with an explicit definition of what every star level means — so a score
can be defended when the customer challenges it, and adjusted honestly when
their context differs from the assumptions.

Scores reflect each approach **at production scale**, not at demo scale. A
30k-document demo hides the differences that matter; the whole point of the
exercise is what happens at 30 million.

---

## The five criteria

Each is deliberately independent — they measure different things, and no
approach wins all five.

| # | Criterion | The question it answers |
| --- | --- | --- |
| 1 | **Query latency** | How long does a user wait for the report? |
| 2 | **Data freshness** | How old can the answer be? |
| 3 | **Analytical flexibility** | Which questions can this approach answer at all? |
| 4 | **Setup & operational simplicity** | How much is there to build, and to keep alive? |
| 5 | **Cost efficiency at scale** | How does the bill behave as data and traffic grow? |

Criteria 1 and 2 are frequently confused and are **not** the same thing: a
query-time union is maximally fresh and slow; a lakehouse query is fast to
issue against years of data but reads a snapshot committed minutes ago.

---

## Scoring rubric

Read this before the matrix — it is what makes the stars mean something.

**1 · Query latency** — wall-clock for the report, at production data volume.

| ★ | Meaning |
| --- | --- |
| ★★★★★ | Single-digit ms; indexed point lookup |
| ★★★★☆ | Tens to low hundreds of ms; reads pre-aggregated rows, flat as history grows |
| ★★★☆☆ | Sub-second, but grows with data volume |
| ★★☆☆☆ | Seconds; full scans, or engine start-up per query |
| ★☆☆☆☆ | Tens of seconds or worse |

**2 · Data freshness** — worst-case age of the number a user sees.

| ★ | Meaning |
| --- | --- |
| ★★★★★ | Real time — always reflects the last committed write |
| ★★★★☆ | Seconds |
| ★★★☆☆ | Seconds to a few minutes |
| ★★☆☆☆ | Hours |
| ★☆☆☆☆ | Once a day or worse |

**3 · Analytical flexibility** — the range of questions answerable without
re-engineering the pipeline.

| ★ | Meaning |
| --- | --- |
| ★★★★★ | Any aggregation, any grain, ad-hoc; joins to data outside MongoDB |
| ★★★★☆ | Full aggregation language, but within a fixed grain/window |
| ★★★☆☆ | Fixed grain; re-aggregation only along the stored dimensions |
| ★★☆☆☆ | Fixed grain and a restricted set of metrics |
| ★☆☆☆☆ | Only incrementable metrics (sum, count) — no averages, distinct counts, or top-N |

**4 · Setup & operational simplicity** — build effort *and* ongoing care.

| ★ | Meaning |
| --- | --- |
| ★★★★★ | Nothing to deploy or operate; just a query |
| ★★★★☆ | One artifact plus a scheduler; trivially re-runnable |
| ★★★☆☆ | A managed component with modest configuration |
| ★★☆☆☆ | A managed component needing sizing, tuning and failure handling |
| ★☆☆☆☆ | Multiple systems across providers, with identity and catalog plumbing |

**5 · Cost efficiency at scale** — how spend grows with history and traffic.

| ★ | Meaning |
| --- | --- |
| ★★★★★ | Cheap storage; compute charged only when someone actually queries |
| ★★★★☆ | Computed once, served many times; cost tracks data change, not reads |
| ★★★☆☆ | Continuous baseline cost, but decoupled from the operational cluster |
| ★★☆☆☆ | Cost scales with write volume regardless of analytical value delivered |
| ★☆☆☆☆ | Every reader pays a full scan; cost grows with history × traffic |

---

## The matrix

| Approach | Query latency | Freshness | Flexibility | Simplicity | Cost at scale |
| --- | :---: | :---: | :---: | :---: | :---: |
| **1 · Query-time `$unionWith`** | ★★☆☆☆ | ★★★★★ | ★★★★★ | ★★★★★ | ★☆☆☆☆ |
| **2 · Batch materialized view** | ★★★★☆ | ★★☆☆☆ | ★★★☆☆ | ★★★★☆ | ★★★★☆ |
| **3 · Database Triggers** | ★★★★☆ | ★★★★★ | ★☆☆☆☆ | ★★☆☆☆ | ★★☆☆☆ |
| **4 · Stream processing → collection** | ★★★★☆ | ★★★★☆ | ★★★★☆ | ★★☆☆☆ | ★★★☆☆ |
| **5 · Stream processing → lakehouse** | ★★☆☆☆ | ★★★☆☆ | ★★★★★ | ★☆☆☆☆ | ★★★★★ |

**Deliberately, there is no total column.** Summing the stars would imply the
five criteria matter equally, which is never true for a real customer. The
matrix is a tool for weighting, not a leaderboard — see *Reading it against a
requirement* below.

---

## Why each score — talking points

One block per scenario: the score line, what earns it, what to weigh against
it, and the one sentence that decides it. These are the bullets to speak to
while the matrix is on screen.

---

### 1 · Query-time `$unionWith` — the honest baseline

`★★☆☆☆ latency · ★★★★★ freshness · ★★★★★ flexibility · ★★★★★ simplicity · ★☆☆☆☆ cost`

**What earns the stars**

- **Nothing exists between the question and the data.** No pipeline to deploy,
  no schedule, no second copy that can drift out of sync — the query *is* the
  architecture.
- **Perfect freshness, for free.** It reads the source collections, so the
  answer always reflects the last committed write. No other scenario gets this
  without building something.
- **Any question, any grain.** Not locked to a rollup shape: change the
  `$group` and you have a different report, immediately. Ad-hoc analysis stays
  possible.
- **It is the correctness reference.** Every other scenario is judged by
  whether it reproduces this number — which is exactly why scenarios 1 and 2
  return identical totals in the demo.

**What to weigh against it**

- **The filter cannot help you.** Each collection has its own field names, so
  the product filter can only apply *after* normalization — every report reads
  all three collections in full (~550 ms over 30k documents).
- **Cost grows with history × traffic.** Every reader pays a full scan on every
  refresh. Ten analysts hitting refresh is ten full scans.
- **It competes with the operational workload.** The scan runs on the same
  cluster serving order writes; a dashboard on auto-refresh becomes a
  production risk.
- **It degrades on two axes at once.** Latency *and* cost worsen together as
  data grows — the one profile with no comfortable ceiling.

**Choose it when** volumes are small, the report is occasional, or you need a
correct answer today while you measure whether anything more is warranted.

---

### 2 · Batch materialized view (`$merge`) — the default that is hard to beat

`★★★★☆ latency · ★★☆☆☆ freshness · ★★★☆☆ flexibility · ★★★★☆ simplicity · ★★★★☆ cost`

**What earns the stars**

- **Latency stops tracking history.** Reads land on indexed pre-aggregated rows
  (measured 168–375 ms) and stay flat as the source collections grow — the
  single most valuable property here.
- **Compute once, serve thousands of times.** The scan happens on a schedule
  you control, not once per curious user. Cost follows data change, not read
  traffic.
- **`$merge`, not `$out`.** Incremental by key, so there is never a window
  where the view is empty or half-written, and readers are never blocked. The
  view is itself watchable by a change stream.
- **Genuinely simple to operate.** One idempotent script plus a scheduler.
  Re-running it after a failure is safe — that idempotency is what makes the
  demo reset possible at all.
- **Restartable and backfillable.** A watermark with a lateness buffer means a
  missed run is caught up by the next one, not lost.

**What to weigh against it**

- **A number is at most one interval old, by construction.** That is the whole
  trade, and it is a business decision, not a technical one — ask what the
  customer will do differently with a fresher number.
- **The grain is a commitment.** Day × channel × region × product answers
  anything expressible along those dimensions and nothing below them. A new
  dimension means a backfill.
- **Late-arriving data needs a policy.** The lateness buffer is a deliberate
  choice you must be able to defend, not a default to leave unexamined.

**Choose it when** the report is read on a human cadence — every morning, every
hour — which is most reporting, most of the time.

---

### 3 · Database Triggers — right tool, wrong job

`★★★★☆ latency · ★★★★★ freshness · ★☆☆☆☆ flexibility · ★★☆☆☆ simplicity · ★★☆☆☆ cost`

**What earns the stars**

- **Per-event freshness, with no window to wait for.** The rollup moves the
  instant the sale lands. This is its one genuine advantage over everything
  else on the list.
- **Fully managed and event-driven.** No infrastructure to size; the function
  runs when a document arrives and not otherwise.
- **The update is atomically correct.** An `$inc` upsert against a keyed rollup
  document is safe under concurrency — the mechanism itself is sound.

**What to weigh against it**

- **Each invocation sees exactly one document.** This is a *structural* limit,
  not a tuning problem: with no window there is no set to `$group` over, so
  every metric must be an incrementable counter.
- **Ask for average basket size, distinct customers per day, or a top-N and
  the approach has no answer.** Not "slower" — no answer. This is the bullet
  that decides the scenario.
- **Operational fragility we hit for real.** A cluster pause suspends the
  triggers and they **do not resume when the cluster comes back** — recovery
  needs an explicit resume that discards the stale token. A collection reseed
  invalidates their change streams the same way.
- **You pay per write, not per read.** One invocation for every document
  written, whether or not anybody ever looks at the report.
- **Three functions to keep in sync.** One per source shape, and normalization
  logic now lives in JavaScript instead of the aggregation pipeline.

**Choose it when** the job is *projecting* each document into a unified feed —
which triggers do very well. Not when the job is maintaining an aggregate.

---

### 4 · Stream processing → collection — continuous, and still a real aggregation

`★★★★☆ latency · ★★★★☆ freshness · ★★★★☆ flexibility · ★★☆☆☆ simplicity · ★★★☆☆ cost`

**What earns the stars**

- **The window restores `$group`.** A tumbling window turns an unbounded stream
  into a bounded set, so the *same* aggregation as the batch pipeline runs
  continuously. Averages, distinct counts and top-N all work again — this is
  precisely what triggers cannot do.
- **Seconds of lag, tunable.** 10-second windows in this demo; the freshness
  gap between this and triggers is a configuration value, not an architecture.
- **Analytics compute leaves the operational cluster.** The aggregation runs in
  the stream processing workspace, so reporting load stops competing with order
  writes.
- **One processor covers all three collections.** A database-level change
  stream with the filter pushed *inside* `$source` — irrelevant events never
  enter the pipeline.
- **Failures are visible, not silent.** A dead-letter queue catches malformed
  documents instead of dropping them.

**What to weigh against it**

- **Windowing decisions are now yours.** Window size, late-event handling, and
  an idle timeout so the last window of a burst still flushes when traffic
  pauses — each is a real choice with a business consequence.
- **At-least-once delivery.** A crash between checkpoint and merge can
  double-apply one window. Acceptable for a dashboard; this is why the nightly
  batch stays the reconciliation of record.
- **It bills continuously.** The workspace runs overnight and on weekends
  whether or not sales are happening.
- **A managed component to size and monitor.** Modest, but non-zero: something
  new is now in the critical path.

**Choose it when** someone acts on the number during the day — store managers,
operations, live dashboards — and the metrics are more than counters.

---

### 5 · Stream processing → lakehouse (Iceberg on S3) — MongoDB leaves the read path

`★★☆☆☆ latency · ★★★☆☆ freshness · ★★★★★ flexibility · ★☆☆☆☆ simplicity · ★★★★★ cost`

**What earns the stars**

- **Full SQL, and joins to data MongoDB never sees.** Sales next to finance and
  inventory, in the tools analysts already use — Athena, Snowflake, Databricks,
  Trino. No other scenario answers cross-system questions at all.
- **Years of history at object-storage prices.** Storage is cheap and compute is
  charged only when someone actually queries (the demo report scanned 275 KB).
- **Only the sink stage changed.** The pipeline is scenario 4's, with `$iceberg`
  in place of `$merge` — a strong story to tell, and true.
- **Iceberg v2 handles schema evolution** through the catalog as the rollup
  shape changes. This is the main reason to prefer it over emitting JSON.
- **Identical numbers, different engine.** Athena and MongoDB return the same
  13,828 units and 1,721,533.59 revenue — that equivalence is the slide.

**What to weigh against it**

- **It is not a serving layer.** Seconds per query: object storage plus an
  engine that starts up per query. An application needing one row in
  milliseconds still wants scenario 2 or 4.
- **The most moving parts of any option, across two providers.** An AWS
  account, an IAM trust relationship with an external id, a Glue catalog, an S3
  bucket, an Athena workgroup — plus everything scenario 4 already required.
- **Static types meet a dynamic document store.** Iceberg infers each column's
  type and then enforces it; `$round` returns an int for whole values and a
  double otherwise. Our first run sent **5,544 of 12,140 rows to the DLQ** —
  and failed *quietly*, into the queue, rather than crashing. Explicit
  `$toDouble` / `$toLong` fixed it.
- **Small files are the classic operational failure.** Frequent commits produce
  many tiny Parquet files (1,030 objects for 12k rows here); Iceberg tables
  need periodic compaction to stay fast.
- **Freshness follows the commit cadence, not the event.** Rows appear when
  files are committed — do not promise per-second freshness on a lake.

**Choose it when** the consumer is an analytics team rather than an
application, the questions span systems, and the history is measured in years.
Discount the simplicity penalty heavily if a warehouse and its plumbing already
exist.

---

## The finding worth saying out loud

Look down the Triggers row against the Stream processing row:

| | Latency | Freshness | Flexibility | Simplicity | Cost |
| --- | :---: | :---: | :---: | :---: | :---: |
| Triggers | ★★★★ | ★★★★★ | ★ | ★★ | ★★ |
| Stream → collection | ★★★★ | ★★★★ | ★★★★ | ★★ | ★★★ |

Stream processing matches or beats triggers on **every criterion except raw
per-event freshness** — and that single star of difference is a tunable window
size. This is the matrix earning its keep: it makes visible, in one glance,
the argument the explainer makes in prose. **Triggers are the right tool for
projecting documents, not for maintaining aggregates.**

Note also that no row dominates any other overall — each has at least one
criterion where it is the best choice. That is the signature of a genuine
trade-off space, and it is why "which one is best?" has no answer without
requirements.

---

## Reading it against a requirement

Weight the criteria by what the customer actually said, then read the column.

| If the binding requirement is… | The criterion that dominates | Where it lands |
| --- | --- | --- |
| "The report is read every morning" | Cost, simplicity | **Batch** (2) |
| "Store managers need today's sales now" | Freshness, flexibility | **Stream → collection** (4) |
| "We just need each sale copied to a unified feed" | Freshness, simplicity | **Triggers** (3) — projection, not aggregation |
| "Analysts want this next to finance data, over 5 years" | Flexibility, cost | **Lakehouse** (5) |
| "We're not sure yet / volumes are small" | Simplicity, flexibility | **Query-time union** (1) — and measure before building |

And the answer that is right more often than any single column: **two of
them.** Stream processing for today's numbers, a nightly batch as the
reconciliation of record — scenario 4's weakest criteria are exactly
scenario 2's strongest.

---

## Adjusting the scores for a specific customer

The scores encode assumptions. Change the assumption, change the score —
and say so, rather than defending a number that no longer applies:

- **Small and stable data volume** → query-time latency rises to ★★★★ and its
  cost penalty largely disappears. Scenario 1 becomes a serious answer, not
  just a baseline.
- **An hourly batch is acceptable** → batch freshness rises to ★★★, and it
  starts competing directly with streaming.
- **A warehouse already exists** → the lakehouse's ★☆☆☆☆ simplicity is
  overstated; most of that plumbing is already built and paid for.
- **Write volume vastly exceeds read volume** → triggers' cost drops toward
  ★, since you pay per write to serve comparatively few reads.
- **Only sums and counts are ever needed** → triggers' flexibility rises to
  ★★★, and the approach becomes defensible on its own terms.

**Back to:** [Demo runbook](06-demo-runbook.md) · [README](../README.md)
