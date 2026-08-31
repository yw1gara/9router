import { NextResponse } from "next/server";
import { getSettings, updateSettings } from "@/lib/localDb";
import { getFreebuffSettings, setFreebuffSettings } from "open-sse/executors/freebuff.js";

// Load persisted freebuff settings into the executor module on first access.
let hydrated = false;
async function hydrate() {
  if (hydrated) return;
  hydrated = true;
  try {
    const stored = (await getSettings())?.freebuff;
    if (stored && typeof stored === "object") setFreebuffSettings(stored);
  } catch {
    // settings table unavailable — executor defaults stay in effect
  }
}

export async function GET() {
  await hydrate();
  return NextResponse.json(getFreebuffSettings());
}

export async function POST(request) {
  await hydrate();
  const body = await request.json().catch(() => ({}));
  const next = setFreebuffSettings(body);
  await updateSettings({ freebuff: next });
  return NextResponse.json(next);
}
