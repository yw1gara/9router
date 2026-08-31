import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createAutomationRun,
  updateAutomationRun,
  createAutomationResult,
} from "@/lib/db/repos/automationsRepo";
import { importKey } from "./importer";

// Deployed OrcaRouter-farm location + virtualenv on this server.
const SCRIPT_DIR = process.env.AUTOMATIONS_DIR || "/root/work/OrcaRouter-farm";
const PYTHON = process.env.AUTOMATIONS_PYTHON || path.join(SCRIPT_DIR, "venv", "bin", "python3");

const KIND_SCRIPT = {
  "opencode-zen": "zen_farm.py",
  "tokenrouter": "tokenrouter_farm.py",
  "orcarouter": "farm.py",
  "tokenharbor": "tokenharbor_farm.py",
};

// Kinds that self-generate their own disposable identities (e.g. catch-all
// temp-mail signups) — they run without an account list; --limit decides how
// many identities are created. Account lists are still accepted when supplied.
const SELF_GENERATED_KINDS = new Set(["tokenharbor"]);

const MAX_THREADS = 10;

const active = new Map(); // kind -> runId

export function isRunning(kind) {
  return active.has(kind);
}

export function activeRunId(kind) {
  return active.get(kind) || null;
}

/**
 * Dynamic multi-process runner.
 *
 * The browser only ever talks to this backend (API trigger). The backend
 * splits the selected accounts into up to `threads` (max 10) worker chunks
 * and spawns one Python farm process per chunk. All lifecycle management
 * (spawn/monitor/merge/import) happens here — no shell involvement from the
 * client, no command system.
 *
 * autoImport=true → harvested keys become provider connections automatically;
 * autoImport=false → keys are only stored in automationResults (exportable).
 */
export async function startRun(
  kind,
  accounts,
  { limit = 0, delay = 3, autoImport = true, threads = 1, proxies = [] } = {}
) {
  if (active.has(kind)) {
    return { error: `Automation "${kind}" is already running (run ${active.get(kind)}).` };
  }
  const selfGenerated = SELF_GENERATED_KINDS.has(kind);
  const script = KIND_SCRIPT[kind];
  if (!script) return { error: "unknown automation kind" };
  if (!accounts.length && !selfGenerated) return { error: "no accounts selected" };

  // Self-generated identities run in a single process (the script itself
  // serializes account creation); supplied accounts still fan out to threads.
  const nThreads = selfGenerated && !accounts.length
    ? 1
    : Math.min(MAX_THREADS, Math.max(1, Number(threads) || 1));
  const proxyList = Array.isArray(proxies)
    ? proxies.map((p) => String(p).trim()).filter(Boolean)
    : [];

  const run = await createAutomationRun(kind);
  active.set(kind, run.id);

  // Split accounts into thread chunks (round-robin keeps sizes balanced).
  const chunks = Array.from({ length: nThreads }, () => []);
  accounts.forEach((a, i) => chunks[i % nThreads].push(a));
  const nonEmpty = chunks.filter((c) => c.length > 0);
  // Self-generated kinds still spawn once even without an account list.
  if (!nonEmpty.length && selfGenerated) nonEmpty.push([]);

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "automation-"));
  let logBuf = "";
  const appendLog = (chunk) => {
    logBuf += chunk;
    if (logBuf.length > 40000) logBuf = logBuf.slice(-40000);
  };

  // Persist the log tail periodically so the UI can show progress.
  const logTimer = setInterval(() => {
    updateAutomationRun(run.id, { log: logBuf }).catch(() => {});
  }, 4000);

  let finishedChildren = 0;
  const chunksJson = []; // { results, accounts }

  const finalize = async (exitCode) => {
    clearInterval(logTimer);

    // Merge all chunk JSONs.
    const results = chunksJson.flatMap((c) => c.results);
    const requested = chunksJson.flatMap((c) => c.accounts);

    let success = 0;
    let failed = 0;
    for (const r of results) {
      let connectionId = null;
      let error = r.error || null;
      if (r.status === "success" && r.key) {
        if (autoImport) {
          try {
            const imp = await importKey(run.id, kind, r.email, r.key);
            if (imp.connectionId) connectionId = imp.connectionId;
            else error = imp.error || error;
          } catch (e) {
            error = `import failed: ${e?.message || e}`;
          }
        }
      }
      const st = r.status === "success" && !error ? "success" : "failed";
      if (st === "success") success += 1;
      else failed += 1;
      await createAutomationResult(run.id, kind, r.email, st, st === "success" ? r.key : null, error, connectionId);
    }

    // Accounts the script never produced a JSON record for count as failed.
    const seen = new Set(results.map((r) => String(r.email || "").toLowerCase()));
    for (const a of requested) {
      if (!seen.has(a.email.toLowerCase())) {
        failed += 1;
        await createAutomationResult(run.id, kind, a.email, "failed", null, "no result from script", null);
      }
    }

    await updateAutomationRun(run.id, {
      status: exitCode === 0 ? "done" : "failed",
      // Self-generated kinds have no requested-account list — count the
      // results the script actually produced.
      total: Math.max(requested.length, results.length),
      success,
      failed,
      log: logBuf,
      finishedAt: new Date().toISOString(),
    });
    active.delete(kind);
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  };

  for (let i = 0; i < nonEmpty.length; i++) {
    const chunk = nonEmpty[i];
    const jsonFile = path.join(dir, `results-${i}.json`);
    let accFile = null;
    if (chunk.length > 0) {
      accFile = path.join(dir, `accounts-${i}.txt`);
      await fs.writeFile(
        accFile,
        chunk.map((a) => `${a.email}|${a.password}`).join("\n") + "\n",
        { encoding: "utf8", mode: 0o600 }
      );
    }

    // Per-chunk proxy file, cycling the provided proxies across accounts.
    let proxyFile = null;
    if (proxyList.length) {
      proxyFile = path.join(dir, `proxies-${i}.txt`);
      // Self-generated chunks have no account rows — pre-roll enough lines for
      // the worst case (target-success attempts capped at 3x limit) so every
      // attempt still gets its own rotating proxy.
      const lineCount = chunk.length > 0
        ? chunk.length
        : Math.max(proxyList.length, Math.max(1, limit) * 3);
      const lines = Array.from({ length: lineCount }, (_, j) => proxyList[j % proxyList.length]);
      await fs.writeFile(proxyFile, lines.join("\n") + "\n", { encoding: "utf8", mode: 0o600 });
    }

    const args = [
      path.join(SCRIPT_DIR, script),
      "--headless",
      "--json-out", jsonFile,
      "--delay", String(delay),
    ];
    if (accFile) args.push("--account-file", accFile);
    if (limit > 0) {
      // Self-generated kinds treat the limit as a target number of SUCCESSES:
      // the script keeps creating fresh identities (retrying failures) until
      // the target is hit. Account-based kinds use it as a plain cap.
      if (selfGenerated && !accFile) args.push("--target-success", String(limit));
      else args.push("--limit", String(limit));
    }
    if (proxyFile) args.push("--proxy-file", proxyFile);

    const child = spawn(PYTHON, args, {
      cwd: SCRIPT_DIR,
      env: { ...process.env, PYTHONUNBUFFERED: "1" },
    });

    child.stdout.on("data", (d) => appendLog(`[w${i}] ${String(d)}`));
    child.stderr.on("data", (d) => appendLog(`[w${i}] ${String(d)}`));
    child.on("error", (err) => appendLog(`[w${i}] SPAWN ERROR: ${err.message}\n`));

    child.on("exit", async (code) => {
      try {
        const raw = JSON.parse(await fs.readFile(jsonFile, "utf8"));
        chunksJson.push({ results: Array.isArray(raw.results) ? raw.results : [], accounts: chunk });
      } catch {
        chunksJson.push({ results: [], accounts: chunk });
      }
      finishedChildren += 1;
      if (finishedChildren >= nonEmpty.length) {
        const allOk = finishedChildren === nonEmpty.length && code === 0;
        await finalize(allOk ? 0 : code ?? -1);
      }
    });
  }

  return { runId: run.id, threads: nonEmpty.length };
}
