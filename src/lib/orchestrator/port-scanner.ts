import type { RunningContainer } from "../docker/container-manager";

const DEV_PORTS = new Set([3000, 3001, 4173, 5173, 8000, 8080]);

export function parseListeningPorts(output: string): number[] {
  const ports = new Set<number>();
  for (const line of output.split("\n")) {
    if (!line.includes("LISTEN")) continue;
    const match = line.match(/:(\d+)\s/);
    if (match) {
      const port = parseInt(match[1], 10);
      if (port > 0 && port < 65536) ports.add(port);
    }
  }
  return [...ports].sort((a, b) => {
    const aIsCommon = DEV_PORTS.has(a) ? 0 : 1;
    const bIsCommon = DEV_PORTS.has(b) ? 0 : 1;
    if (aIsCommon !== bIsCommon) return aIsCommon - bIsCommon;
    return a - b;
  });
}

export async function scanPorts(running: RunningContainer): Promise<number[]> {
  try {
    const exec = await running.container.exec({
      Cmd: ["ss", "-tlnp"],
      AttachStdout: true,
      AttachStderr: true,
      Tty: true,
    });
    const stream = await exec.start({});
    const chunks: Buffer[] = [];
    let timedOut = false;
    await new Promise<void>((resolve) => {
      stream.on("data", (chunk: Buffer) => chunks.push(chunk));
      stream.on("end", () => {
        console.log(`[exec-diag] scanPorts stream ended normally`);
        resolve();
      });
      setTimeout(() => {
        timedOut = true;
        console.log(`[exec-diag] scanPorts timed out after 5s`);
        resolve();
      }, 5000);
    });
    const output = Buffer.concat(chunks).toString();
    const ports = parseListeningPorts(output);
    console.log(`[exec-diag] scanPorts result: timedOut=${timedOut}, output=${output.length}bytes, ports=[${ports}]`);
    return ports;
  } catch (err) {
    console.log(`[exec-diag] scanPorts error: ${err}`);
    return [];
  }
}
