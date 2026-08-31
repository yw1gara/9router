import { NextResponse } from "next/server";
import {
  getImapCredentials, createImapCredential, updateImapCredential, deleteImapCredential,
} from "@/models";
import { parseCredentialLine } from "open-sse/services/outlookImap.js";

export const dynamic = "force-dynamic";

function mask(cred) {
  const rt = cred.refreshToken || "";
  return {
    id: cred.id,
    email: cred.email,
    clientId: cred.clientId,
    refreshTokenMasked: rt ? `${rt.slice(0, 4)}…${rt.slice(-4)} (${rt.length} chars)` : "",
    provider: cred.provider,
    testStatus: cred.testStatus,
    lastTested: cred.lastTested,
    lastError: cred.lastError,
    createdAt: cred.createdAt,
    updatedAt: cred.updatedAt,
  };
}

export async function GET() {
  try {
    const creds = await getImapCredentials();
    return NextResponse.json({ credentials: creds.map(mask) });
  } catch (error) {
    return NextResponse.json({ error: "Failed to list IMAP credentials" }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    const body = await request.json();
    // Accept the paste-format line (password slot is parsed away and discarded)
    // or explicit fields.
    let parsed;
    if (typeof body?.line === "string" && body.line.trim()) {
      parsed = parseCredentialLine(body.line);
    } else {
      parsed = parseCredentialLine(
        [body?.email ?? "", "x", body?.clientId ?? "", body?.refreshToken ?? ""].join("----")
      );
    }
    if (parsed.error) return NextResponse.json({ error: parsed.error }, { status: 400 });

    const cred = await createImapCredential(parsed);
    return NextResponse.json({ credential: mask(cred) });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function PUT(request) {
  try {
    const body = await request.json();
    if (!body?.id) return NextResponse.json({ error: "id is required" }, { status: 400 });
    const patch = {};
    if (typeof body.email === "string" && body.email.trim()) patch.email = body.email.trim();
    if (typeof body.clientId === "string" && body.clientId.trim()) patch.clientId = body.clientId.trim();
    if (typeof body.refreshToken === "string" && body.refreshToken.trim()) patch.refreshToken = body.refreshToken.trim();
    const cred = await updateImapCredential(body.id, patch);
    if (!cred) return NextResponse.json({ error: "Credential not found" }, { status: 404 });
    return NextResponse.json({ credential: mask(cred) });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function DELETE(request) {
  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get("id");
    if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });
    await deleteImapCredential(id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
