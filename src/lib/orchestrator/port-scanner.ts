import type { RunningContainer } from "../docker/container-manager";

/**
 * Dev-server detection for the live preview (Phase 2c; hardened in issue #160).
 *
 * The preview proxy (`custom-server.js`) dials `http://<container alias>:<port>`
 * over the `interlude` Docker network. A port is a dev server for the pane's
 * purposes only if it speaks HTTP on an address that network can reach — and
 * the scanner used to assert neither. It admitted every `LISTEN` row `ss`
 * printed, so an ephemeral socket the CLI/plugin stack opens (36159, 44195 in
 * the #160 sessions) was published as a dev server and the pane hit a socket
 * that does not speak HTTP; and it kept sockets bound to `127.0.0.1`, which
 * `ss` lists but the proxy can never reach — Vite's default bind, so exactly
 * the greenfield "build me an app" case detected a port that could never serve.
 *
 * Three gates now stand between a listening socket and `devPort`:
 *   1. the bind address must be routable from the network (not loopback);
 *   2. the port must be plausible for a dev server — never the ephemeral range;
 *   3. the port must answer an HTTP request made inside the container against
 *      the container's own address, in the order the candidates are ranked.
 * The first two are pure and tested on `ss` output; the third is the actual
 * contract, asserted rather than inferred.
 */

/** Ports the common dev servers default to — probed first when several
 * candidates are listening: Next/CRA (3000/3001), Vite preview (4173), Angular
 * (4200), Astro (4321), Flask/serve (5000), Vite (5173), Django/http.server
 * (8000), the 8080 convention, and Jupyter (8888). */
export const DEV_PORTS = new Set([
  3000, 3001, 4173, 4200, 4321, 5000, 5173, 8000, 8080, 8888,
]);

/** Linux's default ephemeral range starts here (`ip_local_port_range` is
 * 32768–60999); a container inherits it. A socket bound in it was assigned by
 * the kernel, not chosen by a dev server, and is never a preview target. */
export const EPHEMERAL_PORT_FLOOR = 32768;

/** Below this are privileged ports; a dev server run as the container's
 * unprivileged `node` user cannot bind one. */
const PRIVILEGED_PORT_CEILING = 1024;

export interface ListeningSocket {
  /** The bind address as `ss` prints it, brackets stripped: `0.0.0.0`, `::`,
   * `*`, `127.0.0.1`, `::1`, or a concrete interface address. */
  address: string;
  port: number;
}

/**
 * The `LISTEN` rows of `ss -tlnp`, one socket per row. The local address is the
 * fourth whitespace-separated column (`State Recv-Q Send-Q Local:Port
 * Peer:Port [Process]`); its port is what follows the last colon, so an IPv6
 * literal's own colons never confuse it. Rows are read with `\r` tolerated,
 * because the exec runs on a TTY.
 */
export function parseListeningSockets(output: string): ListeningSocket[] {
  const sockets: ListeningSocket[] = [];
  for (const line of output.split("\n")) {
    if (!line.includes("LISTEN")) continue;
    const cols = line.trim().split(/\s+/);
    // The header row and any truncated row have no local-address column.
    const local = cols[3];
    if (!local) continue;
    const colon = local.lastIndexOf(":");
    if (colon === -1) continue;
    const port = parseInt(local.slice(colon + 1), 10);
    if (!Number.isInteger(port) || port <= 0 || port >= 65536) continue;
    // `[::]`, `[::1]`, `[fe80::1%eth0]` — the bracketed IPv6 forms.
    const address = local.slice(0, colon).replace(/^\[|\]$/g, "");
    sockets.push({ address, port });
  }
  return sockets;
}

/**
 * Whether a socket bound to this address is reachable from another host on the
 * Docker network. Loopback (`127.0.0.0/8`, `::1`) is not; `0.0.0.0`, `::`, `*`
 * (unspecified — all interfaces) and a concrete interface address are.
 */
export function isRoutableAddress(address: string): boolean {
  if (address === "" || address === "*") return true;
  if (address.startsWith("127.")) return false;
  // `::1`, and the IPv4-mapped form some stacks print for loopback.
  const bare = address.split("%")[0];
  if (bare === "::1" || bare === "::ffff:127.0.0.1") return false;
  return true;
}

/** Whether a dev server could plausibly have chosen this port: unprivileged
 * and below the kernel's ephemeral range. */
export function isPlausibleDevPort(port: number): boolean {
  return port >= PRIVILEGED_PORT_CEILING && port < EPHEMERAL_PORT_FLOOR;
}

/**
 * The ports worth probing, from raw `ss` output: routable, plausible,
 * deduplicated across the IPv4 and IPv6 listeners a dual-stack server opens,
 * and ranked — conventional dev ports first, then ascending — so the probe
 * tries the likeliest first and a Vite HMR side-port (24678) never outranks
 * the 5173 it belongs to.
 */
export function parseListeningPorts(output: string): number[] {
  const ports = new Set<number>();
  for (const { address, port } of parseListeningSockets(output)) {
    if (!isRoutableAddress(address)) continue;
    if (!isPlausibleDevPort(port)) continue;
    ports.add(port);
  }
  return [...ports].sort((a, b) => {
    const aIsCommon = DEV_PORTS.has(a) ? 0 : 1;
    const bIsCommon = DEV_PORTS.has(b) ? 0 : 1;
    if (aIsCommon !== bIsCommon) return aIsCommon - bIsCommon;
    return a - b;
  });
}

/**
 * Which of the probe script's outputs names a confirmed port. The script
 * prints exactly one line — the first candidate that answered HTTP — or
 * nothing; anything else on a TTY stream (a `\r`, a stray warning) is not a
 * port. Pure, so the contract with the script is pinned by a test.
 */
export function parseProbedPort(output: string, candidates: readonly number[]): number | null {
  for (const line of output.split("\n")) {
    const port = parseInt(line.trim(), 10);
    if (Number.isInteger(port) && candidates.includes(port)) return port;
  }
  return null;
}

/** At most this many candidates are probed per scan: each unanswered probe
 * waits up to `PROBE_TIMEOUT_S`, and a container with more routable listeners
 * than this is not running a dev server the pane could pick anyway. */
const MAX_PROBED_CANDIDATES = 6;
const PROBE_TIMEOUT_S = 2;

/** A scan that the daemon does not answer is a scan that found nothing. */
const EXEC_TIMEOUT_MS = 10_000;

/**
 * The in-container HTTP probe. Requests are made against the container's own
 * network address — the same address the proxy reaches it by — so a server
 * that only answers on loopback fails here even if the parser let it through.
 * Any HTTP status is a pass: a 404 or 500 is still a server that speaks HTTP;
 * curl prints `000` for a connection refused or a socket that never answers in
 * HTTP. Candidates arrive in the environment, not on the command line, so
 * nothing here is shell syntax. Falls back to loopback only when the address
 * cannot be read at all, and loopback-only binds were already dropped upstream.
 */
const PROBE_SCRIPT = [
  "addr=$(ip -4 -o addr show scope global 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | head -n1)",
  '[ -n "$addr" ] || addr=$(hostname -i 2>/dev/null | awk \'{print $1}\')',
  '[ -n "$addr" ] || addr=127.0.0.1',
  "for p in $INTERLUDE_PORTS; do",
  `  code=$(curl -s -o /dev/null -m ${PROBE_TIMEOUT_S} -w '%{http_code}' "http://$addr:$p/" 2>/dev/null)`,
  '  case "$code" in [1-5][0-9][0-9]) echo "$p"; exit 0;; esac',
  "done",
  "exit 1",
].join("\n");

async function execCapture(
  running: RunningContainer,
  cmd: string[],
  env: string[] = []
): Promise<string> {
  const exec = await running.container.exec({
    Cmd: cmd,
    Env: env,
    AttachStdout: true,
    AttachStderr: true,
    Tty: true,
  });
  const stream = await exec.start({});
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve) => {
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.on("end", resolve);
    stream.on("close", resolve);
    stream.on("error", () => resolve());
    setTimeout(resolve, EXEC_TIMEOUT_MS);
  });
  return Buffer.concat(chunks).toString();
}

/** The routable, plausible listeners in the container, ranked. Exposed apart
 * from the probe so a caller that only wants to know whether *anything* is
 * listening can ask without paying for a curl per candidate. */
export async function listCandidatePorts(running: RunningContainer): Promise<number[]> {
  try {
    return parseListeningPorts(await execCapture(running, ["ss", "-tlnp"]));
  } catch {
    return [];
  }
}

/** The first candidate, in rank order, that answers HTTP on the container's
 * own address — or null when none does. */
export async function probeHttpPort(
  running: RunningContainer,
  candidates: readonly number[]
): Promise<number | null> {
  const probed = candidates.slice(0, MAX_PROBED_CANDIDATES);
  if (probed.length === 0) return null;
  try {
    const output = await execCapture(running, ["bash", "-c", PROBE_SCRIPT], [
      `INTERLUDE_PORTS=${probed.join(" ")}`,
    ]);
    return parseProbedPort(output, probed);
  } catch {
    return null;
  }
}

/**
 * The dev-server ports the preview may be pointed at: at most one, the
 * highest-ranked listener that proved it speaks HTTP on a routable address.
 * Returned as a list so the turn manager's existing `ports[0]` reading, and the
 * suites that stub this module, are unchanged.
 */
export async function scanPorts(running: RunningContainer): Promise<number[]> {
  const candidates = await listCandidatePorts(running);
  const confirmed = await probeHttpPort(running, candidates);
  return confirmed === null ? [] : [confirmed];
}
