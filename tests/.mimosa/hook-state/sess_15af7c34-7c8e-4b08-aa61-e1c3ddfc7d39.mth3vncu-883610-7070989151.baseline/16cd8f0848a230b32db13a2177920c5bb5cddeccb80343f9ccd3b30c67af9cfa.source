import { beforeEach, describe, expect, it, vi } from "vitest";

const dbState = { raw: {} };
const db = {
  get: vi.fn(() => ({ data: JSON.stringify(dbState.raw) })),
  run: vi.fn((_sql, [data]) => {
    dbState.raw = JSON.parse(data);
  }),
  transaction: vi.fn((callback) => callback()),
};

vi.mock("../../src/lib/db/driver.js", () => ({
  getAdapter: vi.fn(async () => db),
}));

const updateProviderRecoverySettingsMock = vi.fn();
const configureProviderRecoveryMonitorMock = vi.fn();

vi.mock("@/lib/localDb", () => ({
  getSettings: vi.fn(),
  updateProviderRecoverySettings: updateProviderRecoverySettingsMock,
}));

vi.mock("@/sse/services/providerRecoveryMonitor.js", () => ({
  configureProviderRecoveryMonitor: configureProviderRecoveryMonitorMock,
}));

describe("provider recovery settings repository", () => {
  beforeEach(() => {
    dbState.raw = {
      unrelated: "preserved",
      providerRecovery: {
        orcarouter: { enabled: true, intervalMinutes: 10, applyProxy: false },
        tokenrouter: { enabled: false, intervalMinutes: 30, applyProxy: true },
      },
    };
    db.get.mockClear();
    db.run.mockClear();
    db.transaction.mockClear();
  });

  it("atomically merges one provider without overwriting other providers or settings", async () => {
    const { updateProviderRecoverySettings } = await import(
      "../../src/lib/db/repos/settingsRepo.js"
    );

    const settings = await updateProviderRecoverySettings("orcarouter", {
      enabled: false,
      intervalMinutes: 20,
      applyProxy: true,
    });

    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(dbState.raw).toEqual({
      unrelated: "preserved",
      providerRecovery: {
        orcarouter: { enabled: false, intervalMinutes: 20, applyProxy: true },
        tokenrouter: { enabled: false, intervalMinutes: 30, applyProxy: true },
      },
    });
    expect(settings.providerRecovery).toEqual(dbState.raw.providerRecovery);
  });
});

describe("provider recovery settings API", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { getSettings } = await import("@/lib/localDb");
    getSettings.mockResolvedValue({ providerRecovery: {} });
    updateProviderRecoverySettingsMock.mockResolvedValue({
      providerRecovery: {
        orcarouter: { enabled: true, intervalMinutes: 25, applyProxy: false },
      },
    });
  });

  async function route() {
    return import("../../src/app/api/settings/provider-recovery/[provider]/route.js");
  }

  it("returns defaults for an unconfigured supported provider", async () => {
    const { GET } = await route();
    const response = await GET(new Request("http://localhost/api/settings/provider-recovery/orcarouter"), {
      params: Promise.resolve({ provider: "orcarouter" }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      provider: "orcarouter",
      enabled: false,
      intervalMinutes: 15,
      applyProxy: false,
    });
  });

  it("rejects unsupported providers", async () => {
    const { PATCH } = await route();
    const response = await PATCH(new Request("http://localhost/api/settings/provider-recovery/openai", {
      method: "PATCH",
      body: JSON.stringify({ enabled: true, intervalMinutes: 15, applyProxy: false }),
    }), { params: Promise.resolve({ provider: "openai" }) });

    expect(response.status).toBe(404);
    expect(updateProviderRecoverySettingsMock).not.toHaveBeenCalled();
  });

  it.each([
    [{ enabled: "yes", intervalMinutes: 15, applyProxy: false }],
    [{ enabled: true, intervalMinutes: 4, applyProxy: false }],
    [{ enabled: true, intervalMinutes: 1441, applyProxy: false }],
    [{ enabled: true, intervalMinutes: 15.5, applyProxy: false }],
    [{ enabled: true, intervalMinutes: 15, applyProxy: 1 }],
    [{ enabled: true, intervalMinutes: 15, applyProxy: false, unexpected: true }],
  ])("rejects invalid config %j", async (config) => {
    const { PATCH } = await route();
    const response = await PATCH(new Request("http://localhost/api/settings/provider-recovery/orcarouter", {
      method: "PATCH",
      body: JSON.stringify(config),
    }), { params: Promise.resolve({ provider: "orcarouter" }) });

    expect(response.status).toBe(400);
    expect(updateProviderRecoverySettingsMock).not.toHaveBeenCalled();
  });

  it("persists a complete config and lazily reconfigures the scheduler", async () => {
    const { PATCH } = await route();
    const config = { enabled: true, intervalMinutes: 25, applyProxy: false };
    const response = await PATCH(new Request("http://localhost/api/settings/provider-recovery/orcarouter", {
      method: "PATCH",
      body: JSON.stringify(config),
    }), { params: Promise.resolve({ provider: "orcarouter" }) });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ provider: "orcarouter", ...config });
    expect(updateProviderRecoverySettingsMock).toHaveBeenCalledWith("orcarouter", config);
    await vi.waitFor(() => {
      expect(configureProviderRecoveryMonitorMock).toHaveBeenCalledTimes(1);
    });
  });
});
