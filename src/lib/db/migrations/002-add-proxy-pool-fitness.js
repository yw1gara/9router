// Adds the durable proxy-pool fitness (scoped cooldown) registry.
// The declarative TABLES entry in schema.js also covers fresh installs via
// additive sync; this migration pins the same DDL for existing databases.
import { TABLES } from "../schema.js";

const migration = {
  version: 2,
  name: "add-proxy-pool-fitness",
  up(db) {
    const def = TABLES.proxyPoolFitness;
    const cols = Object.entries(def.columns)
      .map(([name, type]) => `${name} ${type}`)
      .join(", ");
    db.exec(
      `CREATE TABLE IF NOT EXISTS proxyPoolFitness(${cols}, PRIMARY KEY (poolId, scope))`
    );
    for (const idx of def.indexes || []) db.exec(idx);
  },
};

export default migration;
