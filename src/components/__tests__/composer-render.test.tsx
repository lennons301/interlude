import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MessageInput } from "../message-input";

/**
 * The composer's decisions live in `composerState` / `slash` and are tested
 * there. What these cover is that the component actually wires them to the
 * field: the states reach the markup, the controls carry the right enabled-ness
 * and labels, and the keyboard contract is stated where you can read it.
 *
 * Effects do not run in a static render, so this sees the composer's
 * first-paint state — which is the desktop one (Enter sends). The touch
 * variant is resolved on mount from a pointer media query.
 */
/** The rendered `disabled` attribute, not the `disabled:` utility classes the
 * same markup is full of. */
const DISABLED = /disabled=""/;

function tag(html: string, pattern: RegExp): string {
  return pattern.exec(html)?.[0] ?? "";
}

function render(props: Partial<React.ComponentProps<typeof MessageInput>> = {}) {
  return renderToStaticMarkup(
    <MessageInput
      taskId="01TASK"
      taskStatus="running"
      containerStatus="idle"
      queued={0}
      sessionSkill={null}
      {...props}
    />
  );
}

describe("composer — field", () => {
  it("is a multiline field that autosizes rather than being dragged", () => {
    const html = render();

    expect(html).toContain("<textarea");
    expect(html).toContain('rows="1"');
    expect(html).toContain("resize-none");
    // The growth is capped in CSS so a long answer scrolls instead of eating
    // the transcript.
    expect(html).toContain("max-h-40");
  });

  it("labels itself for a screen reader", () => {
    expect(render()).toContain('aria-label="Message the agent"');
  });

  it("states the keyboard contract under the field", () => {
    expect(render()).toContain("enter to send · shift+enter for a newline");
  });
});

describe("composer — feedback", () => {
  it("says the agent is idle and awaiting you", () => {
    const html = render({ containerStatus: "idle" });

    expect(html).toContain("agent idle");
    expect(html).toContain("Message the agent…");
  });

  it("says the agent is working, and that a message would queue", () => {
    const html = render({ containerStatus: "running" });

    expect(html).toContain("agent working");
    expect(html).toContain("your message will be queued");
  });

  it("counts messages the agent has not been handed yet", () => {
    expect(render({ containerStatus: "running", queued: 2 })).toContain("2 queued");
    expect(render({ containerStatus: "running", queued: 0 })).not.toContain("queued</span>");
  });

  it("announces its status rather than leaving it to be noticed", () => {
    expect(render()).toContain('role="status"');
  });

  it("takes nothing before the task has a container, and says why", () => {
    const html = render({ taskStatus: "queued", containerStatus: null });

    expect(html).toContain("queued for a slot");
    expect(tag(html, /<textarea[^>]*>/)).toMatch(DISABLED);
  });
});

describe("composer — controls", () => {
  it("offers continue on an idle agent with an empty draft", () => {
    expect(render({ containerStatus: "idle" })).toContain(">continue</button>");
  });

  it("offers completion between turns", () => {
    const html = render({ containerStatus: "idle" });

    expect(tag(html, /<button[^>]*>complete<\/button>/)).not.toMatch(DISABLED);
  });

  it("withholds completion mid-turn, when the API would refuse it anyway", () => {
    const html = render({ containerStatus: "running" });

    expect(tag(html, /<button[^>]*>complete<\/button>/)).toMatch(DISABLED);
  });

  it("takes an answer to a blocked run, but offers no bare continue", () => {
    const html = render({ taskStatus: "blocked", containerStatus: null });

    expect(html).toContain("blocked on a question");
    expect(tag(html, /<textarea[^>]*>/)).not.toMatch(DISABLED);
    // Nothing to continue — the agent asked something, so the primary control
    // waits, as a send, for an answer to send.
    expect(html).not.toContain(">continue</button>");
    expect(tag(html, /<button[^>]*>send<\/button>/)).toMatch(DISABLED);
  });
});

describe("composer — slash commands", () => {
  it("advertises the session commands in a generation session", () => {
    expect(render({ sessionSkill: "grill-me" })).toContain("/ for session commands");
  });

  it("says nothing about them on a plain chat task, where they are not routed", () => {
    expect(render({ sessionSkill: null })).not.toContain("session commands");
  });
});
