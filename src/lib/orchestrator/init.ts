import { isDockerAvailable } from "../docker/client";
import { startQueue } from "./queue";

let initialized = false;

export async function initOrchestrator(): Promise<void> {
  if (initialized) return;
  initialized = true;

  const dockerAvailable = await isDockerAvailable();
  if (dockerAvailable) {
    console.log("[orchestrator] Docker available, starting task queue");
    startQueue();
  } else {
    console.log(
      "[orchestrator] Docker not available, running in UI-only mode (mock agent still works)"
    );
  }
}
