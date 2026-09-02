import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CrossingPanel, type CrossingState } from "../metered-crossing";

/**
 * What an attended session is told when the money guards meet it (issue #173).
 *
 * The panel decides nothing — the crossing arrives decided, from the same pure
 * function the orchestrator routes the pass with — so what is under test is
 * what it *says*, and which control it offers. The asymmetry is the point: one
 * press ends the confirmation hold, and no press can end the cap before
 * midnight, so offering a button there would send the owner to a control that
 * cannot help.
 */

function crossing(over: Partial<CrossingState> = {}): CrossingState {
  return { laneId: "openrouter", refusal: null, notice: null, capUsd: 20, ...over };
}

function render(
  over: Partial<CrossingState> = {},
  props: { confirming?: boolean; busy?: boolean; error?: string | null } = {}
): string {
  return renderToStaticMarkup(
    <CrossingPanel
      crossing={crossing(over)}
      busy={props.busy ?? false}
      confirming={props.confirming ?? false}
      error={props.error ?? null}
      onOpen={() => {}}
      onConfirm={() => {}}
      onCancel={() => {}}
    />
  );
}

describe("the crossing panel", () => {
  it("says nothing at all when nothing is crossing", () => {
    expect(render()).toBe("");
  });

  it("says quietly that a permitted session is spending money", () => {
    const html = render({
      notice: "OpenRouter bills per token. Real money: $2.00 of $20.00 spent today.",
    });

    expect(html).toContain("OpenRouter bills per token");
    // Nothing is held, so nothing is offered to press.
    expect(html).not.toContain("<button");
  });

  it("offers the day's one press when a session is held for it", () => {
    const html = render({
      refusal: {
        reason: "unconfirmed",
        message:
          "The Claude subscription window is exhausted (resets 14:05), so this " +
          "session would continue on OpenRouter — which bills per token. Confirm " +
          "real-money spend to continue.",
      },
    });

    expect(html).toContain("resets 14:05");
    expect(html).toContain("confirm real-money spend");
  });

  it("says what confirming commits the fleet to, not just this session", () => {
    // The press is fleet-level (#174's gate), so the strip has to say that
    // autonomous passes may spend on it too — otherwise a session-shaped
    // question authorises unattended cash.
    const html = render(
      { refusal: { reason: "unconfirmed", message: "held" } },
      { confirming: true }
    );

    expect(html).toContain("autonomous passes may also spend");
    expect(html).toContain("$20.00");
    expect(html).toContain("openrouter");
  });

  it("offers no press at the cap — none would help before midnight", () => {
    const html = render({
      refusal: {
        reason: "cap-reached",
        message: "Capped: today's real-money limit of $20.00 is spent.",
      },
    });

    expect(html).toContain("Capped");
    expect(html).not.toContain("confirm real-money spend");
    // The remedy it does have: the screen where the cap lives.
    expect(html).toContain("raise the cap");
    expect(html).toContain('role="alert"');
  });

  it("points at lanes and credentials when there is nowhere to overflow", () => {
    const html = render({
      refusal: {
        reason: "no-metered-lane",
        message: "...no paid lane to overflow onto — openrouter needs OPENROUTER_API_KEY.",
      },
    });

    expect(html).toContain("OPENROUTER_API_KEY");
    expect(html).toContain("lanes and credentials");
    expect(html).not.toContain("confirm real-money spend");
  });

  it("shows a failed press without losing the question", () => {
    const html = render(
      { refusal: { reason: "unconfirmed", message: "held for a press" } },
      { error: "That didn't stick — the request failed." }
    );

    expect(html).toContain("held for a press");
    expect(html).toContain("That didn&#x27;t stick");
  });
});
