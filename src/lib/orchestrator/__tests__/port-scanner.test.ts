import { describe, it, expect } from "vitest";
import { parseListeningPorts } from "../port-scanner";

describe("parseListeningPorts", () => {
  it("parses ss output with listening ports", () => {
    const output = [
      "State  Recv-Q Send-Q Local Address:Port Peer Address:Port Process",
      "LISTEN 0      511          0.0.0.0:3000      0.0.0.0:*    users:((\"node\",pid=123,fd=20))",
      "LISTEN 0      511             [::]:3000         [::]:*    users:((\"node\",pid=123,fd=21))",
    ].join("\n");

    const ports = parseListeningPorts(output);
    expect(ports).toEqual([3000]);
  });

  it("returns empty array for no listeners", () => {
    const output = "State  Recv-Q Send-Q Local Address:Port Peer Address:Port Process\n";
    expect(parseListeningPorts(output)).toEqual([]);
  });

  it("deduplicates IPv4 and IPv6 listeners on same port", () => {
    const output = [
      "State  Recv-Q Send-Q Local Address:Port Peer Address:Port Process",
      "LISTEN 0      511          0.0.0.0:5173      0.0.0.0:*",
      "LISTEN 0      511             [::]:5173         [::]:*",
      "LISTEN 0      511          0.0.0.0:24678      0.0.0.0:*",
    ].join("\n");

    const ports = parseListeningPorts(output);
    expect(ports).toEqual([5173, 24678]);
  });

  it("prioritises common dev server ports", () => {
    const output = [
      "State  Recv-Q Send-Q Local Address:Port Peer Address:Port Process",
      "LISTEN 0      511          0.0.0.0:24678      0.0.0.0:*",
      "LISTEN 0      511          0.0.0.0:3000       0.0.0.0:*",
    ].join("\n");

    const ports = parseListeningPorts(output);
    expect(ports[0]).toBe(3000);
  });
});
