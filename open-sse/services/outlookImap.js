/**
 * Outlook IMAP XOAUTH2 access for the mail-recovery flow.
 *
 * Purpose: read the ONE OpenAI OTP email from the user's own mailbox so a
 * Codex re-login via the official device flow takes seconds instead of a
 * manual inbox hunt. Only the user's own credentials are used; nothing here
 * submits passwords to OpenAI or circumvents bot protections.
 *
 * Credential line format (same as the community tool the user referenced):
 *   email----password----client_id----refresh_token
 * The PASSWORD field is parsed away and never persisted or logged — it exists
 * only so the paste-format matches what the user already has on hand.
 */
import { ImapFlow } from "imapflow";

const MS_TOKEN_URL = "https://login.microsoftonline.com/consumers/oauth2/v2.0/token";
const IMAP_HOST = "outlook.office365.com";
const IMAP_PORT = 993;
const OTP_WINDOW_MS = 10 * 60 * 1000; // only trust codes from the last 10 minutes
const SEARCH_FOLDERS = ["INBOX", "Junk", "Spam"];

/**
 * Parse `email----password----client_id----refresh_token` (password ignored).
 * Also accepts the 3-part form without a password slot.
 * @returns {{ email, clientId, refreshToken } | { error: string }}
 */
export function parseCredentialLine(line) {
  const parts = String(line || "").split("----").map((p) => p.trim());
  if (parts.length === 4) {
    const [email, , clientId, refreshToken] = parts;
    if (!email || !clientId || !refreshToken) return { error: "Incomplete credential line" };
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { error: `Invalid email: ${email}` };
    return { email, clientId, refreshToken };
  }
  if (parts.length === 3) {
    const [email, clientId, refreshToken] = parts;
    if (!email || !clientId || !refreshToken) return { error: "Incomplete credential line" };
    return { email, clientId, refreshToken };
  }
  return { error: "Expected format: email----password----client_id----refresh_token" };
}

/** Exchange the mailbox refresh token for a short-lived IMAP access token. */
export async function getAccessToken(clientId, refreshToken) {
  const res = await fetch(MS_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      scope: "https://outlook.office.com/imap/.default offline_access",
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    const desc = data.error_description || data.error || `HTTP ${res.status}`;
    return { error: `Microsoft token exchange failed: ${String(desc).slice(0, 180)}` };
  }
  return { accessToken: data.access_token };
}

async function connect(cred) {
  const { accessToken, error } = await getAccessToken(cred.clientId, cred.refreshToken);
  if (error) throw new Error(error);
  const client = new ImapFlow({
    host: IMAP_HOST,
    port: IMAP_PORT,
    secure: true,
    auth: { user: cred.email, accessToken },
    logger: false,
    emitLogs: false,
  });
  await client.connect();
  return client;
}

/** Verify credentials work: token exchange + IMAP login + mailbox list. */
export async function testImapConnection(cred) {
  let client;
  try {
    client = await connect(cred);
    const list = await client.list();
    return { ok: true, mailboxes: list.map((b) => b.path).slice(0, 20) };
  } finally {
    client?.close().catch(() => {});
  }
}

function extractOtpCode(text) {
  if (!text) return null;
  // OpenAI codes are 6 digits, usually standing alone ("Your code is 123456").
  const inline = text.match(/\b(\d{6})\b/);
  return inline ? inline[1] : null;
}

/**
 * Fetch the most recent OpenAI OTP email newer than `sinceMs`.
 * Scans INBOX/Junk/Spam for mail from openai.com senders, newest first.
 * @returns {{ code, subject, from, date } | null}
 */
export async function fetchLatestOpenAiOtp(cred, sinceMs) {
  const since = sinceMs || Date.now() - OTP_WINDOW_MS;
  let client;
  try {
    client = await connect(cred);
    let best = null;
    for (const folder of SEARCH_FOLDERS) {
      const lock = await client.getMailboxLock(folder).catch(() => null);
      if (!lock) continue;
      try {
        const mailbox = client.mailbox;
        if (!mailbox) continue;
        // Walk backwards over recent messages (last 50) looking for OpenAI OTP.
        const start = Math.max(1, mailbox.exists - 50);
        for (let seq = mailbox.exists; seq >= start && !best; seq--) {
          const msg = await client.fetchOne(
            seq,
            { uid: true, envelope: true, internalDate: true },
            { uid: false }
          ).catch(() => null);
          if (!msg?.envelope) continue;
          const from = (msg.envelope.from?.[0]?.address || "").toLowerCase();
          const subject = msg.envelope.subject || "";
          const date = msg.internalDate ? msg.internalDate.getTime() : Date.parse(msg.envelope.date) || 0;
          if (!from.endsWith("@openai.com") && !from.includes("openai.com")) continue;
          if (date < since) continue;
          const raw = await client.fetchOne(msg.uid, { source: true }, { uid: true }).catch(() => null);
          const body = raw?.source ? raw.source.toString("utf8") : "";
          const code = extractOtpCode(`${subject} ${body}`);
          if (code && (!best || date > best.date)) {
            best = { code, subject, from: msg.envelope.from?.[0]?.address || "", date };
          }
        }
      } finally {
        lock.release();
      }
      if (best) break;
    }
    return best;
  } finally {
    client?.close().catch(() => {});
  }
}
