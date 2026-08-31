import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";

// ── Automation Runs ────────────────────────────────────────────────────────

export async function createAutomationRun(kind) {
  const db = await getAdapter();
  const now = new Date().toISOString();
  const id = uuidv4();
  await db.run(
    `INSERT INTO automationRuns(id, kind, status, total, success, failed, log, createdAt, startedAt)
     VALUES(?, ?, 'running', 0, 0, 0, '', ?, ?)`,
    [id, kind, now, now]
  );
  return getAutomationRun(id);
}

export async function updateAutomationRun(id, patch) {
  const db = await getAdapter();
  const sets = [];
  const vals = [];
  for (const [k, v] of Object.entries(patch)) {
    sets.push(`${k} = ?`);
    vals.push(v);
  }
  if (!sets.length) return;
  vals.push(id);
  await db.run(`UPDATE automationRuns SET ${sets.join(", ")} WHERE id = ?`, vals);
}

export async function getAutomationRun(id) {
  const db = await getAdapter();
  return db.get(`SELECT * FROM automationRuns WHERE id = ?`, [id]) || null;
}

export async function getAutomationRunsByKind(kind, limit = 20) {
  const db = await getAdapter();
  return db.all(
    `SELECT * FROM automationRuns WHERE kind = ? ORDER BY createdAt DESC LIMIT ?`,
    [kind, limit]
  );
}

// ── Automation Results ─────────────────────────────────────────────────────

export async function createAutomationResult(runId, kind, email, status, apiKey, error, connectionId) {
  const db = await getAdapter();
  const now = new Date().toISOString();
  const id = uuidv4();
  await db.run(
    `INSERT INTO automationResults(id, runId, kind, email, status, apiKey, error, connectionId, createdAt)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, runId, kind, email, status, apiKey || null, error || null, connectionId || null, now]
  );
  return { id, runId, kind, email, status, apiKey, error, connectionId, createdAt: now };
}

export async function getAutomationResults(runId) {
  const db = await getAdapter();
  return db.all(
    `SELECT * FROM automationResults WHERE runId = ? ORDER BY createdAt ASC`,
    [runId]
  );
}

export async function getAutomationResultByEmail(runId, email) {
  const db = await getAdapter();
  return db.get(
    `SELECT * FROM automationResults WHERE runId = ? AND email = ?`,
    [runId, email]
  ) || null;
}
