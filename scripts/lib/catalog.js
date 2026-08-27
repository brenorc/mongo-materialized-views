// Shared product catalog and random-data helpers.
// Loaded by the seed and live-writer scripts via load("scripts/lib/catalog.js").
// Everything is plain mongosh-compatible JavaScript — no npm dependencies.

const CATALOG = [
  { sku: "SKU-001", product: "Trail Running Shoes",   price: 129.9, weight: 9 },
  { sku: "SKU-002", product: "Hydration Backpack",    price:  74.5, weight: 7 },
  { sku: "SKU-003", product: "Merino Base Layer",     price:  59.0, weight: 6 },
  { sku: "SKU-004", product: "Carbon Trekking Poles", price:  99.0, weight: 4 },
  { sku: "SKU-005", product: "Headlamp 400lm",        price:  39.9, weight: 8 },
  { sku: "SKU-006", product: "2P Ultralight Tent",    price: 349.0, weight: 2 },
  { sku: "SKU-007", product: "Down Sleeping Bag",     price: 219.0, weight: 3 },
  { sku: "SKU-008", product: "Titanium Cook Set",     price:  64.0, weight: 5 },
  { sku: "SKU-009", product: "Rain Shell Jacket",     price: 159.0, weight: 6 },
  { sku: "SKU-010", product: "Wool Hiking Socks",     price:  18.5, weight: 10 },
  { sku: "SKU-011", product: "GPS Sport Watch",       price: 299.0, weight: 3 },
  { sku: "SKU-012", product: "Insulated Bottle 1L",   price:  32.0, weight: 8 },
];

const REGIONS  = ["NA", "EMEA", "LATAM", "APAC"];
const STORES   = ["S-01", "S-02", "S-03", "S-04", "S-05", "S-06", "S-07", "S-08"];
const PARTNERS = ["PRT-ALPINE", "PRT-BASECAMP", "PRT-NORDIC", "PRT-SUMMIT", "PRT-TRAILHEAD"];
const PAYMENTS = ["credit_card", "debit_card", "pix", "paypal", "cash"];

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function pick(arr) {
  return arr[randInt(0, arr.length - 1)];
}

// Weighted pick over the catalog so some products are clearly best-sellers.
const CATALOG_WHEEL = CATALOG.flatMap((p) => Array(p.weight).fill(p));
function pickProduct() {
  return pick(CATALOG_WHEEL);
}

// Random instant between two dates, biased slightly toward daytime hours.
function randomDateBetween(from, to) {
  const t = new Date(from.getTime() + Math.random() * (to.getTime() - from.getTime()));
  t.setUTCHours(randInt(8, 22), randInt(0, 59), randInt(0, 59), 0);
  return t;
}

// UTC calendar day of a Date, as "YYYY-MM-DD".
function dayOf(date) {
  return date.toISOString().slice(0, 10);
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

// ─── Document factories — one per source system, deliberately different shapes ───

// Web store: order document with an `items` array.
function makeOnlineSale(ts, seq) {
  const items = Array.from({ length: randInt(1, 3) }, () => {
    const p = pickProduct();
    const qty = randInt(1, 3);
    return { sku: p.sku, product: p.product, qty, unitPrice: p.price };
  });
  return {
    orderId: `WEB-${String(seq).padStart(6, "0")}`,
    orderedAt: ts,
    region: pick(REGIONS),
    customerId: `C-${String(randInt(1, 2500)).padStart(4, "0")}`,
    payment: pick(PAYMENTS.slice(0, 4)), // no cash online
    items,
    total: round2(items.reduce((s, i) => s + i.qty * i.unitPrice, 0)),
  };
}

// Point of sale: receipt with a `lines` array and its own field names.
function makeInstoreSale(ts, seq) {
  const storeId = pick(STORES);
  const lines = Array.from({ length: randInt(1, 4) }, () => {
    const p = pickProduct();
    const units = randInt(1, 2);
    return { productSku: p.sku, productName: p.product, units, unitPrice: p.price };
  });
  return {
    receiptNumber: `POS-${storeId}-${String(seq).padStart(6, "0")}`,
    storeId,
    storeRegion: pick(REGIONS),
    soldAt: ts,
    cashier: `emp-${randInt(1, 40)}`,
    lines,
    totalAmount: round2(lines.reduce((s, l) => s + l.units * l.unitPrice, 0)),
    paymentMethod: pick(PAYMENTS),
  };
}

// Partner feed: flat, one product per document, date as a plain string —
// the messy external file everyone eventually has to ingest.
function makePartnerSale(ts, seq) {
  const p = pickProduct();
  const quantity = randInt(1, 5);
  const partner = pick(PARTNERS);
  return {
    partner_code: partner,
    external_ref: `${partner.slice(4)}-${ts.getUTCFullYear()}-${String(seq).padStart(6, "0")}`,
    sale_date: dayOf(ts),
    product_sku: p.sku,
    product_name: p.product,
    quantity,
    gross_value: round2(quantity * p.price * 0.85), // partners sell at wholesale
    market: pick(REGIONS),
  };
}
