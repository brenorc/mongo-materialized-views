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

## Why each score

**1 · Query-time `$unionWith`** — ★★☆☆☆ latency because the filter can only
apply *after* normalization, so every report reads all three collections in
full (measured: ~550 ms over 30k documents; linear in history). Perfect
freshness and flexibility: it reads the raw truth and can answer anything.
Nothing to operate. But ★☆☆☆☆ on cost, because every user pays the full scan
on every refresh — the one profile that degrades on two axes at once.

**2 · Batch materialized view** — ★★★★☆ latency reading indexed
pre-aggregated rows (measured: 168–375 ms, and flat as history grows).
Freshness is ★★☆☆☆ by construction — a number is at most one schedule
interval old. Flexibility ★★★☆☆: the rollup grain (day × channel × region ×
product) answers anything expressible along those dimensions and nothing
below them. Simplicity ★★★★☆ — one idempotent script and a scheduler. Cost
★★★★☆: computed once, served thousands of times.

**3 · Database Triggers** — ★★★★★ freshness, per event, no window to wait
for. That is its one genuine advantage, and it comes at a steep price:
★☆☆☆☆ flexibility, because each invocation sees exactly one document, so
every metric must be an atomic counter. Ask for average basket size or
distinct customers per day and the approach has no answer. Simplicity
★★☆☆☆ — three functions, plus real operational fragility (a cluster pause
suspends them and they do not self-resume; a reseed invalidates their change
streams). Cost ★★☆☆☆ — one invocation per document written, whether or not
anyone queries.

**4 · Stream processing → collection** — ★★★★☆ freshness gated by the window
(10 s here, tunable). ★★★★☆ flexibility: the window gives the stream a
bounded set, so the *same* `$group` as the batch pipeline runs continuously —
averages, distinct counts and top-N all work again. Simplicity ★★☆☆☆: a
managed component to size and monitor, with windowing and late-event policy
as decisions you own. Cost ★★★☆☆ — billed continuously even overnight, but
analytics compute moves off the operational cluster.

**5 · Stream processing → lakehouse** — ★★★★★ flexibility and cost: full SQL,
joins to finance and inventory data, years of history at object-storage
prices, engine compute only when queried (measured: 275 KB scanned for the
demo report). The trade is ★★☆☆☆ latency — seconds, because this is object
storage plus a query engine, not a serving layer — and ★☆☆☆☆ simplicity:
everything in scenario 4 *plus* an AWS account, an IAM trust relationship, a
Glue catalog, an S3 bucket, an Athena workgroup, and file compaction to think
about.

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
