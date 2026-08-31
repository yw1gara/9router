import { NextResponse } from "next/server";
import { getImapCredentialById, updateImapCredential } from "@/models";
import { testImapConnection } from "open-sse/services/outlookImap.js";

export const dynamic = "force-dynamic";

export async function POST(request, { params }) {
  try {
    const { id } = params;
    const cred = await getImapCredentialById(id);
    if (!cred) return NextResponse.json({ error: "Credential not found" }, { status: 404 });

    const now = new Date().toISOString();
    try {
      const result = await testImapConnection(cred);
      await updateImapCredential(id, { testStatus: "active", lastTested: now, lastError: null });
      return NextResponse.json(result);
    } catch (error) {
      const msg = String(error?.message || error).slice(0, 200);
      await updateImapCredential(id, { testStatus: "error", lastTested: now, lastError: msg });
      return NextResponse.json({ ok: false, error: msg }, { status: 200 });
    }
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
