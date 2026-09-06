import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { HARNESS_ADAPTER_DESCRIPTORS } from "@/lib/harness/descriptors";

/**
 * Nothing outside a harness adapter knows a vendor's name (issue #226).
 *
 * The harness adapter seam (`src/lib/harness/`) is the one vendor boundary:
 * the fleet describes itself in lanes and harnesses, and everything specific
 * to one harness — its command, its stream, its credential variable, its
 * transcript path, its refusal signals — lives under that adapter's directory.
 * Issues #214–#223 moved the code there; this test is what stops the coupling
 * quietly returning through a comment, an example, a default or an error
 * message that names one vendor as if it were the fleet.
 *
 * Where a vendor name is *allowed*, and why each place is on the list:
 *
 * - **An adapter's own directory** (`src/lib/harness/<adapter id>/`, for a
 *   **registered** id — read off the descriptor table, so an unregistered
 *   directory under the seam is scanned like any other source): the adapter is
 *   the vendor, by construction.
 * - **The registration points** (`registry.ts`, `descriptors.ts`): each row is
 *   one adapter's id, and both tables must name every adapter that exists —
 *   `descriptors.test.ts` pins the two to each other.
 * - **Tests** (`__tests__/`, `*.test.*`, `src/test/`): a test may drive the
 *   real adapter, read a recorded vendor stream, or set a lane's credential
 *   variable by name.
 * - **The lane file** (`lanes.yaml`): a lane names its adapter, its provider's
 *   endpoint and the variables its harness reads — vendor facts as
 *   configuration, which is the point of the file.
 * - **`CLAUDE.md`**: the estate's tool-specific include of `AGENTS.md`, not a
 *   coupling. It falls outside the scan with the rest of the documentation,
 *   which is not scanned at all: docs may use one adapter as a worked example.
 *
 * Outside those, a vendor name in source is a coupling — even in a comment,
 * because a comment that says "the CLI" or "Claude" is how the next reader
 * learns the wrong shape. Say "the harness", "the adapter", "a first-party
 * lane". `scripts/` is not scanned either: the operational one-offs there
 * (the rate-limit stub, the endpoint check, the Responses stub the Codex
 * fixtures are recorded against) exercise one provider's wire by design and
 * are not part of the fleet.
 */

const VENDOR_NAMES = /claude|anthropic|codex|openai|opencode/i;

/** Source the fleet runs: the app tree and the root-level entry points. */
const SOURCE_ROOTS = [
  "src",
  "custom-server.js",
  "next.config.ts",
  "drizzle.config.ts",
  "vitest.config.ts",
  "eslint.config.mjs",
  "postcss.config.mjs",
];

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);

/** The registration points: the one table of adapter ids the pure lane parser
 * checks against, and the one table of adapter instances the turn manager
 * reads. Both must name every adapter, so both may name a vendor. */
const REGISTRATION_POINTS = new Set([
  "src/lib/harness/registry.ts",
  "src/lib/harness/descriptors.ts",
]);

const REGISTERED_ADAPTER_IDS = new Set<string>(
  HARNESS_ADAPTER_DESCRIPTORS.map((descriptor) => descriptor.id)
);

function isAdapterDirectory(rel: string): boolean {
  // `src/lib/harness/<registered adapter id>/...` and nothing else under the
  // seam: the contract files beside it are the fleet's.
  const match = /^src\/lib\/harness\/([^/]+)\//.exec(rel);
  return match !== null && REGISTERED_ADAPTER_IDS.has(match[1]);
}

function isTest(rel: string): boolean {
  return (
    rel.startsWith("src/test/") ||
    rel.split("/").includes("__tests__") ||
    /\.test\.[cm]?[jt]sx?$/.test(rel)
  );
}

function mayNameVendor(rel: string): boolean {
  return isAdapterDirectory(rel) || REGISTRATION_POINTS.has(rel) || isTest(rel);
}

function sourceFiles(root: string): string[] {
  const abs = path.join(process.cwd(), root);
  const stat = statSync(abs, { throwIfNoEntry: false });
  if (!stat) return [];
  if (stat.isFile()) return [root];
  const out: string[] = [];
  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    const rel = path.join(root, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(rel));
    else if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) out.push(rel);
  }
  return out;
}

/** Every `file:line: text` in scanned source that names a vendor. */
function vendorNameOffences(): string[] {
  const offences: string[] = [];
  for (const root of SOURCE_ROOTS) {
    for (const rel of sourceFiles(root)) {
      if (mayNameVendor(rel)) continue;
      const lines = readFileSync(path.join(process.cwd(), rel), "utf8").split("\n");
      lines.forEach((line, index) => {
        if (VENDOR_NAMES.test(line)) offences.push(`${rel}:${index + 1}: ${line.trim()}`);
      });
    }
  }
  return offences;
}

describe("vendor names stay behind the harness adapter seam (issue #226)", () => {
  it("names no vendor in source outside the adapter directories, the registration points and tests", () => {
    const offences = vendorNameOffences();
    expect(
      offences,
      `vendor names outside the harness adapter seam — say "the harness" or "the adapter", ` +
        `or move the code under its adapter:\n  ${offences.join("\n  ")}`
    ).toEqual([]);
  });

  it("allows the places the ticket names, and nothing beside them", () => {
    expect(mayNameVendor("src/lib/harness/claude-code/index.ts")).toBe(true);
    // A directory under the seam that no descriptor registers is not an
    // adapter's, however it is named.
    expect(mayNameVendor("src/lib/harness/some-unregistered-harness/stream-parser.ts")).toBe(false);
    expect(mayNameVendor("src/lib/harness/registry.ts")).toBe(true);
    expect(mayNameVendor("src/lib/harness/descriptors.ts")).toBe(true);
    expect(mayNameVendor("src/lib/harness/__tests__/claude-code.test.ts")).toBe(true);
    expect(mayNameVendor("src/test/fake-harness.ts")).toBe(true);
    expect(mayNameVendor("src/lib/lanes/__tests__/resolve.test.ts")).toBe(true);
    expect(mayNameVendor("src/components/__tests__/quota-tile-render.test.tsx")).toBe(true);

    // The seam's contract files are the fleet's, not an adapter's.
    expect(mayNameVendor("src/lib/harness/adapter.ts")).toBe(false);
    expect(mayNameVendor("src/lib/harness/turn-result.ts")).toBe(false);
    expect(mayNameVendor("src/lib/harness/session-carry.ts")).toBe(false);
    expect(mayNameVendor("src/lib/config.ts")).toBe(false);
    expect(mayNameVendor("src/lib/lanes/lane-config.ts")).toBe(false);
    expect(mayNameVendor("src/db/schema.ts")).toBe(false);
    expect(mayNameVendor("src/components/fleet/quota-tile.tsx")).toBe(false);
    expect(mayNameVendor("custom-server.js")).toBe(false);
  });

  it("scans the seam's own contract files, so a vendor cannot hide in the interface", () => {
    const scanned = sourceFiles("src/lib/harness").filter((rel) => !mayNameVendor(rel));
    expect(scanned).toEqual(
      expect.arrayContaining([
        "src/lib/harness/adapter.ts",
        "src/lib/harness/turn-result.ts",
        "src/lib/harness/session-carry.ts",
        "src/lib/harness/image-state.ts",
      ])
    );
  });
});
