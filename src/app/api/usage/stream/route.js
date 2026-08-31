import { statsEmitter, getActiveRequests } from "@/lib/usageDb";

export const dynamic = "force-dynamic";

export async function GET() {
  const encoder = new TextEncoder();
  const state = { closed: false, keepalive: null, send: null };

  const stream = new ReadableStream({
    async start(controller) {
      // Lightweight push only: the dashboard client merges just the real-time
      // fields (activeRequests/activeApiKeys/recentRequests/errorProvider/pending)
      // on top of the period stats it fetched over REST — recomputing the full
      // period aggregation here (previously getUsageStats() on every event)
      // burned CPU on every completed request for data nobody read.
      state.send = async () => {
        if (state.closed) return;
        try {
          const light = await getActiveRequests();
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(light)}\n\n`));
        } catch {
          state.closed = true;
          statsEmitter.off("update", state.send);
          statsEmitter.off("pending", state.send);
          clearInterval(state.keepalive);
        }
      };

      await state.send();

      statsEmitter.on("update", state.send);
      statsEmitter.on("pending", state.send);

      state.keepalive = setInterval(() => {
        if (state.closed) { clearInterval(state.keepalive); return; }
        try {
          controller.enqueue(encoder.encode(": ping\n\n"));
        } catch {
          state.closed = true;
          clearInterval(state.keepalive);
        }
      }, 25000);
    },

    cancel() {
      state.closed = true;
      statsEmitter.off("update", state.send);
      statsEmitter.off("pending", state.send);
      clearInterval(state.keepalive);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
