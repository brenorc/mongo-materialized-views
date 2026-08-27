// Normalization pipelines: one per source system, each producing the same
// unified "sale line" shape:
//
//   { ts, day, channel, region, sku, product, units, revenue }
//
// This is the heart of the whole demo. The query-time approach (02) and the
// batch materialized view (03) run these exact pipelines — what changes
// between approaches is WHEN they run and WHERE the result lands, never the
// business logic.

// Web orders: explode the `items` array into one line per product.
const NORMALIZE_ONLINE = [
  { $unwind: "$items" },
  {
    $project: {
      _id: 0,
      ts: "$orderedAt",
      day: { $dateToString: { date: "$orderedAt", format: "%Y-%m-%d" } },
      channel: { $literal: "online" },
      region: "$region",
      sku: "$items.sku",
      product: "$items.product",
      units: "$items.qty",
      revenue: { $round: [{ $multiply: ["$items.qty", "$items.unitPrice"] }, 2] },
    },
  },
];

// POS receipts: same idea, different field names (`lines`, `storeRegion`...).
const NORMALIZE_INSTORE = [
  { $unwind: "$lines" },
  {
    $project: {
      _id: 0,
      ts: "$soldAt",
      day: { $dateToString: { date: "$soldAt", format: "%Y-%m-%d" } },
      channel: { $literal: "instore" },
      region: "$storeRegion",
      sku: "$lines.productSku",
      product: "$lines.productName",
      units: "$lines.units",
      revenue: { $round: [{ $multiply: ["$lines.units", "$lines.unitPrice"] }, 2] },
    },
  },
];

// Partner feed: already one product per document, but the date arrives as a
// plain string and every field has its own name. Typical external file.
const NORMALIZE_PARTNERS = [
  {
    $project: {
      _id: 0,
      ts: { $dateFromString: { dateString: "$sale_date", format: "%Y-%m-%d" } },
      day: "$sale_date",
      channel: { $literal: "partner" },
      region: "$market",
      sku: "$product_sku",
      product: "$product_name",
      units: "$quantity",
      revenue: "$gross_value",
    },
  },
];

// Group normalized lines into the rollup grain: day × channel × region × product.
// This grain answers "revenue by product per day" and still lets you filter or
// re-aggregate by any of the four dimensions.
const ROLLUP_GROUP = [
  {
    $group: {
      _id: { day: "$day", channel: "$channel", region: "$region", sku: "$sku" },
      product: { $first: "$product" },
      units: { $sum: "$units" },
      revenue: { $sum: "$revenue" },
      orderLines: { $sum: 1 },
    },
  },
  // Duplicate the grouping keys as top-level fields so the rollup collection
  // can be filtered and indexed without reaching into _id.
  {
    $set: {
      day: "$_id.day",
      channel: "$_id.channel",
      region: "$_id.region",
      sku: "$_id.sku",
      revenue: { $round: ["$revenue", 2] },
    },
  },
];
