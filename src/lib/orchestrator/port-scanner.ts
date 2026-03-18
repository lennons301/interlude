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
    await new Promise<void>((resolve) => {
      stream.on("data", (chunk: Buffer) => chunks.push(chunk));
      stream.on("end", resolve);
      setTimeout(resolve, 5000);
    });
    const output = Buffer.concat(chunks).toString();
    return parseListeningPorts(output);
  } catch {
    return [];
  }
}
