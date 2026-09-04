import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LaneMovePanel } from "../fleet/lane-move-control";
import type {
  LaneMoveOffer,
  LaneMoveRefusal,
} from "@/lib/orchestrator/autonomy/lane-move";

/**
 * What the paused card's control says at each step of the press (issue #202).
 *
 * The panel decides nothing — the offer and the refusal arrive decided, from
 * the same pure function the route executes — so what is under test is what
 * it *says* and which control it offers: the lane and its cost before any
 * money is spent, a refusal that names its reason rather than going quiet, the
 * day's-spend confirmation offered where the operator stands (issue #173's
 * shape) with what it commits the fleet to, and a way to the settings screen
 * for the holds no press here can lift.
 */

const OFFER: LaneMoveOffer = {
  toLaneId: "openrouter-glm",
  toLaneLabel: "OpenRouter (GLM open weights)",
  billing: "metered",
  rateUsdPerMTok: 0.03875,
  cost:
    "That lane bills real money at about $0.039 per million tokens of a typical " +
    "pass, within today's confirmed real-money cap.",
  resume: 1,
  maxResumes: 3,
  fromLaneId: "claude-subscription",
  resumeAfter: "2026-09-04T14:00:00.000Z",
};

function refusal(over: Partial<LaneMoveRefusal>): LaneMoveRefusal {
  return { reason: "no-lane", message: "refused", heldLane: null, ...over };
}

const UNCONFIRMED = refusal({
  reason: "unconfirmed",
  message:
    "OpenRouter (GLM open weights) could serve this run, but today's real-money " +
    "spend is not confirmed.",
  heldLane: { id: "openrouter-glm", label: "OpenRouter (GLM open weights)", spentUsd: 0, capUsd: 20 },
});

function render(
  phase: Parameters<typeof LaneMovePanel>[0]["phase"],
  props: { pressError?: string | null; busy?: boolean } = {}
): string {
  return renderToStaticMarkup(
    <LaneMovePanel
      phase={phase}
      ticket="#34"
      pressError={props.pressError ?? null}
      busy={props.busy ?? false}
      onAsk={() => {}}
      onMove={() => {}}
      onOpenConfirm={() => {}}
      onConfirmSpend={() => {}}
      onDismiss={() => {}}
    />
  );
}

describe("the lane-move control", () => {
  it("starts as one quiet control that asks before it moves", () => {
    const html = render({ kind: "idle" });

    expect(html).toContain("move to paid lane…");
    expect(html).toContain("Move #34 onto a paid lane now");
    expect(html).not.toContain("move now");
  });

  it("puts the lane, its cost and the continuation in front of the operator before moving", () => {
    const html = render({ kind: "offered", offer: OFFER });

    expect(html).toContain("OpenRouter (GLM open weights)");
    expect(html).toContain("$0.039 per million tokens");
    expect(html).toContain("$0.039/Mtok");
    expect(html).toContain("continuation 1 of 3");
    expect(html).toContain("still standing");
    // The press is a verb, and there is a way back.
    expect(html).toContain("move now");
    expect(html).toContain("cancel");
  });

  it("says a subscription target costs nothing, without inventing a rate", () => {
    const html = render({
      kind: "offered",
      offer: {
        ...OFFER,
        billing: "subscription",
        rateUsdPerMTok: null,
        cost: "That lane runs on subscription quota, so the move costs nothing at the margin.",
      },
    });

    expect(html).toContain("costs nothing at the margin");
    expect(html).not.toContain("/Mtok");
  });

  it("keeps the offer on screen with a failed press under it", () => {
    const html = render(
      { kind: "offered", offer: OFFER },
      { pressError: "The move didn't happen — the server answered 500." }
    );

    expect(html).toContain("move now");
    expect(html).toContain("the server answered 500");
  });

  it("says a move is under way once it has been made", () => {
    const html = render({ kind: "moved", offer: OFFER });

    expect(html).toContain("moving to OpenRouter (GLM open weights)");
    expect(html).not.toContain("move now");
  });

  it("offers the day's press when the move is held for it, amber, beside the settings screen", () => {
    const html = render({ kind: "refused", refusal: UNCONFIRMED });

    expect(html).toContain("real-money spend is not confirmed");
    expect(html).toContain("confirm real-money spend…");
    expect(html).toContain('href="/settings"');
    expect(html).toContain("real money");
    expect(html).toContain("text-fl-amber");
    expect(html).not.toContain("move now");
  });

  it("says what confirming commits the fleet to, not just this run", () => {
    // The press is fleet-level (#174's gate), so the strip has to say that
    // autonomous passes may spend on it too — otherwise a card-shaped question
    // authorises unattended cash.
    const html = render({ kind: "confirming", refusal: UNCONFIRMED });

    expect(html).toContain("autonomous");
    expect(html).toContain("$20.00");
    expect(html).toContain("openrouter-glm");
    expect(html).toContain("confirm spend");
    expect(html).toContain("cancel");
  });

  it("offers no press at the cap — none would help before midnight", () => {
    const html = render({
      kind: "refused",
      refusal: refusal({
        reason: "cap-reached",
        message: "OpenRouter (GLM open weights) could serve this run, but today's real-money cap of $20.00 is spent.",
        heldLane: { id: "openrouter-glm", label: "OpenRouter (GLM open weights)", spentUsd: 20, capUsd: 20 },
      }),
    });

    expect(html).toContain("cap of $20.00 is spent");
    expect(html).not.toContain("confirm real-money spend");
    expect(html).toContain('href="/settings"');
  });

  it("says quietly that a run past its reset is minutes from resuming free", () => {
    const html = render({
      kind: "refused",
      refusal: refusal({
        reason: "window-reset",
        message: "The window on claude-subscription reset at Fri, 04 Sep 2026 09:00:00 GMT, so this run resumes on its own lane by itself within a few minutes.",
      }),
    });

    expect(html).toContain("resumes on its own lane by itself");
    // Nothing is wrong, so nothing is red and nothing points at settings.
    expect(html).toContain("text-fl-amber");
    expect(html).not.toContain("text-fl-red");
    expect(html).not.toContain('href="/settings"');
  });

  it("states that nowhere can serve the run, red, with the lanes screen as the remedy", () => {
    const html = render({
      kind: "refused",
      refusal: refusal({
        reason: "no-lane",
        message: "No other lane can serve this run: openrouter needs OPENROUTER_API_KEY.",
      }),
    });

    expect(html).toContain("OPENROUTER_API_KEY");
    expect(html).toContain("lanes and credentials");
    expect(html).toContain("text-fl-red");
    expect(html).toContain('role="alert"');
  });

  it("states a run that is not parked, with no remedy to offer but dismissing", () => {
    const html = render({
      kind: "refused",
      refusal: refusal({
        reason: "not-parked",
        message: "This run is implementing, not parked on a quota window.",
      }),
    });

    expect(html).toContain("not parked");
    expect(html).toContain("dismiss");
    expect(html).not.toContain('href="/settings"');
  });
});
