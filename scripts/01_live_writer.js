// Continuous writer: inserts random sales into the three source collections
// until you stop it with Ctrl+C. Use it to demonstrate how each approach
// reacts to a live stream of updates.
//
// Run from the repo root:
//   set -a; source .env; set +a
//   mongosh "$MONGODB_URI" --quiet --file scripts/01_live_writer.js
//
// Tuning (environment variables):
//   WRITER_INTERVAL_MS  pause between rounds (default 1000)
//   WRITER_MAX_ROUNDS   stop after N rounds (default: run forever)
//
// Each round inserts 1–3 documents into each collection, timestamped "now",
// so every approach sees the same incoming traffic.

load("scripts/lib/guard.js");
load("scripts/lib/catalog.js");

const DB_NAME = process.env.MONGODB_DATABASE || "mongo_analytics";
const INTERVAL_MS = parseInt(process.env.WRITER_INTERVAL_MS || "1000", 10);
const MAX_ROUNDS = parseInt(process.env.WRITER_MAX_ROUNDS || "0", 10); // 0 = forever

const dbx = db.getSiblingDB(DB_NAME);

// Continue sequence numbers after the seeded data.
let seq = Math.max(
  dbx.sales_online.countDocuments(),
  dbx.sales_instore.countDocuments(),
  dbx.sales_partners.countDocuments()
);

print(`Writing to '${DB_NAME}' every ${INTERVAL_MS}ms — Ctrl+C to stop.`);
print("round | online | instore | partners | last order");

let round = 0;
while (MAX_ROUNDS === 0 || round < MAX_ROUNDS) {
  round++;
  const now = new Date();
  const counts = { online: randInt(1, 3), instore: randInt(1, 3), partners: randInt(1, 3) };

  const online = Array.from({ length: counts.online }, () => makeOnlineSale(now, ++seq));
  const instore = Array.from({ length: counts.instore }, () => makeInstoreSale(now, ++seq));
  const partners = Array.from({ length: counts.partners }, () => makePartnerSale(now, ++seq));

  dbx.sales_online.insertMany(online);
  dbx.sales_instore.insertMany(instore);
  dbx.sales_partners.insertMany(partners);

  print(
    `${String(round).padStart(5)} | ${String(counts.online).padStart(6)} | ` +
    `${String(counts.instore).padStart(7)} | ${String(counts.partners).padStart(8)} | ` +
    online[online.length - 1].orderId
  );
  sleep(INTERVAL_MS);
}

print(`Done: ${round} rounds.`);
