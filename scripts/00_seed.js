// Seed the three source collections with ~10k sales each over the last 90 days.
//
// Run from the repo root:
//   set -a; source .env; set +a
//   mongosh "$MONGODB_URI" --quiet --file scripts/00_seed.js
//
// Re-running drops and reseeds the three source collections. The rollup
// collections are left alone — each approach's script owns its own output.

load("scripts/lib/guard.js");
load("scripts/lib/catalog.js");

const DB_NAME = process.env.MONGODB_DATABASE || "mongo_analytics";
const PER_COLLECTION = parseInt(process.env.SEED_COUNT || "10000", 10);
const DAYS_BACK = 90;

const dbx = db.getSiblingDB(DB_NAME);
const now = new Date();
const from = new Date(now.getTime() - DAYS_BACK * 24 * 3600 * 1000);

const sources = [
  { coll: "sales_online",   make: makeOnlineSale,   dateField: "orderedAt" },
  { coll: "sales_instore",  make: makeInstoreSale,  dateField: "soldAt" },
  { coll: "sales_partners", make: makePartnerSale,  dateField: "sale_date" },
];

print(`Seeding ${PER_COLLECTION} sales per collection into '${DB_NAME}' (last ${DAYS_BACK} days)...`);

for (const { coll, make, dateField } of sources) {
  dbx[coll].drop();
  let inserted = 0;
  while (inserted < PER_COLLECTION) {
    const batch = [];
    const n = Math.min(1000, PER_COLLECTION - inserted);
    for (let i = 0; i < n; i++) {
      batch.push(make(randomDateBetween(from, now), inserted + i + 1));
    }
    dbx[coll].insertMany(batch, { ordered: false });
    inserted += n;
  }
  // Index the field the batch refresh filters on (its incremental $match).
  dbx[coll].createIndex({ [dateField]: 1 });
  print(`  ${coll}: ${dbx[coll].countDocuments()} documents`);
}

print("\nSample document from each collection:");
for (const { coll } of sources) {
  print(`\n--- ${coll} ---`);
  printjson(dbx[coll].findOne({}, { _id: 0 }));
}
