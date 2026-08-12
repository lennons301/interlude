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
    discordGuildId: null,
    projects: [],
    runs: [],
    tasks: [],
    backlogByProject: null,
    needsHumanByProject: null,
    fleetHealth: null,
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
    reviewVerdict: null,
    reviewResult: null,
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
    const content = render({
      backlogByProject: { p1: 2, p2: 5 },
      projects: [
        makeProject({ id: "p1", name: "interlude" }),
        makeProject({ id: "p2", name: "lemons" }),
      ],
    });

    expect(section(content, "Backlog (ready-for-agent)")).toEqual([
      "lemons: 5",
      "interlude: 2",
    ]);
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
