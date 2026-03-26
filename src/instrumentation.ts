export async function register() {
  // Only init on the Node.js server, not during build or edge runtime
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { initOrchestrator } = await import("@/lib/orchestrator/init");
    await initOrchestrator();
  }
}
