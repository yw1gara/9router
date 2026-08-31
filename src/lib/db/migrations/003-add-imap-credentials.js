// Adds the mail-recovery IMAP credential registry (Outlook XOAUTH2 assist for
// Codex re-login). The declarative TABLES entry in schema.js also covers fresh
// installs via additive sync; this migration pins the same DDL for existing DBs.
import { TABLES } from "../schema.js";

const migration = {
  version: 3,
  name: "add-imap-credentials",
  up(db) {
    const def = TABLES.imapCredentials;
    const cols = Object.entries(def.columns)
      .map(([name, type]) => `${name} ${type}`)
      .join(", ");
    db.exec(`CREATE TABLE IF NOT EXISTS imapCredentials(${cols})`);
    for (const idx of def.indexes || []) db.exec(idx);
  },
};

export default migration;
