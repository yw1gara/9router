// Automation tools managed from the dashboard.
// Each automation maps to a farm script in OrcaRouter-farm. Most work with
// an account list in `email|password` format (one account per line);
// `selfGenerated` kinds create their own disposable identities and run
// without an account list (only a limit/count is needed).
export const AUTOMATION_KINDS = [
  {
    id: "opencode-zen",
    label: "OpenCode Zen",
    icon: "self_improvement",
    description: "Harvest OpenCode Zen API keys — opencode.ai/zen → Google OAuth → copy key from the dashboard.",
    script: "zen_farm.py",
  },
  {
    id: "tokenrouter",
    label: "TokenRouter",
    icon: "route",
    description: "Sign up + Google OAuth on tokenrouter.com, then create & copy a console API key.",
    script: "tokenrouter_farm.py",
  },
  {
    id: "orcarouter",
    label: "OrcaRouter",
    icon: "waves",
    description: "Register via Google OAuth on orcarouter.ai and harvest an sk-orca-* API key.",
    script: "farm.py",
  },
  {
    id: "tokenharbor",
    label: "Token Harbor",
    icon: "anchor",
    description: "Auto-create disposable @huawazi.lat accounts on tokenharbor.ai, verify email, harvest the thk_* API key — no account list needed.",
    script: "tokenharbor_farm.py",
    // Creates its own identities (catch-all temp mail); runs without accounts.
    selfGenerated: true,
  },
];

export function getAutomationKind(id) {
  return AUTOMATION_KINDS.find((k) => k.id === id) || null;
}

/**
 * Parse an `email|password` account list (one per line).
 * Blank lines and `#` comments are skipped.
 * Returns { valid: [{ email, password }], invalid: [{ raw, reason }] }.
 */
export function parseAccountsText(text) {
  const valid = [];
  const invalid = [];
  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const sep = line.indexOf("|");
    if (sep <= 0) {
      invalid.push({ raw: rawLine, reason: "Missing | separator" });
      continue;
    }
    const email = line.slice(0, sep).trim();
    const password = line.slice(sep + 1).trim();
    if (!email.includes("@")) {
      invalid.push({ raw: rawLine, reason: "Invalid email" });
      continue;
    }
    if (!password) {
      invalid.push({ raw: rawLine, reason: "Empty password" });
      continue;
    }
    valid.push({ email, password });
  }
  return { valid, invalid };
}
