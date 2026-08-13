import { describe, it, expect, vi, beforeEach } from "vitest";
import { createDraftPr, findOpenPrForHead, getPrState } from "../pull-requests";

// Mock the GitHub client so we can drive create/list behaviour per test.
const { reposGet, pullsCreate, pullsList, pullsGet, graphql } = vi.hoisted(() => ({
  reposGet: vi.fn(),
  pullsCreate: vi.fn(),
  pullsList: vi.fn(),
  pullsGet: vi.fn(),
  graphql: vi.fn(),
}));

vi.mock("@/lib/github/client", () => ({
  isGitHubConfigured: () => true,
  getOctokit: async () => ({
    rest: {
      repos: { get: reposGet },
      pulls: { create: pullsCreate, list: pullsList, get: pullsGet },
    },
    graphql,
  }),
}));

beforeEach(() => {
  reposGet.mockReset();
  pullsCreate.mockReset();
  pullsList.mockReset();
  pullsGet.mockReset();
  graphql.mockReset();
  reposGet.mockResolvedValue({ data: { default_branch: "main" } });
});

const OPTS = {
  owner: "lennons301",
  repo: "interlude",
  title: "Fix issue 8",
  body: "Closes #8",
  head: "agent/issue-8",
};

describe("createDraftPr", () => {
  it("creates a fresh draft PR on the first push", async () => {
    pullsCreate.mockResolvedValue({
      data: { number: 17, html_url: "https://github.com/lennons301/interlude/pull/17" },
    });

    const pr = await createDraftPr(OPTS);

    expect(pr).toEqual({
      number: 17,
      url: "https://github.com/lennons301/interlude/pull/17",
    });
    expect(pr?.adopted).toBeUndefined();
    expect(pullsList).not.toHaveBeenCalled();
  });

  it("adopts the existing open PR when a retry's create is rejected (issue #72)", async () => {
    // A retry that continued agent/issue-8 pushes to a head that already has an
    // open PR; GitHub rejects the second create with 422.
    pullsCreate.mockRejectedValue(
      Object.assign(new Error("Validation Failed"), { status: 422 })
    );
    pullsList.mockResolvedValue({
      data: [{ number: 17, html_url: "https://github.com/lennons301/interlude/pull/17" }],
    });

    const pr = await createDraftPr(OPTS);

    expect(pr).toEqual({
      number: 17,
      url: "https://github.com/lennons301/interlude/pull/17",
      adopted: true,
    });
    // Looked the branch up qualified by owner.
    expect(pullsList).toHaveBeenCalledWith(
      expect.objectContaining({ head: "lennons301:agent/issue-8", state: "open" })
    );
  });

  it("returns null when create fails and no open PR exists for the head", async () => {
    pullsCreate.mockRejectedValue(new Error("network blip"));
    pullsList.mockResolvedValue({ data: [] });

    expect(await createDraftPr(OPTS)).toBeNull();
  });
});

describe("getPrState — check rollup (issue #130)", () => {
  /** The REST half: an open, textually-mergeable PR at head `d9d06fc`. */
  function mockOpenPr(): void {
    pullsGet.mockResolvedValue({
      data: {
        state: "open",
        merged: false,
        auto_merge: null,
        mergeable: true,
        head: { sha: "d9d06fc" },
      },
    });
  }

  /** The GraphQL half: the head commit's rollup contexts. */
  function mockRollup(contexts: unknown[] | null): void {
    graphql.mockResolvedValue({
      repository: {
        pullRequest: {
          commits: {
            nodes: [
              {
                commit: {
                  statusCheckRollup: contexts && { contexts: { nodes: contexts } },
                },
              },
            ],
          },
        },
      },
    });
  }

  const checkRun = (name: string, conclusion: string | null, status = "COMPLETED") => ({
    __typename: "CheckRun",
    name,
    status,
    conclusion,
    detailsUrl: `https://github.com/acme/widgets/runs/${name}`,
  });

  const statusContext = (context: string, state: string) => ({
    __typename: "StatusContext",
    context,
    state,
    targetUrl: `https://vercel.com/${context}`,
  });

  it("returns the head SHA alongside mergeability", async () => {
    mockOpenPr();
    mockRollup([checkRun("Test", "SUCCESS")]);

    const state = await getPrState("acme", "widgets", 180);

    expect(state).toMatchObject({ open: true, mergeable: "mergeable", headSha: "d9d06fc" });
  });

  it("reports a rollup whose every check succeeded as passing", async () => {
    mockOpenPr();
    mockRollup([
      checkRun("Test", "SUCCESS"),
      checkRun("Build", "SKIPPED"),
      statusContext("vercel", "SUCCESS"),
    ]);

    expect((await getPrState("acme", "widgets", 180))?.checks).toEqual({
      state: "passing",
      failed: [],
    });
  });

  it("names the failed checks — check runs and status contexts alike (PR #180)", async () => {
    // The shape that motivated the ticket: a textually-clean merge whose type
    // check fails, and a Vercel StatusContext failing beside it. A skipped or
    // neutral check is not a failure.
    mockOpenPr();
    mockRollup([
      checkRun("Type Check", "FAILURE"),
      checkRun("Lint", "SUCCESS"),
      checkRun("Build", "SKIPPED"),
      statusContext("vercel", "FAILURE"),
    ]);

    expect((await getPrState("acme", "widgets", 180))?.checks).toEqual({
      state: "failing",
      failed: [
        { name: "Type Check", url: "https://github.com/acme/widgets/runs/Type Check" },
        { name: "vercel", url: "https://vercel.com/vercel" },
      ],
    });
  });

  it("reports an unfinished rollup as pending, never failing", async () => {
    mockOpenPr();
    mockRollup([checkRun("Test", null, "IN_PROGRESS"), statusContext("vercel", "PENDING")]);

    expect((await getPrState("acme", "widgets", 180))?.checks).toEqual({
      state: "pending",
      failed: [],
    });
  });

  it("treats a settled failure as failing even while other checks still run", async () => {
    // A failed required check does not un-fail, so the rollup is red now —
    // waiting for the stragglers would only delay the repair.
    mockOpenPr();
    mockRollup([checkRun("Type Check", "FAILURE"), checkRun("Test", null, "IN_PROGRESS")]);

    expect((await getPrState("acme", "widgets", 180))?.checks).toMatchObject({
      state: "failing",
    });
  });

  it("reports `none` when the head commit has no checks at all", async () => {
    mockOpenPr();
    mockRollup(null);

    expect((await getPrState("acme", "widgets", 180))?.checks).toEqual({
      state: "none",
      failed: [],
    });
  });

  it("reports `unknown` when the rollup read fails, keeping mergeability", async () => {
    mockOpenPr();
    graphql.mockRejectedValue(new Error("502 from GitHub"));

    const state = await getPrState("acme", "widgets", 180);

    expect(state).toMatchObject({
      mergeable: "mergeable",
      checks: { state: "unknown", failed: [] },
    });
  });
});

describe("findOpenPrForHead", () => {
  it("returns the single open PR for the head", async () => {
    pullsList.mockResolvedValue({
      data: [{ number: 17, html_url: "https://github.com/lennons301/interlude/pull/17" }],
    });

    expect(await findOpenPrForHead("lennons301", "interlude", "agent/issue-8")).toEqual({
      number: 17,
      url: "https://github.com/lennons301/interlude/pull/17",
    });
  });

  it("returns null when the head has no open PR", async () => {
    pullsList.mockResolvedValue({ data: [] });

    expect(await findOpenPrForHead("lennons301", "interlude", "agent/issue-8")).toBeNull();
  });
});
