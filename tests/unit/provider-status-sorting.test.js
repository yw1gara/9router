import { describe, expect, it } from "vitest";
import { sortProvidersByStatus } from "@/shared/utils/providerStatusSorting.js";

const provider = (id, name, connections) => ({ id, name, connections });

const providers = [
  provider("active-zulu", "Zulu Active", [
    { id: "connection-active-zulu", isActive: true, testStatus: "success" },
  ]),
  provider("empty-zulu", "Zulu Empty", []),
  provider("manual-zulu", "Zulu Disabled", [
    { id: "connection-manual-zulu", isActive: false, providerSpecificData: {} },
  ]),
  provider("auto-zulu", "Zulu Unavailable", [
    {
      id: "connection-auto-zulu",
      isActive: false,
      providerSpecificData: { autoQuotaDisabled: "2026-08-24T12:00:00.000Z" },
    },
  ]),
  provider("auto-alpha", "Alpha Unavailable", [
    {
      id: "connection-auto-alpha",
      isActive: false,
      providerSpecificData: { autoQuotaDisabled: "2026-08-24T12:00:00.000Z" },
    },
  ]),
  provider("manual-alpha", "Alpha Disabled", [
    { id: "connection-manual-alpha", isActive: false },
  ]),
  provider("empty-alpha", "Alpha Empty", []),
  provider("active-alpha", "Alpha Active", [
    { id: "connection-active-alpha", isActive: true, testStatus: "active" },
  ]),
];

const ids = (items) => items.map(({ id }) => id);

describe("sortProvidersByStatus", () => {
  it("sorts active providers first while keeping unavailable, manually disabled, and empty providers distinct", () => {
    expect(ids(sortProvidersByStatus(providers, "active-first"))).toEqual([
      "active-alpha",
      "active-zulu",
      "auto-alpha",
      "auto-zulu",
      "manual-alpha",
      "manual-zulu",
      "empty-alpha",
      "empty-zulu",
    ]);
  });

  it("sorts automatically unavailable providers first without treating manual disables or empty providers as unavailable", () => {
    expect(ids(sortProvidersByStatus(providers, "unavailable-first"))).toEqual([
      "auto-alpha",
      "auto-zulu",
      "active-alpha",
      "active-zulu",
      "manual-alpha",
      "manual-zulu",
      "empty-alpha",
      "empty-zulu",
    ]);
  });

  it("does not mutate the caller's provider array", () => {
    const input = [...providers];

    sortProvidersByStatus(input, "active-first");

    expect(input).toEqual(providers);
  });
});
