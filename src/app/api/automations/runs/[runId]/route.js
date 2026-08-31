import { NextResponse } from "next/server";
import { getAutomationRun, getAutomationResults } from "@/lib/db/repos/automationsRepo";

// GET /api/automations/runs/[runId] -> { run, results }
export async function GET(request, { params }) {
  try {
    const { runId } = await params;
    const run = await getAutomationRun(runId);
    if (!run) {
      return NextResponse.json({ error: "Run not found" }, { status: 404 });
    }
    const results = await getAutomationResults(runId);
    return NextResponse.json({ run, results });
  } catch (e) {
    return NextResponse.json({ error: String(e?.message || e) }, { status: 500 });
  }
}