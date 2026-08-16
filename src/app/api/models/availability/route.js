import { NextResponse } from "next/server";
import {
  getProviderConnections,
  updateProviderConnection,
  getProviderNodes,
  getProviderConnectionById,
} from "@/lib/localDb";

const MODEL_LOCK_PREFIX = "modelLock_";

function getActiveModelLocks(connection) {
  const now = Date.now();
  return Object.entries(connection)
    .filter(([key, value]) => key.startsWith(MODEL_LOCK_PREFIX) && value)
    .map(([key, value]) => ({
      key,
      model: key.slice(MODEL_LOCK_PREFIX.length) || "__all",
      until: value,
      active: new Date(value).getTime() > now,
    }))
    .filter((lock) => lock.active);
}

export async function GET() {
  try {
    const [connections, providerNodes] = await Promise.all([
      getProviderConnections(),
      getProviderNodes().catch(() => []),
    ]);
    // Custom providers carry opaque internal ids — show their display name.
    const providerNames = {};
    for (const n of providerNodes) {
      if (n?.id && n.name) providerNames[n.id] = n.name;
    }
    const models = [];

    for (const connection of connections) {
      const providerLabel = providerNames[connection.provider] || connection.provider;
      const locks = getActiveModelLocks(connection);
      for (const lock of locks) {
        models.push({
          provider: providerLabel,
          providerId: connection.provider,
          model: lock.model,
          status: "cooldown",
          until: lock.until,
          connectionId: connection.id,
          connectionName: connection.name || connection.email || connection.id,
          lastError: connection.lastError || null,
          lastErrorAt: connection.lastErrorAt || null,
        });
      }

      if (locks.length === 0 && connection.testStatus === "unavailable") {
        models.push({
          provider: providerLabel,
          providerId: connection.provider,
          model: "__all",
          status: "unavailable",
          connectionId: connection.id,
          connectionName: connection.name || connection.email || connection.id,
          lastError: connection.lastError || null,
          lastErrorAt: connection.lastErrorAt || null,
        });
      }

      // Best-effort purge of expired lock keys so stale entries don't
      // accumulate in the DB (clearAccountError only cleans them lazily on
      // the connection's next successful request, which may never come).
      // Re-read the row right before writing: the snapshot above may be
      // milliseconds stale, and nulling a key that markAccountUnavailable
      // just re-armed would erase a fresh cooldown.
      const expired = Object.entries(connection)
        .filter(([key, value]) => key.startsWith(MODEL_LOCK_PREFIX) && value && new Date(value).getTime() <= Date.now())
        .map(([key]) => key);
      if (expired.length > 0) {
        try {
          const fresh = await getProviderConnectionById(connection.id);
          const stillExpired = expired.filter((key) => {
            const v = fresh?.[key];
            return v && new Date(v).getTime() <= Date.now();
          });
          if (stillExpired.length > 0) {
            await updateProviderConnection(connection.id, Object.fromEntries(stillExpired.map((key) => [key, null])));
          }
        } catch { /* purge is best-effort */ }
      }
    }

    return NextResponse.json({
      models,
      unavailableCount: models.length,
    });
  } catch (error) {
    console.error("[API] Failed to get model availability:", error);
    return NextResponse.json(
      { error: "Failed to fetch model availability" },
      { status: 500 },
    );
  }
}

export async function POST(request) {
  try {
    const { action, provider, model } = await request.json();

    if (action !== "clearCooldown" || !provider || !model) {
      return NextResponse.json({ error: "Invalid request" }, { status: 400 });
    }

    // The client may send the display label (custom providers) or the raw id —
    // resolve labels back to the internal provider id before filtering.
    let providerId = provider;
    let connections = await getProviderConnections({ provider });
    if (connections.length === 0) {
      const nodes = await getProviderNodes().catch(() => []);
      const node = nodes.find((n) => n.name === provider);
      if (node) {
        providerId = node.id;
        connections = await getProviderConnections({ provider: providerId });
      }
    }
    const lockKey = `${MODEL_LOCK_PREFIX}${model}`;

    await Promise.all(
      connections
        .filter((connection) => connection[lockKey])
        .map((connection) =>
          updateProviderConnection(connection.id, {
            [lockKey]: null,
            ...(connection.testStatus === "unavailable"
              ? {
                  testStatus: "active",
                  lastError: null,
                  lastErrorAt: null,
                  backoffLevel: 0,
                }
              : {}),
          }),
        ),
    );

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("[API] Failed to clear model cooldown:", error);
    return NextResponse.json(
      { error: "Failed to clear cooldown" },
      { status: 500 },
    );
  }
}
