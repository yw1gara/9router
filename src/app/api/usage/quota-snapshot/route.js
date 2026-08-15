import { NextResponse } from "next/server";
import { getProviderConnections } from "@/lib/localDb";
import { getQuotaMonitorSnapshot } from "@/sse/services/quotaMonitor";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const [snapshot, connections] = await Promise.all([
      Promise.resolve(getQuotaMonitorSnapshot()),
      getProviderConnections({}),
    ]);
    const connectionMap = new Map(connections.map((connection) => [connection.id, connection]));

    const items = snapshot.map((entry) => {
      const connection = connectionMap.get(entry.connectionId);
      return {
        ...entry,
        name: connection?.name || connection?.email || connection?.displayName || `Account ${entry.connectionId.slice(0, 8)}`,
        isActive: connection?.isActive !== false,
        authType: connection?.authType || null,
      };
    });

    return NextResponse.json({
      generatedAt: new Date().toISOString(),
      items,
      summary: {
        tracked: items.length,
        active: items.filter((item) => item.isActive).length,
        depleted: items.filter((item) => item.depleted).length,
        failed: items.filter((item) => item.failures > 0).length,
        checked: items.filter((item) => item.checkedAt).length,
      },
    });
  } catch (error) {
    console.error("[API] Failed to get quota monitor snapshot:", error);
    return NextResponse.json({ error: "Failed to fetch quota monitor snapshot" }, { status: 500 });
  }
}
