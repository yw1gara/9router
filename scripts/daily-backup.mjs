// Daily DB backup for 9router — run from cron:
//   15 4 * * * cd /root/work/9router && node scripts/daily-backup.mjs >> /root/.9router/db/backups/daily.log 2>&1
//
// Uses better-sqlite3's online-backup API so the snapshot is consistent even
// while the server is writing (WAL-safe). Keeps the newest KEEP files.
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

const SRC = "/root/.9router/db/data.sqlite";
const DIR = "/root/.9router/db/backups/daily";
const KEEP = 14;

function main() {
  if (!fs.existsSync(SRC)) {
    console.error("[backup] source DB not found:", SRC);
    process.exit(1);
  }
  fs.mkdirSync(DIR, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
  const dest = path.join(DIR, `data-${stamp}.sqlite`);
  if (fs.existsSync(dest)) {
    console.log("[backup] already exists, skipping:", dest);
    return;
  }

  const db = new Database(SRC, { readonly: true });
  db.backup(dest)
    .then(() => {
      db.close();
      const size = fs.statSync(dest).size;
      console.log(`[backup] ok ${dest} (${(size / 1024 / 1024).toFixed(2)} MB)`);
    })
    .catch((err) => {
      try { db.close(); } catch {}
      console.error("[backup] FAILED:", err.message);
      process.exit(1);
    });

  // Prune: keep only the newest KEEP backup files
  const files = fs.readdirSync(DIR).filter((f) => /^data-.*\.sqlite$/.test(f)).sort();
  while (files.length > KEEP) {
    const victim = files.shift();
    try { fs.unlinkSync(path.join(DIR, victim)); console.log("[backup] pruned", victim); } catch {}
  }
}

main();
