function hasAutoUnavailableMarker(connection) {
  const data = connection?.providerSpecificData || {};
  return Boolean(data.autoRecoveryDisabled || data.autoQuotaDisabled);
}

export function getProviderConnectionStatus(provider) {
  const connections = Array.isArray(provider?.connections)
    ? provider.connections
    : [];
  if (connections.length === 0) return "empty";
  if (connections.some((connection) => connection.isActive !== false)) {
    return "active";
  }
  if (connections.some(hasAutoUnavailableMarker)) return "unavailable";
  return "disabled";
}

const STATUS_RANKS = {
  "active-first": {
    active: 0,
    unavailable: 1,
    disabled: 2,
    empty: 3,
  },
  "unavailable-first": {
    unavailable: 0,
    active: 1,
    disabled: 2,
    empty: 3,
  },
};

export function sortProvidersByStatus(providers, mode) {
  const ranks = STATUS_RANKS[mode];
  if (!ranks) return [...providers];

  return [...providers].sort((a, b) => {
    const statusDiff =
      ranks[getProviderConnectionStatus(a)] -
      ranks[getProviderConnectionStatus(b)];
    if (statusDiff !== 0) return statusDiff;
    return String(a?.name || "").localeCompare(String(b?.name || ""));
  });
}
