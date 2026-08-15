export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { initConsoleLogCapture } = await import("@/lib/consoleLogBuffer");
    initConsoleLogCapture();
    const { startCodexQuotaGuard } = await import("@/sse/services/codexQuotaGuard.js");
    startCodexQuotaGuard();
    const { startQuotaMonitor } = await import("@/sse/services/quotaMonitor.js");
    startQuotaMonitor();
  }
}
