"use client";

import {
  Chip,
  ChipRadio,
  PANEL_PLAIN,
  fallbackNote,
} from "@/components/fleet/fleet-bits";
import { FALL_THROUGH } from "@/components/settings-overrides";
import { MODEL_TIERS } from "@/lib/model-tiers";
import type { HarnessCapabilities } from "@/lib/harness/descriptors";
import type { HarnessImageState } from "@/lib/harness/image-state";
import type { LaneSettingsView, LaneView } from "@/lib/lanes/resolve";

/**
 * Which execution lane the fleet runs on (issue #172) — the substrate under
 * the tiers the panel above chooses.
 *
 * The lanes themselves are a checked-in file, deliberately: which lanes exist,
 * what they authenticate with and what each tier means on them is a reviewable
 * architectural fact. What belongs to the operator is *which one is primary*,
 * and that is this panel's single control.
 *
 * Everything else here is reporting, and the reporting is the point:
 *
 * - a lane says whether it can run at all, and names the variables it is
 *   missing when it cannot — the failure this replaces was a live agent dying
 *   inside the harness with "Not logged in";
 * - a lane says which **harness** runs it, whether that harness's agent image
 *   is built, and what the harness cannot do (issue #219) — so an unavailable
 *   lane is explained before a pass tries it, and a quota tile reading "cannot
 *   report" has its reason on this screen. Image state is a bounded probe of
 *   the daemon; one that did not answer reads as *unknown*, never as a verdict;
 * - a lane says who pays. `metered` is real money, so it reads in the same
 *   amber the rest of the control room uses for a deliberate hold;
 * - a lane says what it *charges*, per tier (issue #175). Not decoration: off
 *   an Anthropic-direct endpoint these figures — not the harness's reported
 *   cost — are what every budget in the fleet is measured against, so the
 *   number an operator is billed by is the number on this screen. A lane with
 *   no prices declared says so, because there the harness's figure stands;
 * - variable **names** only ever cross the wire. No lane secret is stored in
 *   the database or served by the API, and this panel could not show one if it
 *   wanted to.
 *
 * Presentational: its state is shared with the model-tier panel, because a
 * tier's model identifier is whatever the lane picked here says it is.
 */
export function ExecutionLanePanel({
  lanes,
  laneError,
  harnesses,
  busy,
  disabled,
  saveError,
  onChoose,
}: {
  lanes: LaneSettingsView | null;
  laneError: string | null;
  /** Each harness the file names with whether its image is built (#219);
   * joined onto the rows by adapter id. */
  harnesses: HarnessImageState[];
  busy: boolean;
  disabled: boolean;
  saveError: string | null;
  onChoose: (choice: string) => void;
}) {
  if (lanes === null) {
    return (
      <div className={PANEL_PLAIN}>
        <p role="alert" className="text-[13px] text-fl-red">
          No usable execution lanes — {laneError ?? "lanes.yaml could not be read"}.
          No pass can start until this is fixed.
        </p>
      </div>
    );
  }

  const selected = lanes.override ?? FALL_THROUGH;
  const primary = lanes.lanes.find((lane) => lane.id === lanes.primaryLaneId);

  return (
    <div className={`${PANEL_PLAIN} space-y-4`}>
      <p className="text-[13px] text-fl-ink-3">
        Which lane every pass runs on — the harness, the endpoint and the
        credentials behind each tier. The lanes themselves live in{" "}
        <span className="font-plex-mono">lanes.yaml</span>, where they can be
        reviewed; only the choice of primary is yours. Left on{" "}
        <span className="font-plex-mono">{FALL_THROUGH}</span>, the fleet
        follows <span className="font-plex-mono">{lanes.envVar}</span> and then
        the file&apos;s own preference order.
      </p>

      <fieldset className="space-y-1.5">
        <legend className="sr-only">Primary execution lane</legend>
        <div className="flex flex-wrap items-center gap-1.5">
          {lanes.lanes.map((lane) => (
            <ChipRadio
              key={lane.id}
              name="primaryLane"
              value={lane.id}
              selected={selected === lane.id}
              disabled={disabled}
              onSelect={() => onChoose(lane.id)}
            />
          ))}
          <ChipRadio
            name="primaryLane"
            value={FALL_THROUGH}
            selected={selected === FALL_THROUGH}
            disabled={disabled}
            onSelect={() => onChoose(FALL_THROUGH)}
          />
          {busy && (
            <span className="font-plex-mono text-[11px] text-fl-ink-3">…</span>
          )}
        </div>

        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 font-plex-mono text-[11px] text-fl-ink-3">
          <Chip tone={lanes.source === "override" ? "cool" : "quiet"}>
            {SOURCE_LABEL[lanes.source]}
          </Chip>
          <span>
            {lanes.primaryLaneId === null
              ? "no lane in force"
              : `runs on ${lanes.primaryLaneId}`}
          </span>
          <span aria-hidden>·</span>
          <span>
            {fallbackNote({
              envVar: lanes.envVar,
              envValue: lanes.envValue,
              overridden: lanes.source === "override",
            })}
          </span>
        </p>
      </fieldset>

      {primary !== undefined && !primary.available && (
        <p role="alert" className="text-[13px] text-fl-red">
          The lane in force cannot run: set{" "}
          <span className="font-plex-mono">
            {primary.missingEnvVars.join(", ")}
          </span>{" "}
          in the deployment, or pick a lane that is available. Until then every
          pass fails as it starts.
        </p>
      )}

      {lanes.unknownChoice !== null && (
        <p role="alert" className="text-[13px] text-fl-amber">
          &quot;{lanes.unknownChoice}&quot; names no declared lane — it was
          probably renamed or removed from{" "}
          <span className="font-plex-mono">lanes.yaml</span>. The fleet is
          running on{" "}
          <span className="font-plex-mono">{lanes.primaryLaneId ?? "nothing"}</span>{" "}
          instead.
        </p>
      )}

      <div className="space-y-3">
        {lanes.lanes.map((lane) => (
          <LaneRow
            key={lane.id}
            lane={lane}
            harness={harnesses.find((h) => h.id === lane.adapter) ?? null}
          />
        ))}
      </div>

      {saveError !== null && (
        <p role="alert" className="text-[13px] text-fl-red">
          {saveError}
        </p>
      )}
    </div>
  );
}

/**
 * A lane's prices in one line: input/output USD per million tokens, per tier.
 *
 * Input and output only — the cache columns matter to the total but not to the
 * comparison a reader is making here, which is "how much dearer is heavy than
 * light, and how does this lane compare to the last one?". The full table is
 * in `lanes.yaml`, where it is reviewed.
 */
function priceNote(prices: LaneView["prices"]): string {
  if (prices === null) return "prices from the harness's own reported cost";
  const perTier = MODEL_TIERS.map(
    (tier) => `${tier}=${prices[tier].inputPerMTok}/${prices[tier].outputPerMTok}`
  );
  return `$/Mtok in/out · ${perTier.join(" ")}`;
}

const SOURCE_LABEL: Record<LaneSettingsView["source"], string> = {
  override: "ui override",
  environment: "environment",
  preference: "default order",
};

/**
 * What a harness's image state says on the row (issue #219). Amber, not red,
 * for a missing image: it is built on demand at the first pass, so it is a
 * delay rather than a refusal — where a missing credential (red, below) fails
 * the pass as it starts. Quiet for a daemon that did not answer: "not built"
 * there would be a guess dressed as a verdict.
 */
function imageChip(harness: HarnessImageState | null) {
  if (harness === null || harness.built === null) {
    return <Chip tone="quiet">image unknown</Chip>;
  }
  return harness.built ? (
    <Chip tone="quiet">image ready</Chip>
  ) : (
    <Chip tone="amber">image not built</Chip>
  );
}

/** The capabilities a harness declares it lacks, in the words the rest of the
 * screen uses for them — so the quota tile's "cannot report" and the parser's
 * "declare prices" have their cause named beside the lane. */
const CAPABILITY_GAPS: ReadonlyArray<[keyof HarnessCapabilities, string]> = [
  ["quotaTelemetry", "no quota telemetry"],
  ["reportsCost", "no cost report"],
  ["sessionResume", "no session resume"],
  ["userInvokedSkills", "no user-invoked skills"],
];

function capabilityGaps(capabilities: HarnessCapabilities): string[] {
  return CAPABILITY_GAPS.filter(([key]) => !capabilities[key]).map(([, label]) => label);
}

/** One lane, as a fact sheet: whether it can run, who pays, which harness
 * runs it and whether that harness's image is built, where it points, and
 * what each tier means on it. */
function LaneRow({
  lane,
  harness,
}: {
  lane: LaneView;
  /** The lane's harness with its image state, or null when the route had no
   * answer for this adapter. */
  harness: HarnessImageState | null;
}) {
  const gaps = capabilityGaps(lane.capabilities);
  return (
    <div className="space-y-1 border-t border-fl-line pt-3 first:border-t-0 first:pt-0">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="text-sm text-fl-ink">{lane.label}</span>
        <span className="font-plex-mono text-[11px] text-fl-ink-3">{lane.id}</span>
        {lane.primary && <Chip tone="cool">primary</Chip>}
        <Chip tone={lane.billing === "metered" ? "amber" : "quiet"}>
          {lane.billing}
        </Chip>
        {/* Three facts a pass needs before it can run here (issue #219): the
            harness, its image, its credentials. */}
        <Chip tone="quiet">harness {lane.adapter}</Chip>
        {imageChip(harness)}
        {lane.available ? (
          <Chip tone="quiet">available</Chip>
        ) : (
          <Chip tone="red">unavailable</Chip>
        )}
      </div>

      <p className="font-plex-mono text-[11px] text-fl-ink-3">
        {harness === null ? lane.adapter : `${lane.adapter} (${harness.image})`} ·{" "}
        {lane.baseUrl ?? "default endpoint"} ·{" "}
        {MODEL_TIERS.map((tier) => `${tier}=${lane.models[tier]}`).join(" ")}
        {lane.caps.dailyBudgetUsd !== null &&
          ` · cap $${lane.caps.dailyBudgetUsd}/day`}
      </p>

      {gaps.length > 0 && (
        <p className="font-plex-mono text-[11px] text-fl-ink-3">
          {/* What this harness declares it cannot do — the reason the quota
              tile may read "cannot report", or the parser may insist on
              prices, for a lane on it. */}
          harness limits · {gaps.join(" · ")}
        </p>
      )}

      <p className="font-plex-mono text-[11px] text-fl-ink-3">
        {/* What the fleet charges a pass on this lane (issue #175). Spelled out
            per tier because the tiers differ by more than an order of
            magnitude on an open-weights lane, so one blended figure would
            misprice whichever tier the reader had in mind. */}
        {priceNote(lane.prices)}
      </p>

      <p className="font-plex-mono text-[11px] text-fl-ink-3">
        {lane.available
          ? `reads ${lane.authEnvVars.join(", ")}`
          : `needs ${lane.missingEnvVars.join(", ")} — not set in this deployment`}
      </p>
    </div>
  );
}
