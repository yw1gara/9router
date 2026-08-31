import { NextResponse } from "next/server";
import { poolFitnessSnapshot } from "open-sse/services/proxyPoolFitness.js";
import { poolGeoSnapshot } from "open-sse/services/poolGeo.js";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const fitness = await poolFitnessSnapshot();
    const geo = poolGeoSnapshot();
    return NextResponse.json({ fitness, geo });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
