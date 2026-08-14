import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createDraftPr,
  dismissStaleReviewsAsReviewer,
  findOpenPrForHead,
  getPrState,
} from "../pull-requests";

// Mock the GitHub client so we can drive create/list behaviour per test.
const {
  reposGet,
  pullsCreate,
  pullsList,
  pullsGet,
  graphql,
  listReviews,
  dismissReview,
  getAuthenticated,
} = vi.hoisted(() => ({
  reposGet: vi.fn(),
  pullsCreate: vi.fn(),
  pullsList: vi.fn(),
  pullsGet: vi.fn(),
  graphql: vi.fn(),
  listReviews: vi.fn(),
  dismissReview: vi.fn(),
  getAuthenticated: vi.fn(),
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
  // The reviewer identity: a separate client built from REVIEWER_GH_TOKEN, so
  // the PAT never travels with the App's client (and never into a container).
  reviewerOctokit: () => ({
    rest: { pulls: { listReviews, dismissReview } },
    paginate: async (fn: unknown, params: unknown) =>
      (fn as (p: unknown) => Promise<unknown[]>)(params),
  }),
  reviewerLogin: async () => getAuthenticated(),
}));

beforeEach(() => {
  reposGet.mockReset();
  pullsCreate.mockReset();
  pullsList.mockReset();
  pullsGet.mockReset();
  graphql.mockReset();
  listReviews.mockReset();
  dismissReview.mockReset();
  getAuthenticated.mockReset();
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

describe("dismissStaleReviewsAsReviewer (issue #131)", () => {
  const REVIEWED = "d9d06fc1a2b3c4d5e6f708192a3b4c5d6e7f8091";
  const MOVED = "c327f5e19a8b7c6d5e4f302918273645abcdef01";

  beforeEach(() => {
    getAuthenticated.mockResolvedValue("lennons301-reviewer");
    dismissReview.mockResolvedValue({ data: {} });
  });

  it("dismisses the reviewer's own approval left behind by the moved head", async () => {
    listReviews.mockResolvedValue([
      { id: 1, state: "APPROVED", commit_id: REVIEWED, user: { login: "lennons301-reviewer" } },
    ]);

    const dismissed = await dismissStaleReviewsAsReviewer(
      "lennons301",
      "interlude",
      180,
      MOVED,
      "the reviewed commit moved"
    );

    expect(dismissed).toBe(1);
    expect(dismissReview).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: "lennons301",
        repo: "interlude",
        pull_number: 180,
        review_id: 1,
        message: "the reviewed commit moved",
        event: "DISMISS",
      })
    );
  });

  it("never touches a human's review, or its own review of the current head", async () => {
    listReviews.mockResolvedValue([
      // A human's approval is theirs to withdraw, whatever commit it names.
      { id: 1, state: "APPROVED", commit_id: REVIEWED, user: { login: "lennons301" } },
      // Its own, but about the head that exists now — not stale.
      { id: 2, state: "APPROVED", commit_id: MOVED, user: { login: "lennons301-reviewer" } },
      // Comment-only reviews carry no merge weight and cannot be dismissed.
      { id: 3, state: "COMMENTED", commit_id: REVIEWED, user: { login: "lennons301-reviewer" } },
    ]);

    const dismissed = await dismissStaleReviewsAsReviewer(
      "lennons301",
      "interlude",
      180,
      MOVED,
      "the reviewed commit moved"
    );

    expect(dismissed).toBe(0);
    expect(dismissReview).not.toHaveBeenCalled();
  });

  it("reports failure when the reviewer identity cannot be resolved", async () => {
    // No REVIEWER_GH_TOKEN (or a token GitHub won't identify): the loop can
    // neither recognise its own reviews nor withdraw them, so it must not
    // report a clean PR.
    getAuthenticated.mockResolvedValue(null);
    listReviews.mockResolvedValue([]);

    expect(
      await dismissStaleReviewsAsReviewer("lennons301", "interlude", 180, MOVED, "moved")
    ).toBeNull();
    expect(dismissReview).not.toHaveBeenCalled();
  });

  it("reports failure rather than a false clean when GitHub rejects the dismissal", async () => {
    // The caller fails closed on null: a standing approval it could not remove
    // must never be re-armed over.
    listReviews.mockResolvedValue([
      { id: 1, state: "APPROVED", commit_id: REVIEWED, user: { login: "lennons301-reviewer" } },
    ]);
    dismissReview.mockRejectedValue(
      Object.assign(new Error("Forbidden"), { status: 403 })
    );

    expect(
      await dismissStaleReviewsAsReviewer("lennons301", "interlude", 180, MOVED, "moved")
    ).toBeNull();
  });
});
