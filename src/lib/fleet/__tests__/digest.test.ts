import { describe, it, expect } from "vitest";
import {
  DIGEST_TITLE_PREFIX,
  previousLocalDay,
  renderDailyDigest,
  type DigestContent,
} from "../digest";
import {
  buildFleetView,
  type FleetRows,
  type FleetProjectRow,
  type FleetRunRow,
  type FleetTaskRow,
} from "../fleet-view";

// The digest goes out the morning of Sun 2 Aug, covering Sat 1 Aug. The view
// is built at the last instant of the covered day, so the read model's own
// "today" — spend, windows — is the digest's day. Same structure as the
// dashboard, shifted; the two cannot disagree.
const SEND = new Date(2026, 7, 2, 8, 0, 0);
const WINDOW = previousLocalDay(SEND);
const VIEW_AT = new Date(WINDOW.end.getTime() - 1);

const aug = (day: number, hour: number) => new Date(2026, 7, day, hour, 0, 0);
const jul = (day: number, hour: number) => new Date(2026, 6, day, hour, 0, 0);

function baseRows(overrides: Partial<FleetRows> = {}): FleetRows {
  return {
    now: VIEW_AT,
    slots: 2,
    dailyCapUsd: 500,
    globalAutonomyPaused: false,
    // The boot master on, so every test that doesn't say otherwise describes an
    // install where autonomy is actually armed at boot (issue #148).
    autonomyEnabledAtBoot: true,
    discordGuildId: null,
    projects: [],
    runs: [],
    tasks: [],
    backlogByProject: null,
    needsHumanByProject: null,
    fleetHealth: null,
    failingChecksByRun: null,
    quota: null,
    ...overrides,
  };
}

function makeProject(overrides: Partial<FleetProjectRow> = {}): FleetProjectRow {
  return {
    id: "proj-1",
    name: "lemons",
    autonomyEnabled: false,
    preflightStatus: null,
    preflightReason: null,
    discordChannelId: null,
    ...overrides,
  };
}

function makeRun(overrides: Partial<FleetRunRow> = {}): FleetRunRow {
  return {
    id: "run-1",
    projectId: "proj-1",
    githubIssue: "lennons301/lemons#34",
    attempt: 1,
    mode: "autonomous",
    status: "implementing",
    budgetUsd: 20,
    totalCostUsd: 0,
    pullRequestNumber: null,
    pullRequestUrl: null,
    blockedQuestion: null,
    integrationCount: 0,
    ciRepairCount: 0,
    reviewVerdict: null,
    reviewResult: null,
    resumeAfter: null,
    model: null,
    degradedFrom: null,
    claimedAt: aug(1, 9),
    startedAt: aug(1, 9),
    finishedAt: null,
    ...overrides,
  };
}

function makeTask(overrides: Partial<FleetTaskRow> = {}): FleetTaskRow {
  return {
    id: "task-1",
    projectId: "proj-1",
    runId: null,
    kind: "interactive",
    sessionSkill: null,
    sessionIssue: null,
    title: "Polish the header",
    status: "running",
    containerStatus: "idle",
    totalCostUsd: 0,
    turns: 1,
    githubIssue: null,
    pullRequestNumber: null,
    pullRequestUrl: null,
    createdAt: aug(1, 9),
    updatedAt: aug(1, 9),
    ...overrides,
  };
}

function render(overrides: Partial<FleetRows> = {}): DigestContent {
  const view = buildFleetView(baseRows(overrides));
  return renderDailyDigest(view, WINDOW, {
    appBaseUrl: "https://interludes.co.uk",
  });
}

function section(content: DigestContent, heading: string): string[] {
  const found = content.sections.find((s) => s.heading === heading);
  if (!found) throw new Error(`no section "${heading}"`);
  return found.lines;
}

describe("previousLocalDay", () => {
  it("covers the full local calendar day before now, across a month boundary", () => {
    const window = previousLocalDay(new Date(2026, 7, 1, 8, 0, 0)); // Sat 1 Aug, 08:00

    expect(window.start).toEqual(new Date(2026, 6, 31, 0, 0, 0));
    expect(window.end).toEqual(new Date(2026, 7, 1, 0, 0, 0));
  });
});

describe("renderDailyDigest — autonomous pickup", () => {
  it("leads with the kill-switch hold, in its own wording, with a way to lift it", () => {
    const content = render({ globalAutonomyPaused: true });

    expect(content.sections[0].heading).toBe("Autonomous pickup");
    expect(section(content, "Autonomous pickup")).toEqual([
      "⏸ Held right now — the kill switch is engaged: nothing new is being " +
        "claimed anywhere, and nothing will be until you lift it. Runs " +
        "already in flight and interactive work are unaffected. · " +
        "[Lift it](https://interludes.co.uk/settings)",
    ]);
  });

  it("reads differently from an ordinarily quiet day on an armed fleet", () => {
    // The baseline is a genuinely armed fleet that simply did nothing — the
    // hardest case to tell apart, and the one the issue is about. Everything
    // else about the two days is identical: nothing finished, nothing ran,
    // nothing waits. Only the hold tells them apart.
    const armed = { projects: [makeProject({ id: "p1", autonomyEnabled: true })] };
    const held = render({ ...armed, globalAutonomyPaused: true });
    const quiet = render(armed);

    expect(section(held, "Completed yesterday")).toEqual(
      section(quiet, "Completed yesterday")
    );
    expect(section(held, "In flight")).toEqual(section(quiet, "In flight"));
    expect(section(held, "Blocked on you")).toEqual(
      section(quiet, "Blocked on you")
    );
    expect(section(held, "Autonomous pickup")).not.toEqual(
      section(quiet, "Autonomous pickup")
    );
    expect(section(held, "Autonomous pickup")[0]).toContain(
      "the kill switch is engaged"
    );
    expect(section(quiet, "Autonomous pickup")[0]).toContain("No fleet-wide hold");
  });

  it("words the daily-cap pause as the lapsed, self-lifting thing it is", () => {
    const content = render({
      dailyCapUsd: 500,
      runs: [
        makeRun({
          id: "r1",
          totalCostUsd: 512.34,
          status: "merged",
          finishedAt: aug(1, 21),
        }),
      ],
      projects: [makeProject({ id: "proj-1" })],
    });

    expect(section(content, "Autonomous pickup")).toEqual([
      "⏸ Paused — yesterday's spend reached the $500.00 daily cap, so pickup " +
        "stopped for the rest of the day; the pause lifted at midnight.",
    ]);
  });

  it("names the switch when both holds apply, and still reports the breach", () => {
    const content = render({
      globalAutonomyPaused: true,
      dailyCapUsd: 500,
      runs: [
        makeRun({
          id: "r1",
          totalCostUsd: 512.34,
          status: "merged",
          finishedAt: aug(1, 21),
        }),
      ],
      projects: [makeProject({ id: "proj-1" })],
    });

    expect(section(content, "Autonomous pickup")[0]).toContain("kill switch");
    expect(section(content, "Spend")).toEqual([
      "$512.34 of $500.00 daily cap — cap hit, pickup was paused",
    ]);
  });

  it("claims only what the view knows when no fleet-wide hold applies", () => {
    const content = render({
      projects: [makeProject({ id: "p1", autonomyEnabled: true })],
    });

    // Still not "pickup was running": preflight is per-project, and the
    // Backlog section is where that is said (issue #148).
    expect(section(content, "Autonomous pickup")).toEqual([
      "No fleet-wide hold — autonomy is on, the kill switch is lifted and the day stayed inside the cap.",
    ]);
  });

  it("leads with the boot master, and does not offer the kill switch as the remedy", () => {
    const content = render({
      autonomyEnabledAtBoot: false,
      projects: [makeProject({ id: "p1", autonomyEnabled: true })],
    });

    expect(section(content, "Autonomous pickup")).toEqual([
      "⏸ Off right now — autonomy is disabled on this install " +
        "(AUTONOMY_ENABLED), so no sweep runs at all and nothing is claimed " +
        "for any project. The kill switch cannot lift this one: it takes a " +
        "config change and a restart.",
    ]);
    expect(section(content, "Autonomous pickup")[0]).not.toContain("/settings");
  });

  it("keeps the boot master ahead of a runtime hold, and still reports the breach", () => {
    const content = render({
      autonomyEnabledAtBoot: false,
      globalAutonomyPaused: true,
      dailyCapUsd: 500,
      runs: [
        makeRun({
          id: "r1",
          totalCostUsd: 512.34,
          status: "merged",
          finishedAt: aug(1, 21),
        }),
      ],
      projects: [makeProject({ id: "proj-1" })],
    });

    expect(section(content, "Autonomous pickup")[0]).toContain("AUTONOMY_ENABLED");
    expect(section(content, "Spend")).toEqual([
      "$512.34 of $500.00 daily cap — cap hit, pickup was paused",
    ]);
  });

  it("distinguishes an unheld fleet with no project armed", () => {
    const content = render({
      projects: [makeProject({ id: "p1", autonomyEnabled: false })],
    });

    expect(section(content, "Autonomous pickup")).toEqual([
      "No project has autonomy enabled — nothing is claimed unattended.",
    ]);
  });
});

describe("renderDailyDigest — completed yesterday", () => {
  it("lists yesterday's finished work with cost and PR link, nothing outside the day", () => {
    const content = render({
      projects: [makeProject({ id: "p1", name: "lemons" })],
      runs: [
        makeRun({
          id: "r-yday",
          projectId: "p1",
          githubIssue: "o/r#2",
          status: "merged",
          totalCostUsd: 11.5,
          finishedAt: aug(1, 14),
          pullRequestNumber: 41,
          pullRequestUrl: "https://github.com/o/r/pull/41",
        }),
        makeRun({
          id: "r-today",
          projectId: "p1",
          githubIssue: "o/r#3",
          status: "merged",
          claimedAt: aug(2, 5),
          finishedAt: aug(2, 6), // this morning — tomorrow's digest
        }),
        makeRun({
          id: "r-older",
          projectId: "p1",
          githubIssue: "o/r#4",
          status: "merged",
          claimedAt: jul(31, 9),
          finishedAt: jul(31, 10), // the day before — yesterday's digest
        }),
      ],
    });

    expect(section(content, "Completed yesterday")).toEqual([
      "✅ o/r#2 — lemons · $11.50 · [PR #41](https://github.com/o/r/pull/41)",
    ]);
  });

  it("marks failures and includes finished interactive sessions", () => {
    const content = render({
      projects: [makeProject({ id: "p1", name: "interlude" })],
      runs: [
        makeRun({
          id: "r-fail",
          projectId: "p1",
          githubIssue: "o/r#7",
          status: "failed",
          totalCostUsd: 4.25,
          finishedAt: aug(1, 10),
        }),
      ],
      tasks: [
        makeTask({
          id: "t-chat",
          projectId: "p1",
          title: "Sofa session",
          status: "completed",
          containerStatus: null,
          totalCostUsd: 2.5,
          updatedAt: aug(1, 16),
        }),
      ],
    });

    expect(section(content, "Completed yesterday")).toEqual([
      "✅ Sofa session — interlude · $2.50",
      "❌ o/r#7 — interlude · $4.25",
    ]);
  });

  it("says so when nothing finished", () => {
    const content = render();

    expect(section(content, "Completed yesterday")).toEqual([
      "Nothing finished.",
    ]);
  });
});

describe("renderDailyDigest — in flight", () => {
  it("lists active runs with attempt and spend, and interactive sessions", () => {
    const content = render({
      projects: [
        makeProject({ id: "p1", name: "lemons" }),
        makeProject({ id: "p2", name: "interlude" }),
      ],
      runs: [
        makeRun({
          id: "r1",
          projectId: "p1",
          attempt: 2,
          status: "implementing",
          totalCostUsd: 7.8,
          budgetUsd: 20,
        }),
        makeRun({
          id: "r2",
          projectId: "p1",
          githubIssue: "lennons301/lemons#35",
          mode: "supervised",
          status: "reviewing",
          totalCostUsd: 3,
          budgetUsd: 20,
          claimedAt: aug(1, 10),
          startedAt: aug(1, 10),
        }),
      ],
      tasks: [
        makeTask({
          id: "t-impl",
          projectId: "p1",
          runId: "r1",
          kind: "implement",
          title: "Add pagination to the list",
          containerStatus: "running",
        }),
        makeTask({
          id: "t-chat",
          projectId: "p2",
          title: "Polish the header",
          containerStatus: "idle",
          totalCostUsd: 1.23,
        }),
      ],
    });

    expect(section(content, "In flight")).toEqual([
      "lemons #34 · Add pagination to the list · attempt 2/3 · $7.80 of $20.00",
      "lemons #35 · lennons301/lemons#35 · attempt 1/3 · $3.00 of $20.00 · supervised",
      "interlude · Polish the header · interactive · $1.23",
    ]);
  });

  it("labels a generation session by its skill, not 'interactive' (issue #61)", () => {
    const content = render({
      projects: [makeProject({ id: "p1", name: "interlude" })],
      tasks: [
        makeTask({
          id: "t-session",
          projectId: "p1",
          title: "Grill a fresh idea",
          sessionSkill: "grill-me",
          containerStatus: "idle",
          totalCostUsd: 2.4,
        }),
      ],
    });

    expect(section(content, "In flight")).toEqual([
      "interlude · Grill a fresh idea · session grill-me · $2.40",
    ]);
  });

  it("says a quota-paused run is paused, and when its window resets (#168)", () => {
    // The digest reads the same `paused` field the dashboard does, so the two
    // cannot disagree about whether a run is being worked. The reset is stated
    // rather than counted down: a digest is read hours after it is written.
    const content = render({
      projects: [makeProject({ id: "p1", name: "lemons" })],
      runs: [
        makeRun({
          id: "r1",
          projectId: "p1",
          attempt: 2,
          status: "rate_limited",
          resumeAfter: aug(1, 17),
          totalCostUsd: 7.8,
          budgetUsd: 20,
        }),
      ],
      tasks: [
        makeTask({
          id: "t-impl",
          projectId: "p1",
          runId: "r1",
          kind: "implement",
          title: "Add pagination to the list",
          status: "failed",
          containerStatus: null,
        }),
      ],
    });

    expect(section(content, "In flight")).toEqual([
      "lemons #34 · Add pagination to the list · attempt 2/3 · $7.80 of $20.00 · " +
        "paused, quota resets Sat 1 Aug 17:00",
    ]);
  });

  it("says a run is working below the tier it was asked for (#170)", () => {
    // Same argument one ticket later: the digest reads the same `degraded`
    // field the dashboard does, so neither can claim a run is on a tier the
    // other says it left.
    const content = render({
      projects: [makeProject({ id: "p1", name: "lemons" })],
      runs: [
        makeRun({
          id: "r1",
          projectId: "p1",
          attempt: 2,
          status: "implementing",
          model: "standard",
          degradedFrom: "heavy",
          totalCostUsd: 7.8,
          budgetUsd: 20,
        }),
      ],
      tasks: [
        makeTask({
          id: "t-impl",
          projectId: "p1",
          runId: "r1",
          kind: "implement",
          title: "Add pagination to the list",
          status: "running",
          containerStatus: "running",
        }),
      ],
    });

    expect(section(content, "In flight")).toEqual([
      "lemons #34 · Add pagination to the list · attempt 2/3 · $7.80 of $20.00 · " +
        "at standard, stepped down from heavy",
    ]);
  });

  it("says so when nothing is running", () => {
    const content = render();

    expect(section(content, "In flight")).toEqual(["Nothing running."]);
  });
});

describe("renderDailyDigest — blocked on you", () => {
  it("lists needs-you items, absolutizing the view's in-app links", () => {
    const content = render({
      projects: [makeProject({ id: "p1", name: "lemons" })],
      runs: [
        makeRun({
          id: "r-blocked",
          projectId: "p1",
          status: "blocked",
          attempt: 2,
          blockedQuestion: "Which auth provider should I use?",
        }),
        makeRun({
          id: "r-gated",
          projectId: "p1",
          githubIssue: "lennons301/lemons#35",
          status: "gated",
          // An approved-but-gated PR is a genuine sign-off wait (issue #90):
          // one human merge away.
          reviewVerdict: "approve",
          claimedAt: aug(1, 10),
          pullRequestNumber: 55,
          pullRequestUrl: "https://github.com/lennons301/lemons/pull/55",
        }),
      ],
      tasks: [
        makeTask({
          id: "t-blocked",
          projectId: "p1",
          runId: "r-blocked",
          kind: "implement",
          status: "blocked",
          containerStatus: "idle",
        }),
      ],
    });

    expect(section(content, "Blocked on you")).toEqual([
      "lemons #34 · attempt 2/3 — Which auth provider should I use? · [Open task](https://interludes.co.uk/tasks/t-blocked)",
      "lemons #35 · attempt 1/3 — PR #55 waits for your sign-off · [Review PR #55](https://github.com/lennons301/lemons/pull/55)",
    ]);
  });

  it("leaves the cap card to the spend section and says so when clear", () => {
    const capBreached = render({
      dailyCapUsd: 10,
      runs: [
        makeRun({
          id: "r1",
          status: "merged",
          totalCostUsd: 12,
          finishedAt: aug(1, 14),
        }),
      ],
      projects: [makeProject({ id: "proj-1" })],
    });

    expect(section(capBreached, "Blocked on you")).toEqual([
      "Nothing waits on you.",
    ]);
  });
});

describe("renderDailyDigest — backlog", () => {
  it("shows backlog depth per project, deepest first", () => {
    const armed = { autonomyEnabled: true, preflightStatus: "passing" } as const;
    const content = render({
      backlogByProject: { p1: 2, p2: 5 },
      projects: [
        makeProject({ id: "p1", name: "interlude", ...armed }),
        makeProject({ id: "p2", name: "lemons", ...armed }),
      ],
    });

    expect(section(content, "Backlog (ready-for-agent)")).toEqual([
      "lemons: 5",
      "interlude: 2",
    ]);
  });

  it("says per project when a depth isn't going anywhere", () => {
    // Preflight is per-project, so this is where it is said — a depth printed
    // bare reads as work about to start (issue #148).
    const content = render({
      backlogByProject: { p1: 5, p2: 4, p3: 3, p4: 2 },
      projects: [
        makeProject({ id: "p1", name: "armed", autonomyEnabled: true, preflightStatus: "passing" }),
        makeProject({
          id: "p2",
          name: "broken",
          autonomyEnabled: true,
          preflightStatus: "failing",
          preflightReason: "no branch protection",
        }),
        makeProject({ id: "p3", name: "unchecked", autonomyEnabled: true, preflightStatus: null }),
        makeProject({ id: "p4", name: "dormant", autonomyEnabled: false }),
      ],
    });

    expect(section(content, "Backlog (ready-for-agent)")).toEqual([
      "armed: 5",
      "broken: 4 — not picked up: preflight is failing",
      "unchecked: 3 — not picked up: preflight has never passed",
      "dormant: 2 — not picked up: autonomy is off for this project",
    ]);
    // And the fleet itself is not claimed to be held by any of it
    expect(section(content, "Autonomous pickup")[0]).toContain("No fleet-wide hold");
  });

  it("distinguishes a drained backlog from one never observed", () => {
    const drained = render({
      backlogByProject: { p1: 0 },
      projects: [makeProject({ id: "p1", name: "interlude" })],
    });
    const unobserved = render({ backlogByProject: null });

    expect(section(drained, "Backlog (ready-for-agent)")).toEqual([
      "No tickets ready-for-agent.",
    ]);
    expect(section(unobserved, "Backlog (ready-for-agent)")).toEqual([
      "Not observed — the tracker is only polled while autonomy is on.",
    ]);
  });
});

describe("renderDailyDigest — spend", () => {
  it("reports the covered day's autonomous spend against the cap", () => {
    const content = render({
      runs: [
        makeRun({ id: "r1", totalCostUsd: 12.5 }),
        makeRun({
          id: "r2",
          totalCostUsd: 7.25,
          status: "merged",
          finishedAt: aug(1, 15),
        }),
        makeRun({
          id: "r-prior-day",
          totalCostUsd: 40,
          claimedAt: jul(31, 9),
          startedAt: jul(31, 9),
          status: "merged",
          finishedAt: jul(31, 12),
        }),
        makeRun({
          id: "r-this-morning",
          totalCostUsd: 60,
          claimedAt: aug(2, 2), // claimed before send but after the window
          startedAt: aug(2, 2),
        }),
      ],
      projects: [makeProject({ id: "proj-1" })],
    });

    expect(section(content, "Spend")).toEqual(["$19.75 of $500.00 daily cap"]);
  });

  it("calls out a cap breach", () => {
    const content = render({
      dailyCapUsd: 500,
      runs: [
        makeRun({
          id: "r1",
          totalCostUsd: 512.34,
          status: "merged",
          finishedAt: aug(1, 21),
        }),
      ],
      projects: [makeProject({ id: "proj-1" })],
    });

    expect(section(content, "Spend")).toEqual([
      "$512.34 of $500.00 daily cap — cap hit, pickup was paused",
    ]);
  });
});

describe("renderDailyDigest — busy sections", () => {
  it("caps a section at 8 lines and names how many were folded", () => {
    const content = render({
      projects: [makeProject({ id: "p1", name: "lemons" })],
      runs: Array.from({ length: 10 }, (_, i) =>
        makeRun({
          id: `r${i}`,
          projectId: "p1",
          githubIssue: `o/r#${i + 1}`,
          status: "merged",
          totalCostUsd: 1,
          finishedAt: aug(1, 10),
        })
      ),
    });

    const lines = section(content, "Completed yesterday");
    expect(lines).toHaveLength(9);
    expect(lines[8]).toBe("…and 2 more");
  });
});

describe("renderDailyDigest — title", () => {
  it("names the covered day under the stable prefix the dedup check keys on", () => {
    const content = render();

    expect(content.title).toBe("Daily digest — Sat 1 Aug");
    expect(content.title.startsWith(DIGEST_TITLE_PREFIX)).toBe(true);
  });
});
