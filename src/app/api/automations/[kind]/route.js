import { NextResponse } from "next/server";
import { getSettings, updateSettings } from "@/lib/localDb";
import { getAutomationKind } from "@/shared/constants/automations";

// GET /api/automations/[kind] -> { accountsText, updatedAt }
export async function GET(request, { params }) {
  try {
    const { kind } = await params;
    if (!getAutomationKind(kind)) {
      return NextResponse.json({ error: "Unknown automation kind" }, { status: 404 });
    }
    const stored = (await getSettings())?.automations?.[kind] || {};
    return NextResponse.json({
      accountsText: stored.accountsText || "",
      updatedAt: stored.updatedAt || null,
    });
  } catch {
    return NextResponse.json({ accountsText: "", updatedAt: null });
  }
}

// POST /api/automations/[kind]  body: { accountsText } -> persists the list
export async function POST(request, { params }) {
  try {
    const { kind } = await params;
    if (!getAutomationKind(kind)) {
      return NextResponse.json({ error: "Unknown automation kind" }, { status: 404 });
    }
    const body = await request.json().catch(() => ({}));
    const accountsText = typeof body.accountsText === "string" ? body.accountsText : "";
    const entry = { accountsText, updatedAt: new Date().toISOString() };

    const settings = (await getSettings()) || {};
    const automations = { ...(settings.automations || {}), [kind]: entry };
    await updateSettings({ automations });

    return NextResponse.json(entry);
  } catch (e) {
    return NextResponse.json({ error: String(e?.message || e) }, { status: 500 });
  }
}
