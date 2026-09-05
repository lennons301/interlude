import { afterEach, describe, expect, it } from "vitest";
import { getLaneCatalog, resetLaneCatalog } from "../catalog";
import { reportLaneAvailability } from "../availability-report";
import { laneMissingEnv } from "../resolve";

/**
 * The boot-time lane-availability report as wired (issue #226), driven against
 * the real `lanes.yaml`: it names each unavailable lane and the variables it
 * lacks, and says nothing when every lane is available.
 */

const catalog = (() => {
  resetLaneCatalog();
  const parsed = getLaneCatalog();
  if (!parsed.ok) throw new Error(parsed.reason);
  return parsed.catalog;
})();

/** Every orchestrator variable the shipped lanes name. */
const LANE_VARS = [...new Set(catalog.lanes.flatMap((lane) => lane.auth.map((ref) => ref.fromEnv)))];

function envWith(values: Record<string, string>): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const name of LANE_VARS) env[name] = values[name];
  return env;
}

function collect(env: Record<string, string | undefined>): string[] {
  const lines: string[] = [];
  reportLaneAvailability((line) => lines.push(line), env);
  return lines;
}

describe("reportLaneAvailability", () => {
  afterEach(() => resetLaneCatalog());

  it("says nothing when every declared lane's variables are present", () => {
    const all = Object.fromEntries(LANE_VARS.map((name) => [name, "set"]));
    expect(collect(envWith(all))).toEqual([]);
  });

  it("names every unavailable lane and the variables it lacks when nothing is set", () => {
    const lines = collect(envWith({}));
    expect(lines).toHaveLength(catalog.lanes.length);
    for (const lane of catalog.lanes) {
      const line = lines.find((text) => text.includes(`"${lane.id}"`));
      expect(line, `a line for lane ${lane.id}`).toBeDefined();
      expect(line).toMatch(/^\[lanes\] execution lane /);
      for (const variable of lane.auth.map((ref) => ref.fromEnv)) {
        expect(line).toContain(variable);
      }
    }
  });

  it("reports only the lanes a missing variable takes down, and only that variable", () => {
    // Knock out one variable and every lane that names it — and no other — is
    // reported, each naming exactly the variables it lacks.
    const [missing] = LANE_VARS;
    const env = envWith(Object.fromEntries(LANE_VARS.filter((v) => v !== missing).map((v) => [v, "set"])));
    const lines = collect(env);
    const expected = catalog.lanes.filter((lane) => laneMissingEnv(lane, env).length > 0);
    expect(expected.length).toBeGreaterThan(0);
    expect(lines).toHaveLength(expected.length);
    for (const lane of expected) {
      const line = lines.find((text) => text.includes(`"${lane.id}"`));
      expect(line).toContain(`${missing} is not set`);
    }
    for (const lane of catalog.lanes.filter((lane) => !expected.includes(lane))) {
      expect(lines.some((text) => text.includes(`"${lane.id}"`))).toBe(false);
    }
  });

  it("logs to console.warn by default", () => {
    const warned: string[] = [];
    const original = console.warn;
    console.warn = (line: string) => void warned.push(line);
    try {
      reportLaneAvailability(undefined, envWith({}));
    } finally {
      console.warn = original;
    }
    expect(warned.length).toBe(catalog.lanes.length);
  });
});
