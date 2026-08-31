import { NextResponse } from "next/server";
import { getAutomationKind } from "@/shared/constants/automations";
import { getAutomationRunsByKind } from "@/lib/db/repos/automationsRepo";
import { isRunning, activeRunId } from "@/lib/automations/runner";

// GET /api/automations/[kind]/runs -> { runs: [...], running: runId|null }
export async function GET(request, { params }) {
  try {
    const { kind } = await params;
    if (!getAutomationKind(kind)) {
      return NextResponse.json({ error: "Unknown automation kind" }, { status: 404 });
    }
    const runs = await getAutomationRunsByKind(kind, 20);
    return NextResponse.json({
      running: isRunning(kind) ? activeRunId(kind) : null,
      runs,
    });
  } catch (e) {
    return NextResponse.json({ error: String(e?.message || e), runs: [] }, { status: 500 });
  }
}