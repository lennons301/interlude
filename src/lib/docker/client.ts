import Docker from "dockerode";

let _docker: Docker | null = null;

export function getDocker(): Docker {
  if (!_docker) {
    _docker = new Docker({ socketPath: "/var/run/docker.sock" });
  }
  return _docker;
}

export async function isDockerAvailable(): Promise<boolean> {
  try {
    await getDocker().ping();
    return true;
  } catch {
    return false;
  }
}
