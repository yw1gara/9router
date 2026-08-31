import { NextResponse } from "next/server";
import { pingModelByKind } from "./ping";

// POST /api/models/test - Ping a single model via internal completions or embeddings.
// Optional `connectionId` pins the test to ONE specific account (used by the
// per-account "test all accounts" loop in the dashboard).
export async function POST(request) {
  try {
    const { model, kind, connectionId } = await request.json();
    if (!model) return NextResponse.json({ error: "Model required" }, { status: 400 });
    const result = await pingModelByKind(model, kind || "llm", undefined, connectionId || null);
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}
