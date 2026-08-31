import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  SUPPORTED_PROVIDER_RECOVERY_IDS,
  reconcileProviderRecoveryAccount,
  runProviderRecoveryMonitorTick,
  startProviderRecoveryMonitor,
  stopProviderRecoveryMonitor,
} from "../../src/sse/services/providerRecoveryMonitor.js";

const NOW = Date.parse("2026-08-24T12:00:00.000Z");
const FUTURE = new Date(NOW + 60 * 60 * 1000).toISOString();
const INTERVAL_MS = 5 * 60 * 1000;

function connection(overrides = {}) {
  return {
    id: "account-1",
    provider: "orcarouter",
    displayName: "Recovery account",
    authType: "apikey",
    apiKey: "test-key",
    isActive: true,
    testStatus: "active",
    providerSpecificData: { tenant: "tenant-a" },
    ...overrides,
  };
}

function catalog(ids, complete = true) {
  return {
    complete,
    models: ids.map((id) => ({ id, type: "llm" })),
  };
}

function createDeps(connections = []) {
  return {
    getProviderConnections: vi.fn().mockResolvedValue(connections),
    getProviderModelCatalog: vi.fn().mockResolvedValue(catalog(["model-a", "model-b"])),
    probeProviderModel: vi.fn().mockResolvedValue({ ok: false, status: 429, error: "rate limited" }),
    updateProviderConnection: vi.fn().mockResolvedValue(undefined),
  };
}

async function run(deps, overrides = {}) {
  return runProviderRecoveryMonitorTick(deps, {
    state: { lastRunAt: null },
    now: NOW,
    intervalMs: INTERVAL_MS,
    applyProxy: true,
    ...overrides,
  });
}

function updateFor(deps, id = "account-1") {
  const call = deps.updateProviderConnection.mock.calls.find(([connectionId]) => connectionId === id);
  expect(call, `expected an update for ${id}`).toBeDefined();
  return call[1];
}

describe("provider recovery policy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("supports exactly the provider recovery gateways", () => {
    expect([...SUPPORTED_PROVIDER_RECOVERY_IDS].sort()).toEqual([
      "opencode-zen",
      "orcarouter",
      "tokenrouter",
    ]);
  });

  it("keeps a partially model-locked account active and clears its account-level warning", async () => {
    const account = connection({
      testStatus: "unavailable",
      lastError: "Some models are rate limited",
      errorCode: 429,
      lastErrorAt: "2026-08-24T11:55:00.000Z",
      "modelLock_model-a": FUTURE,
    });
    const deps = createDeps([account]);

    const result = await run(deps);

    expect(result).toMatchObject({ ran: true, disabled: 0 });
    expect(updateFor(deps)).toEqual(expect.objectContaining({
      isActive: true,
      testStatus: "active",
      lastError: null,
      errorCode: null,
      lastErrorAt: null,
    }));
    expect(updateFor(deps).providerSpecificData).toEqual({ tenant: "tenant-a" });
    expect(deps.probeProviderModel).not.toHaveBeenCalled();
  });

  it("auto-disables when every known LLM model is locked and preserves provider-specific data", async () => {
    const account = connection({
      "modelLock_model-a": FUTURE,
      "modelLock_model-b": FUTURE,
      providerSpecificData: { tenant: "tenant-a", customFlag: true },
    });
    const deps = createDeps([account]);
    // Non-LLM catalog entries must not prevent an all-known-LLMs decision.
    deps.getProviderModelCatalog.mockResolvedValue({
      complete: true,
      models: [
        { id: "model-a", type: "llm" },
        { id: "model-b", type: "llm" },
        { id: "embed-a", type: "embedding" },
      ],
    });

    const result = await run(deps);

    expect(result).toMatchObject({ ran: true, disabled: 1 });
    expect(updateFor(deps)).toEqual(expect.objectContaining({
      isActive: false,
      testStatus: "unavailable",
      providerSpecificData: {
        tenant: "tenant-a",
        customFlag: true,
        autoRecoveryDisabled: new Date(NOW).toISOString(),
      },
    }));
  });

  it("never disables from an incomplete dynamic catalog", async () => {
    const account = connection({
      "modelLock_model-a": FUTURE,
      "modelLock_model-b": FUTURE,
    });
    const deps = createDeps([account]);
    deps.getProviderModelCatalog.mockResolvedValue(catalog(["model-a", "model-b"], false));

    const result = await run(deps);

    expect(result).toMatchObject({ ran: true, disabled: 0 });
    expect(deps.updateProviderConnection).not.toHaveBeenCalledWith(
      account.id,
      expect.objectContaining({ isActive: false }),
    );
  });
});

describe("provider account recovery", () => {
  it("probes only inactive accounts carrying the autoRecoveryDisabled marker", async () => {
    const autoDisabled = connection({
      id: "auto",
      isActive: false,
      testStatus: "unavailable",
      providerSpecificData: { autoRecoveryDisabled: "2026-08-24T11:00:00.000Z" },
      "modelLock_model-a": FUTURE,
    });
    const manuallyDisabled = connection({
      id: "manual",
      isActive: false,
      testStatus: "unavailable",
      providerSpecificData: { tenant: "manual-off" },
      "modelLock_model-a": FUTURE,
    });
    const activeWithStaleMarker = connection({
      id: "active-marked",
      isActive: true,
      providerSpecificData: { autoRecoveryDisabled: "2026-08-24T11:00:00.000Z" },
    });
    const unsupported = connection({
      id: "unsupported",
      provider: "openai",
      isActive: false,
      providerSpecificData: { autoRecoveryDisabled: "2026-08-24T11:00:00.000Z" },
    });
    const deps = createDeps([
      autoDisabled,
      manuallyDisabled,
      activeWithStaleMarker,
      unsupported,
    ]);

    await run(deps);

    expect(deps.getProviderModelCatalog).toHaveBeenCalledTimes(1);
    expect(deps.getProviderModelCatalog).toHaveBeenCalledWith(autoDisabled);
    expect(deps.probeProviderModel).toHaveBeenCalled();
    for (const [{ connection: probed } = {}] of deps.probeProviderModel.mock.calls) {
      expect(probed.id).toBe("auto");
    }
    expect(deps.updateProviderConnection).not.toHaveBeenCalledWith("manual", expect.anything());
    expect(deps.updateProviderConnection).not.toHaveBeenCalledWith("active-marked", expect.anything());
    expect(deps.updateProviderConnection).not.toHaveBeenCalledWith("unsupported", expect.anything());
  });

  it("re-enables after one model succeeds, clears only that lock, and retains other provider data", async () => {
    const account = connection({
      isActive: false,
      testStatus: "unavailable",
      lastError: "All models unavailable",
      errorCode: 429,
      lastErrorAt: "2026-08-24T11:00:00.000Z",
      "modelLock_model-a": FUTURE,
      "modelLock_model-b": FUTURE,
      providerSpecificData: {
        tenant: "tenant-a",
        autoRecoveryDisabled: "2026-08-24T11:00:00.000Z",
      },
    });
    const deps = createDeps([account]);
    deps.probeProviderModel.mockImplementation(async ({ model }) => (
      model === "model-b"
        ? { ok: true, status: 200 }
        : { ok: false, status: 429, error: "still limited" }
    ));

    const result = await run(deps);

    expect(result).toMatchObject({ ran: true, recovered: 1 });
    const patch = updateFor(deps);
    expect(patch).toEqual(expect.objectContaining({
      isActive: true,
      testStatus: "active",
      lastError: null,
      errorCode: null,
      lastErrorAt: null,
      "modelLock_model-b": null,
      providerSpecificData: { tenant: "tenant-a" },
    }));
    expect(patch).not.toHaveProperty("modelLock_model-a", null);
  });

  it("leaves an auto-disabled account unavailable when every model probe fails", async () => {
    const account = connection({
      isActive: false,
      testStatus: "unavailable",
      lastError: "All models unavailable",
      "modelLock_model-a": FUTURE,
      "modelLock_model-b": FUTURE,
      providerSpecificData: {
        tenant: "tenant-a",
        autoRecoveryDisabled: "2026-08-24T11:00:00.000Z",
      },
    });
    const deps = createDeps([account]);

    const result = await run(deps);

    expect(result).toMatchObject({ ran: true, recovered: 0 });
    expect(deps.probeProviderModel).toHaveBeenCalledTimes(2);
    expect(deps.updateProviderConnection).not.toHaveBeenCalledWith(
      account.id,
      expect.objectContaining({ isActive: true }),
    );
  });

  it("passes the applyProxy option through to every model probe", async () => {
    const account = connection({
      isActive: false,
      testStatus: "unavailable",
      "modelLock_model-a": FUTURE,
      "modelLock_model-b": FUTURE,
      providerSpecificData: { autoRecoveryDisabled: "2026-08-24T11:00:00.000Z" },
    });
    const deps = createDeps([account]);

    await run(deps, { applyProxy: false });

    expect(deps.probeProviderModel).toHaveBeenCalledTimes(2);
    expect(deps.probeProviderModel).toHaveBeenNthCalledWith(1, expect.objectContaining({
      connection: account,
      provider: "orcarouter",
      model: "model-a",
      applyProxy: false,
    }));
    expect(deps.probeProviderModel).toHaveBeenNthCalledWith(2, expect.objectContaining({
      connection: account,
      provider: "orcarouter",
      model: "model-b",
      applyProxy: false,
    }));
  });
});

describe("provider recovery production runtime", () => {
  it("reconciles one freshly persisted account immediately", async () => {
    const account = connection({
      testStatus: "unavailable",
      lastError: "rate limited",
      "modelLock_model-a": FUTURE,
    });
    const deps = createDeps([]);
    deps.getProviderConnectionById = vi.fn().mockResolvedValue(account);

    const result = await reconcileProviderRecoveryAccount(account.id, { deps, now: NOW });

    expect(result).toEqual({ reconciled: true, disabled: false, recovered: false });
    expect(deps.getProviderConnectionById).toHaveBeenCalledWith(account.id);
    expect(updateFor(deps)).toEqual(expect.objectContaining({ testStatus: "active" }));
  });

  it("starts one idempotent unref scheduler from settings and runs immediately", async () => {
    const deps = createDeps([]);
    deps.getSettings = vi.fn().mockResolvedValue({
      providerRecovery: { enabled: true, intervalMs: 12345, applyProxy: true },
    });
    const timer = { unref: vi.fn() };
    const setIntervalFn = vi.fn().mockReturnValue(timer);

    const first = await startProviderRecoveryMonitor({ deps, setIntervalFn });
    const second = await startProviderRecoveryMonitor({ deps, setIntervalFn });

    expect(first.started).toBe(true);
    expect(second).toEqual({ started: false, reason: "already-started" });
    expect(deps.getProviderConnections).toHaveBeenCalledTimes(1);
    expect(setIntervalFn).toHaveBeenCalledWith(expect.any(Function), 12345);
    expect(timer.unref).toHaveBeenCalled();
    stopProviderRecoveryMonitor();
  });

  it("does not start when provider recovery is disabled", async () => {
    const deps = createDeps([]);
    deps.getSettings = vi.fn().mockResolvedValue({ providerRecovery: { enabled: false } });
    const setIntervalFn = vi.fn();

    const result = await startProviderRecoveryMonitor({ deps, setIntervalFn });

    expect(result).toEqual({ started: false, reason: "disabled" });
    expect(setIntervalFn).not.toHaveBeenCalled();
  });
});

describe("provider recovery interval", () => {
  it("runs when the interval is due and records the run timestamp", async () => {
    const deps = createDeps([]);
    const state = { lastRunAt: NOW - INTERVAL_MS };

    const result = await run(deps, { state });

    expect(result).toMatchObject({ ran: true });
    expect(deps.getProviderConnections).toHaveBeenCalledTimes(1);
    expect(state.lastRunAt).toBe(NOW);
  });

  it("skips before the interval is due without loading accounts", async () => {
    const deps = createDeps([]);
    const state = { lastRunAt: NOW - INTERVAL_MS + 1 };

    const result = await run(deps, { state });

    expect(result).toMatchObject({ ran: false, reason: "interval-not-due" });
    expect(deps.getProviderConnections).not.toHaveBeenCalled();
    expect(state.lastRunAt).toBe(NOW - INTERVAL_MS + 1);
  });
});
