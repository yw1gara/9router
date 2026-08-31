import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";

export async function getImapCredentials() {
  const db = await getAdapter();
  return db.all(`SELECT * FROM imapCredentials ORDER BY createdAt ASC`);
}

export async function getImapCredentialById(id) {
  const db = await getAdapter();
  return db.get(`SELECT * FROM imapCredentials WHERE id = ?`, [id]) || null;
}

export async function getImapCredentialByEmail(email) {
  const db = await getAdapter();
  return db.get(`SELECT * FROM imapCredentials WHERE email = ?`, [email || ""]) || null;
}

/** Upsert by email — re-adding the same mailbox replaces its credentials. */
export async function createImapCredential(data) {
  const db = await getAdapter();
  const now = new Date().toISOString();
  const existing = data.email ? await getImapCredentialByEmail(data.email) : null;
  const id = existing?.id || uuidv4();
  db.run(
    `INSERT INTO imapCredentials(id, email, clientId, refreshToken, provider, testStatus, lastTested, lastError, createdAt, updatedAt)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       email=excluded.email, clientId=excluded.clientId, refreshToken=excluded.refreshToken,
       provider=excluded.provider, testStatus=excluded.testStatus, lastTested=excluded.lastTested,
       lastError=excluded.lastError, updatedAt=excluded.updatedAt`,
    [id, data.email, data.clientId, data.refreshToken, data.provider || "outlook",
     data.testStatus ?? null, data.lastTested ?? null, data.lastError ?? null, existing?.createdAt || now, now]
  );
  return getImapCredentialById(id);
}

export async function updateImapCredential(id, patch) {
  const db = await getAdapter();
  const existing = await getImapCredentialById(id);
  if (!existing) return null;
  const merged = { ...existing, ...patch, id, updatedAt: new Date().toISOString() };
  db.run(
    `UPDATE imapCredentials SET email=?, clientId=?, refreshToken=?, provider=?, testStatus=?, lastTested=?, lastError=?, updatedAt=? WHERE id=?`,
    [merged.email, merged.clientId, merged.refreshToken, merged.provider,
     merged.testStatus ?? null, merged.lastTested ?? null, merged.lastError ?? null, merged.updatedAt, id]
  );
  return getImapCredentialById(id);
}

export async function deleteImapCredential(id) {
  const db = await getAdapter();
  db.run(`DELETE FROM imapCredentials WHERE id = ?`, [id]);
  return true;
}
