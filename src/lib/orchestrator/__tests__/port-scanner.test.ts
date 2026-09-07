import { describe, it, expect } from "vitest";
import {
  EPHEMERAL_PORT_FLOOR,
  isPlausibleDevPort,
  isRoutableAddress,
  parseListeningPorts,
  parseListeningSockets,
  parseProbedPort,
} from "../port-scanner";

/**
 * The scanner's two pure gates (issue #160, defect 2) on real `ss -tlnp`
 * shapes: which listening sockets are even candidates for the preview, and in
 * what order the probe should try them. The third gate — the in-container HTTP
 * probe — is exec; its output contract is pinned by `parseProbedPort`.
 */

const HEADER = "State  Recv-Q Send-Q Local Address:Port Peer Address:Port Process";

function ss(...rows: string[]): string {
  return [HEADER, ...rows].join("\n");
}

describe("parseListeningSockets", () => {
  it("reads the local address and port off each LISTEN row, IPv4 and bracketed IPv6 alike", () => {
    const sockets = parseListeningSockets(
      ss(
        'LISTEN 0      511          0.0.0.0:3000      0.0.0.0:*    users:(("node",pid=123,fd=20))',
        'LISTEN 0      511             [::]:3000         [::]:*    users:(("node",pid=123,fd=21))',
        "LISTEN 0      128        127.0.0.1:5173      0.0.0.0:*",
        "LISTEN 0      128            [::1]:5173         [::]:*",
        "LISTEN 0      4096               *:8080            *:*",
        "LISTEN 0      511       172.19.0.4:4321      0.0.0.0:*"
      )
    );
    expect(sockets).toEqual([
      { address: "0.0.0.0", port: 3000 },
      { address: "::", port: 3000 },
      { address: "127.0.0.1", port: 5173 },
      { address: "::1", port: 5173 },
      { address: "*", port: 8080 },
      { address: "172.19.0.4", port: 4321 },
    ]);
  });

  it("tolerates the TTY's carriage returns and ignores the header and non-LISTEN rows", () => {
    const output =
      HEADER + "\r\n" + "LISTEN 0 511 0.0.0.0:3000 0.0.0.0:*\r\n" + "ESTAB 0 0 172.19.0.4:41234 1.2.3.4:443\r\n";
    expect(parseListeningSockets(output)).toEqual([{ address: "0.0.0.0", port: 3000 }]);
  });

  it("returns nothing for output with no listeners", () => {
    expect(parseListeningSockets(HEADER + "\n")).toEqual([]);
  });
});

describe("isRoutableAddress — reachable from the Docker network", () => {
  it.each(["0.0.0.0", "::", "*", "", "172.19.0.4", "fe80::1%eth0"])("admits %s", (address) => {
    expect(isRoutableAddress(address)).toBe(true);
  });

  it.each(["127.0.0.1", "127.1.2.3", "::1", "::ffff:127.0.0.1"])("refuses loopback %s", (address) => {
    expect(isRoutableAddress(address)).toBe(false);
  });
});

describe("isPlausibleDevPort — chosen by a dev server, not assigned by the kernel", () => {
  it.each([1024, 3000, 5173, 8080, 24678, EPHEMERAL_PORT_FLOOR - 1])("admits %i", (port) => {
    expect(isPlausibleDevPort(port)).toBe(true);
  });

  it.each([80, 443, 1023, EPHEMERAL_PORT_FLOOR, 36159, 44195, 60999, 65535])(
    "refuses %i",
    (port) => {
      expect(isPlausibleDevPort(port)).toBe(false);
    }
  );
});

describe("parseListeningPorts — the ranked candidates", () => {
  it("parses ss output with listening ports", () => {
    const output = ss(
      'LISTEN 0      511          0.0.0.0:3000      0.0.0.0:*    users:(("node",pid=123,fd=20))',
      'LISTEN 0      511             [::]:3000         [::]:*    users:(("node",pid=123,fd=21))'
    );
    expect(parseListeningPorts(output)).toEqual([3000]);
  });

  it("returns empty array for no listeners", () => {
    expect(parseListeningPorts(HEADER + "\n")).toEqual([]);
  });

  it("deduplicates IPv4 and IPv6 listeners on same port", () => {
    const output = ss(
      "LISTEN 0      511          0.0.0.0:5173      0.0.0.0:*",
      "LISTEN 0      511             [::]:5173         [::]:*",
      "LISTEN 0      511          0.0.0.0:24678      0.0.0.0:*"
    );
    expect(parseListeningPorts(output)).toEqual([5173, 24678]);
  });

  it("prioritises common dev server ports", () => {
    const output = ss(
      "LISTEN 0      511          0.0.0.0:24678      0.0.0.0:*",
      "LISTEN 0      511          0.0.0.0:3000       0.0.0.0:*"
    );
    expect(parseListeningPorts(output)[0]).toBe(3000);
  });

  // The `hi` session of issue #160: nothing real listening, one ephemeral
  // socket from the CLI/plugin stack — and the pane was pointed at it.
  it("refuses an ephemeral-range socket, so an idle container yields no dev server", () => {
    const output = ss('LISTEN 0      4096       0.0.0.0:36159      0.0.0.0:*    users:(("node",pid=7,fd=19))');
    expect(parseListeningPorts(output)).toEqual([]);
  });

  // Vite's default bind: `ss` lists it, the proxy can never reach it.
  it("refuses a server bound to loopback only, so a localhost-only Vite is not a preview", () => {
    const output = ss(
      "LISTEN 0      511        127.0.0.1:5173      0.0.0.0:*",
      "LISTEN 0      511            [::1]:5173         [::]:*"
    );
    expect(parseListeningPorts(output)).toEqual([]);
  });

  it("admits the same server once it binds all interfaces", () => {
    const output = ss("LISTEN 0      511          0.0.0.0:5173      0.0.0.0:*");
    expect(parseListeningPorts(output)).toEqual([5173]);
  });

  it("admits a server bound to the container's own interface address", () => {
    const output = ss("LISTEN 0      511       172.19.0.4:3000      0.0.0.0:*");
    expect(parseListeningPorts(output)).toEqual([3000]);
  });

  it("ranks a conventional port ahead of an unconventional one whatever their order, then ascending", () => {
    const output = ss(
      "LISTEN 0      511          0.0.0.0:9229      0.0.0.0:*",
      "LISTEN 0      511          0.0.0.0:8080      0.0.0.0:*",
      "LISTEN 0      511          0.0.0.0:1313      0.0.0.0:*",
      "LISTEN 0      511          0.0.0.0:3000      0.0.0.0:*"
    );
    expect(parseListeningPorts(output)).toEqual([3000, 8080, 1313, 9229]);
  });
});

describe("parseProbedPort — the probe script's one line of output", () => {
  it("returns the port the script printed, ignoring TTY noise around it", () => {
    expect(parseProbedPort("\r\n3000\r\n", [3000, 8080])).toBe(3000);
  });

  it("returns null when the script printed nothing (no candidate answered HTTP)", () => {
    expect(parseProbedPort("", [3000])).toBeNull();
    expect(parseProbedPort("\r\n", [3000])).toBeNull();
  });

  it("refuses a number that was not among the candidates it was asked to probe", () => {
    expect(parseProbedPort("curl: (6) Could not resolve host\n22\n", [3000])).toBeNull();
  });
});
