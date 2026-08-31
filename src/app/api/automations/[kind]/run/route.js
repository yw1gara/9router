import { NextResponse } from "next/server";
import { getAutomationKind } from "@/shared/constants/automations";
import { startRun, isRunning, activeRunId } from "@/lib/automations/runner";

// POST /api/automations/[kind]/run
// body: { accounts: [{ email, password }], autoImport?, threads? (1-10), proxies? string[], limit?, delay? }
// The form input is the source of truth — nothing is persisted.
export async function POST(request, { params }) {
  try {
    const { kind } = await params;
    if (!getAutomationKind(kind)) {
      return NextResponse.json({ error: "Unknown automation kind" }, { status: 404 });
    }
    if (isRunning(kind)) {
      return NextResponse.json(
        { error: "Already running", runId: activeRunId(kind) },
        { status: 409 }
      );
    }

    const body = await request.json().catch(() => ({}));
    const accounts = (Array.isArray(body.accounts) ? body.accounts : [])
      .map((a) => ({
        email: String(a?.email || "").trim(),
        password: String(a?.password || ""),
      }))
      .filter((a) => a.email.includes("@") && a.password);

    const threads = Number.isFinite(Number(body.threads))
      ? Math.min(10, Math.max(1, Number(body.threads)))
      : 1;

    const proxies = Array.isArray(body.proxies)
      ? body.proxies.map((p) => String(p).trim()).filter(Boolean)
      : [];

    const res = await startRun(kind, accounts, {
      limit: Number(body.limit) || 0,
      delay: Number.isFinite(Number(body.delay)) ? Number(body.delay) : 3,
      autoImport: body.autoImport !== false,
      threads,
      proxies,
    });
    if (res.error) {
      return NextResponse.json({ error: res.error }, { status: 400 });
    }
    return NextResponse.json({ runId: res.runId, threads: res.threads }, { status: 202 });
  } catch (e) {
    return NextResponse.json({ error: String(e?.message || e) }, { status: 500 });
  }
}