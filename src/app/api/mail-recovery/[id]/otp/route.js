import { NextResponse } from "next/server";
import { getImapCredentialById } from "@/models";
import { fetchLatestOpenAiOtp } from "open-sse/services/outlookImap.js";

export const dynamic = "force-dynamic";

export async function POST(request, { params }) {
  try {
    const { id } = params;
    const cred = await getImapCredentialById(id);
    if (!cred) return NextResponse.json({ error: "Credential not found" }, { status: 404 });

    const body = await request.json().catch(() => ({}));
    const sinceMs = Number.isFinite(body?.sinceMs) ? body.sinceMs : null;

    const otp = await fetchLatestOpenAiOtp(cred, sinceMs);
    return NextResponse.json({ otp });
  } catch (error) {
    const msg = String(error?.message || error).slice(0, 200);
    return NextResponse.json({ otp: null, error: msg }, { status: 200 });
  }
}
