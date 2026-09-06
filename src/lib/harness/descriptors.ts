/**
 * The static descriptor table (issue #214): every harness adapter that ships,
 * by id, with the capabilities it declares.
 *
 * A leaf module with no imports, on purpose. The lane parser is pure and must
 * stay so — text in, catalog out, no filesystem and no adapter code — yet it
 * has to know which adapter ids a lane may name. The registry, meanwhile,
 * holds the adapters themselves, and an adapter imports the stream parser,
 * which imports the database. Handing the parser this table rather than the
 * registry is what lets it check an id without pulling the database into a
 * pure module; a test pins the table to the registry so the two cannot drift
 * (`descriptors.test.ts`). Registering an adapter is therefore two edits —
 * one row here, one entry in `registry.ts` — and the test fails if either is
 * made without the other.
 *
 * Capabilities are static booleans declared once and read by three things
 * that must agree: the lane parser (a metered lane on a harness that reports
 * no cost must declare prices, issue #219), the router (a generation session
 * may only run where skills can be invoked, issue #218) and the dashboard (a
 * lane whose harness reports no quota is "cannot report", not "not observed
 * yet"). They describe the *harness*, never a lane or a provider: which model
 * answers and who bills is the lane's to say.
 */

export interface HarnessCapabilities {
  /** The harness expands a user-typed skill invocation (Claude Code's slash,
   * Codex's `$skill` mention) — what a generation session needs. */
  userInvokedSkills: boolean;
  /** The harness's stream carries quota telemetry the fleet can read into
   * `quota_state` (Claude Code's `rate_limit_event`). A lane on a harness
   * without it can never say how much window is left. */
  quotaTelemetry: boolean;
  /** The harness reports a dollar cost for the turn. Where it does not, a
   * metered lane must declare prices or its spend is fiction. */
  reportsCost: boolean;
  /** The harness can resume a session by id from artefacts the fleet copies
   * in and out of the container — what a lossless pause or lane move needs. */
  sessionResume: boolean;
}

export interface HarnessAdapterDescriptor {
  id: string;
  capabilities: HarnessCapabilities;
}

/**
 * The adapters that ship. Order is immaterial; ids are unique.
 *
 * Three today: Claude Code, the Codex CLI (issue #221) and OpenCode (issue
 * #222) — a row here without a registry entry, or the reverse, fails the pin
 * test rather than a pass.
 *
 * Codex's row is a capability statement, not a judgement (the spec's rule):
 * its exec stream carries no quota telemetry and no dollar figure, so a
 * metered Codex lane must declare prices and the quota tile says "cannot
 * report"; it resumes a thread by id from one rollout file; and user-invoked
 * skills stay **off** until the proof ticket (#224) shows `$skill` mentions
 * honoured under `codex exec` — until then no generation session routes to a
 * Codex lane.
 *
 * OpenCode's row is the same kind of statement:
 * its `run --format json` stream carries no quota telemetry, and the dollar
 * figure on its step events is the CLI's own estimate from the models.dev
 * catalogue rather than a provider's bill, so the fleet does not rely on it —
 * a metered OpenCode lane must declare prices and the quota tile says "cannot
 * report"; it resumes a session by id from its one SQLite database; and it
 * **can** invoke user-named skills (on since the proof ticket, #225): the
 * adapter's instruction made the model load the named SKILL.md through its
 * `skill` tool on every probe — an unguessable sentinel read back verbatim,
 * `to-spec` followed to a drafted spec, and a `to-tickets` session through
 * the orchestrator followed to its publish step — so a generation session
 * may route to an OpenCode lane.
 */
export const HARNESS_ADAPTER_DESCRIPTORS = [
  {
    id: "claude-code",
    capabilities: {
      userInvokedSkills: true,
      quotaTelemetry: true,
      reportsCost: true,
      sessionResume: true,
    },
  },
  {
    id: "codex",
    capabilities: {
      userInvokedSkills: false,
      quotaTelemetry: false,
      reportsCost: false,
      sessionResume: true,
    },
  },
  {
    id: "opencode",
    capabilities: {
      userInvokedSkills: true,
      quotaTelemetry: false,
      reportsCost: false,
      sessionResume: true,
    },
  },
] as const satisfies readonly HarnessAdapterDescriptor[];

/** The id of an adapter that ships — the production table's own vocabulary. */
export type HarnessAdapterId = (typeof HARNESS_ADAPTER_DESCRIPTORS)[number]["id"];

/** The ids a lane file may name, in table order. */
export function harnessAdapterIds(
  descriptors: readonly HarnessAdapterDescriptor[] = HARNESS_ADAPTER_DESCRIPTORS
): string[] {
  return descriptors.map((d) => d.id);
}

/** The descriptor for an id, or null when no adapter of that id is described. */
export function describeHarnessAdapter(
  id: string,
  descriptors: readonly HarnessAdapterDescriptor[] = HARNESS_ADAPTER_DESCRIPTORS
): HarnessAdapterDescriptor | null {
  return descriptors.find((d) => d.id === id) ?? null;
}

/**
 * The descriptor a shipped adapter reads its capabilities from at load, so the
 * adapter cannot disagree with what the lane parser was told about it. Throws
 * rather than defaulting: unreachable while the table names the adapter, and a
 * throw at load rather than a silent default is what "cannot be registered
 * without a descriptor" means at runtime, ahead of the test that pins it.
 */
export function requireHarnessDescriptor(id: string): HarnessAdapterDescriptor {
  const descriptor = describeHarnessAdapter(id);
  if (descriptor === null) throw new Error(`harness adapter "${id}" has no descriptor`);
  return descriptor;
}
