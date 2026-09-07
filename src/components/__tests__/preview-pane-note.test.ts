import { describe, it, expect } from "vitest";
import { emptyPaneNote } from "../preview-pane";

/** What the empty preview pane says, by session type and history (issue #160). */
describe("emptyPaneNote", () => {
  it("says a server that was up has stopped, whatever the session type", () => {
    for (const expected of [true, false]) {
      expect(emptyPaneNote({ expected, agentWorking: true, everHadPort: true })).toMatch(
        /^Dev server stopped/
      );
    }
  });

  it("tells a live-preview session it is waiting while the agent works", () => {
    expect(emptyPaneNote({ expected: true, agentWorking: true, everHadPort: false })).toMatch(
      /^Waiting for the dev server/
    );
  });

  it("tells a live-preview session whose agent went idle without a server what to ask for", () => {
    expect(emptyPaneNote({ expected: true, agentWorking: false, everHadPort: false })).toContain(
      "ask the agent to start it"
    );
  });

  it("says nothing more than 'none running' for an ordinary chat", () => {
    expect(emptyPaneNote({ expected: false, agentWorking: true, everHadPort: false })).toBe(
      "No dev server running"
    );
  });
});
