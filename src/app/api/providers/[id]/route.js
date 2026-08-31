import { NextResponse } from "next/server";
import {
  getProviderConnectionById,
  getProxyPoolById,
  updateProviderConnection,
  deleteProviderConnection,
} from "@/models";

function normalizeProxyConfig(body = {}) {
  const hasAnyProxyField =
    Object.prototype.hasOwnProperty.call(body, "connectionProxyEnabled") ||
    Object.prototype.hasOwnProperty.call(body, "connectionProxyUrl") ||
    Object.prototype.hasOwnProperty.call(body, "connectionNoProxy");

  if (!hasAnyProxyField) return { hasAnyProxyField: false };

  const enabled = body?.connectionProxyEnabled === true;
  const url = typeof body?.connectionProxyUrl === "string" ? body.connectionProxyUrl.trim() : "";
  const noProxy = typeof body?.connectionNoProxy === "string" ? body.connectionNoProxy.trim() : "";

  if (enabled && !url) {
    return {
      hasAnyProxyField: true,
      error: "Connection proxy URL is required when connection proxy is enabled",
    };
  }

  return {
    hasAnyProxyField: true,
    connectionProxyEnabled: enabled,
    connectionProxyUrl: url,
    connectionNoProxy: noProxy,
  };
}

async function normalizeProxyPoolUpdate(proxyPoolIdInput) {
  if (proxyPoolIdInput === undefined) {
    return { hasProxyPoolField: false, proxyPoolId: null };
  }

  if (proxyPoolIdInput === null || proxyPoolIdInput === "" || proxyPoolIdInput === "__none__") {
    return { hasProxyPoolField: true, proxyPoolId: null };
  }

  const proxyPoolId = String(proxyPoolIdInput).trim();
  if (!proxyPoolId) {
    return { hasProxyPoolField: true, proxyPoolId: null };
  }

  const proxyPool = await getProxyPoolById(proxyPoolId);
  if (!proxyPool) {
    return { hasProxyPoolField: true, error: "Proxy pool not found" };
  }

  return { hasProxyPoolField: true, proxyPoolId };
}

function shouldMergeProviderSpecificData(existing, incoming, hasLegacyProxy, hasProxyPoolField) {
  return existing !== undefined || incoming !== undefined || hasLegacyProxy || hasProxyPoolField;
}

const ROTATION_STRATEGIES = new Set(["fixed", "round-robin", "random", "smart"]);
// Smart rotation spreads accounts across the full pool inventory, so the
// per-connection cap must accommodate large imported pools. Env-tunable:
// MAX_POOLS_PER_CONNECTION (default 500).
const MAX_POOLS_PER_CONNECTION = (() => {
  const n = parseInt(process.env.MAX_POOLS_PER_CONNECTION, 10);
  return Number.isFinite(n) && n > 0 ? n : 500;
})();

// Multi-pool assignment: validate every id, dedupe, cap the list size.
async function normalizeMultiPoolUpdate(body) {
  if (body?.proxyPoolIds === undefined) {
    return { hasField: false, strategy: null, proxyRequired: null, poolIds: null };
  }
  if (!Array.isArray(body.proxyPoolIds)) {
    return { hasField: true, error: "proxyPoolIds must be an array" };
  }
  if (body.proxyRotationStrategy !== undefined && !ROTATION_STRATEGIES.has(body.proxyRotationStrategy)) {
    return { hasField: true, error: `Invalid proxyRotationStrategy (allowed: ${[...ROTATION_STRATEGIES].join(", ")})` };
  }
  const raw = body.proxyPoolIds;
  if (raw.length === 0) {
    return { hasField: true, strategy: null, proxyRequired: null, poolIds: [] };
  }
  const ids = [...new Set(raw.map((v) => String(v).trim()).filter(Boolean))];
  if (ids.length > MAX_POOLS_PER_CONNECTION) {
    return { hasField: true, error: `Too many pools (max ${MAX_POOLS_PER_CONNECTION})` };
  }
  for (const pid of ids) {
    const pool = await getProxyPoolById(pid);
    if (!pool) return { hasField: true, error: `Proxy pool not found: ${pid}` };
  }
  const strategy = body.proxyRotationStrategy !== undefined
    ? (ROTATION_STRATEGIES.has(body.proxyRotationStrategy) ? body.proxyRotationStrategy : "fixed")
    : null;
  const proxyRequired = typeof body.proxyRequired === "boolean" ? body.proxyRequired : null;
  return { hasField: true, strategy, proxyRequired, poolIds: ids };
}

// GET /api/providers/[id] - Get single connection
export async function GET(request, { params }) {
  try {
    const { id } = await params;
    const connection = await getProviderConnectionById(id);

    if (!connection) {
      return NextResponse.json({ error: "Connection not found" }, { status: 404 });
    }

    // Hide sensitive fields
    const result = { ...connection };
    delete result.apiKey;
    delete result.accessToken;
    delete result.refreshToken;
    delete result.idToken;

    return NextResponse.json({ connection: result });
  } catch (error) {
    console.log("Error fetching connection:", error);
    return NextResponse.json({ error: "Failed to fetch connection" }, { status: 500 });
  }
}

// PUT /api/providers/[id] - Update connection
export async function PUT(request, { params }) {
  try {
    const { id } = await params;
    const body = await request.json();
    const {
      name,
      priority,
      globalPriority,
      defaultModel,
      isActive,
      apiKey,
      testStatus,
      lastError,
      lastErrorAt,
      providerSpecificData
    } = body;

    const existing = await getProviderConnectionById(id);
    if (!existing) {
      return NextResponse.json({ error: "Connection not found" }, { status: 404 });
    }

    const proxyConfig = normalizeProxyConfig(body);
    if (proxyConfig.error) {
      return NextResponse.json({ error: proxyConfig.error }, { status: 400 });
    }

    const proxyPoolResult = await normalizeProxyPoolUpdate(body.proxyPoolId);
    if (proxyPoolResult.error) {
      return NextResponse.json({ error: proxyPoolResult.error }, { status: 400 });
    }

    const multiPoolResult = await normalizeMultiPoolUpdate(body);
    if (multiPoolResult.error) {
      return NextResponse.json({ error: multiPoolResult.error }, { status: 400 });
    }

    const updateData = {};
    if (name !== undefined) updateData.name = name;
    if (priority !== undefined) updateData.priority = priority;
    if (globalPriority !== undefined) updateData.globalPriority = globalPriority;
    if (defaultModel !== undefined) updateData.defaultModel = defaultModel;
    if (isActive !== undefined) updateData.isActive = isActive;
    if (apiKey && existing.authType === "apikey") updateData.apiKey = apiKey;
    if (testStatus !== undefined) updateData.testStatus = testStatus;
    if (lastError !== undefined) updateData.lastError = lastError;
    if (lastErrorAt !== undefined) updateData.lastErrorAt = lastErrorAt;

    if (
      shouldMergeProviderSpecificData(
        existing.providerSpecificData,
        providerSpecificData,
        proxyConfig.hasAnyProxyField,
        proxyPoolResult.hasProxyPoolField
      ) || multiPoolResult.hasField
    ) {
      updateData.providerSpecificData = {
        ...(existing.providerSpecificData || {}),
        ...(providerSpecificData || {}),
      };

      // A null marker means "the user turned this off manually" — remove the
      // monitor's autoQuotaDisabled flag so the background monitor cannot
      // re-enable the connection against the user's intent.
      if (updateData.providerSpecificData.autoQuotaDisabled === null) {
        delete updateData.providerSpecificData.autoQuotaDisabled;
      }

      if (proxyConfig.hasAnyProxyField) {
        updateData.providerSpecificData.connectionProxyEnabled = proxyConfig.connectionProxyEnabled;
        updateData.providerSpecificData.connectionProxyUrl = proxyConfig.connectionProxyUrl;
        updateData.providerSpecificData.connectionNoProxy = proxyConfig.connectionNoProxy;
      }

      if (proxyPoolResult.hasProxyPoolField) {
        // Choosing a single pool (or None) is an explicit mode switch away from
        // multi-pool rotation: clear the multi-pool assignment, otherwise the
        // resolver keeps prioritizing proxyPoolIds and the selection is ignored.
        if (updateData.providerSpecificData.proxyPoolIds) {
          delete updateData.providerSpecificData.proxyPoolIds;
        }
        if (updateData.providerSpecificData.proxyRotationStrategy) {
          delete updateData.providerSpecificData.proxyRotationStrategy;
        }
        if (proxyPoolResult.proxyPoolId === null) {
          delete updateData.providerSpecificData.proxyPoolId;
        } else {
          updateData.providerSpecificData.proxyPoolId = proxyPoolResult.proxyPoolId;
        }
      }

      if (multiPoolResult.hasField) {
        if (multiPoolResult.poolIds.length === 0) {
          delete updateData.providerSpecificData.proxyPoolIds;
          delete updateData.providerSpecificData.proxyRotationStrategy;
          delete updateData.providerSpecificData.proxyRequired;
        } else {
          updateData.providerSpecificData.proxyPoolIds = multiPoolResult.poolIds;
          if (multiPoolResult.strategy) {
            updateData.providerSpecificData.proxyRotationStrategy = multiPoolResult.strategy;
          }
          if (multiPoolResult.proxyRequired !== null) {
            updateData.providerSpecificData.proxyRequired = multiPoolResult.proxyRequired;
          }
        }
      }
    }

    const updated = await updateProviderConnection(id, updateData);

    // Hide sensitive fields
    const result = { ...updated };
    delete result.apiKey;
    delete result.accessToken;
    delete result.refreshToken;
    delete result.idToken;

    return NextResponse.json({ connection: result });
  } catch (error) {
    console.log("Error updating connection:", error);
    return NextResponse.json({ error: "Failed to update connection" }, { status: 500 });
  }
}

// DELETE /api/providers/[id] - Delete connection
export async function DELETE(request, { params }) {
  try {
    const { id } = await params;

    const deleted = await deleteProviderConnection(id);
    if (!deleted) {
      return NextResponse.json({ error: "Connection not found" }, { status: 404 });
    }

    return NextResponse.json({ message: "Connection deleted successfully" });
  } catch (error) {
    console.log("Error deleting connection:", error);
    return NextResponse.json({ error: "Failed to delete connection" }, { status: 500 });
  }
}
