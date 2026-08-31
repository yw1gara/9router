import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fsPromises from "fs/promises";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const Database = require_("better-sqlite3");

let tempHome;

// Mock next/server
vi.mock("next/server", () => ({
  NextResponse: {
    json: vi.fn((body, init) => ({
      status: init?.status || 200,
      body,
      json: async () => body,
    })),
  },
}));

// Mock os.homedir → temp dir holding a REAL state.vscdb so the route's
// runtime require("better-sqlite3") exercises the genuine extraction path.
// Keep every other os function (tmpdir, etc.) intact.
vi.mock("os", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    default: { ...actual, homedir: vi.fn(() => tempHome) },
    homedir: vi.fn(() => tempHome),
  };
});

// Mock fs/promises access — path probing always "succeeds" for the first
// candidate (the db we create lives there anyway).
vi.mock("fs/promises", () => ({
  access: vi.fn(),
  constants: { R_OK: 4 },
}));

// Mock child_process — the CLI fallback and the Linux which-cursor probe
// must never spawn real subprocesses in tests.
vi.mock("child_process", () => ({
  default: {
    execFile: vi.fn((cmd, args, opts, cb) => {
      if (typeof opts === "function") cb = opts;
      cb(new Error("ENOENT"));
    }),
  },
  execFile: vi.fn((cmd, args, opts, cb) => {
    if (typeof opts === "function") cb = opts;
    cb(new Error("ENOENT"));
  }),
}));

let GET;

function seedDb(rows) {
  const dir = path.join(tempHome, "Library/Application Support/Cursor/User/globalStorage");
  fs.mkdirSync(dir, { recursive: true });
  const db = new Database(path.join(dir, "state.vscdb"));
  db.exec("CREATE TABLE IF NOT EXISTS itemTable (key TEXT PRIMARY KEY, value BLOB)");
  const insert = db.prepare("INSERT INTO itemTable (key, value) VALUES (?, ?)");
  for (const [k, v] of Object.entries(rows)) insert.run(k, v);
  db.close();
}

describe("GET /api/oauth/cursor/auto-import", () => {
  const originalPlatform = process.platform;

  beforeEach(async () => {
    vi.clearAllMocks();
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "9r-cursor-import-"));
    Object.defineProperty(process, "platform", { value: "darwin", writable: true });
    const mod = await import("../../src/app/api/oauth/cursor/auto-import/route.js");
    GET = mod.GET;
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform, writable: true });
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  // ── Path probing ─────────────────────────────────────────────────────

  it("returns not-found with the checked locations when no db path is accessible", async () => {
    vi.mocked(fsPromises.access).mockRejectedValue(new Error("ENOENT"));

    const response = await GET();

    expect(response.body.found).toBe(false);
    expect(response.body.error).toContain("Cursor database not found. Checked locations:");
    expect(response.body.error).toContain("state.vscdb");
  });

  it("falls back to manual paste when the db cannot be opened by any strategy", async () => {
    // access "succeeds" but no real file exists at the candidate path —
    // better-sqlite3 (fileMustExist) and the mocked sqlite3 CLI both fail.
    vi.mocked(fsPromises.access).mockResolvedValue();

    const response = await GET();

    expect(response.body.found).toBe(false);
    expect(response.body.windowsManual).toBe(true);
    expect(response.body.dbPath).toContain("state.vscdb");
  });

  // ── Token extraction (real better-sqlite3 against a seeded db) ───────

  it("extracts tokens using exact keys", async () => {
    seedDb({
      "cursorAuth/accessToken": "test-token",
      "storage.serviceMachineId": "test-machine-id",
    });
    vi.mocked(fsPromises.access).mockResolvedValue();

    const response = await GET();

    expect(response.body.found).toBe(true);
    expect(response.body.accessToken).toBe("test-token");
    expect(response.body.machineId).toBe("test-machine-id");
  });

  it("unwraps JSON-encoded string values", async () => {
    seedDb({
      "cursorAuth/accessToken": '"json-token"',
      "storage.serviceMachineId": '"json-machine-id"',
    });
    vi.mocked(fsPromises.access).mockResolvedValue();

    const response = await GET();

    expect(response.body.found).toBe(true);
    expect(response.body.accessToken).toBe("json-token");
    expect(response.body.machineId).toBe("json-machine-id");
  });

  it("uses the secondary machine-id key when the primary is missing", async () => {
    seedDb({
      "cursorAuth/accessToken": "tok",
      "storage.machineId": "secondary-machine",
    });
    vi.mocked(fsPromises.access).mockResolvedValue();

    const response = await GET();

    expect(response.body.found).toBe(true);
    expect(response.body.machineId).toBe("secondary-machine");
  });

  it("returns manual fallback when the db has no tokens", async () => {
    seedDb({});
    vi.mocked(fsPromises.access).mockResolvedValue();

    const response = await GET();

    expect(response.body.found).toBe(false);
    expect(response.body.windowsManual).toBe(true);
  });

  // ── Linux / other platforms ──────────────────────────────────────────

  it("linux probes .config paths and reports checked locations when missing", async () => {
    Object.defineProperty(process, "platform", { value: "linux", writable: true });
    vi.mocked(fsPromises.access).mockRejectedValue(new Error("ENOENT"));

    const response = await GET();

    expect(response.body.found).toBe(false);
    expect(response.body.error).toContain("Cursor database not found. Checked locations:");
    expect(response.body.error).toContain(".config/Cursor");
  });

  it("non-darwin/win32 platforms fall back to the linux-style path probing", async () => {
    Object.defineProperty(process, "platform", { value: "freebsd", writable: true });
    vi.mocked(fsPromises.access).mockRejectedValue(new Error("ENOENT"));

    const response = await GET();

    expect(response.status).toBe(200);
    expect(response.body.found).toBe(false);
    expect(response.body.error).toContain("Cursor database not found");
  });
});
