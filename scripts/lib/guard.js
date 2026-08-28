// Loaded first by every cluster-side script. Catches the classic demo
// failure: running from a shell that never loaded .env. In that shell,
// `mongosh "$MONGODB_URI"` expands to `mongosh ""`, which silently connects
// to localhost — the live writer then happily fills a local mongod while the
// Atlas demo sits frozen at its seeded counts.
(function () {
  const uri = process.env.MONGODB_URI || "";
  if (!uri) {
    print("ERROR: MONGODB_URI is not set in this shell.");
    print("This usually means .env was never loaded here. Run:");
    print("  set -a; source .env; set +a");
    print("and start the script again.");
    quit(1);
  }
  let connected = "";
  try { connected = db.getMongo()._uri || ""; } catch (e) { /* best effort */ }
  if (/^mongodb\+srv/.test(uri) && /(localhost|127\.0\.0\.1)/.test(connected)) {
    print("ERROR: this shell is connected to a LOCAL mongod, but MONGODB_URI points to Atlas.");
    print('Start the script as:  mongosh "$MONGODB_URI" --quiet --file <script>');
    quit(1);
  }
})();
