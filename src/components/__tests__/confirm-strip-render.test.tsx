import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ConfirmStrip } from "../confirm-strip";

/**
 * The strip's static half of the focus contract (issue #142). Effects don't run
 * in a static render, so the `focus()` call itself isn't observable here — what
 * is, and what silently defeats it, is the container being unfocusable: calling
 * `focus()` on a plain `div` does nothing at all. That coupling is easy to lose
 * in a class-string edit and invisible when it goes, so it is asserted rather
 * than left to a reading.
 */
function render() {
  return renderToStaticMarkup(
    <ConfirmStrip
      label="Confirm arming lemons"
      tone="cool"
      confirm="confirm arm"
      busyLabel="arming…"
      busy={false}
      error={null}
      onConfirm={() => {}}
      onCancel={() => {}}
    >
      <p>Arm lemons for unattended work?</p>
    </ConfirmStrip>
  );
}

describe("the confirmation strip", () => {
  it("is focusable programmatically, and only programmatically", () => {
    // -1 keeps it out of the tab order: a decision you are sent to, not a stop
    // on the way past.
    expect(render()).toContain('tabindex="-1"');
  });

  it("names the decision where focus lands", () => {
    const html = render();

    expect(html).toContain('role="group"');
    expect(html).toContain('aria-label="Confirm arming lemons"');
  });

  it("offers both ways out", () => {
    const html = render();

    expect(html).toContain("confirm arm");
    expect(html).toContain("cancel");
  });
});
