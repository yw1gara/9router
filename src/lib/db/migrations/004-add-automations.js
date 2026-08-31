// Adds the automation run/result registry for the dashboard Automations
// feature (account farming + harvested key auto-import).
import { TABLES } from "../schema.js";

const migration = {
  version: 4,
  name: "add-automations",
  up(db) {
    for (const name of ["automationRuns", "automationResults"]) {
      const def = TABLES[name];
      const cols = Object.entries(def.columns)
        .map(([n, t]) => `${n} ${t}`)
        .join(", ");
      db.exec(`CREATE TABLE IF NOT EXISTS ${name}(${cols})`);
      for (const idx of def.indexes || []) db.exec(idx);
    }
  },
};

export default migration;