import { describe, it, expect, vi, beforeEach } from "vitest";
import { createDraftPr, findOpenPrForHead } from "../pull-requests";

// Mock the GitHub client so we can drive create/list behaviour per test.
const { reposGet, pullsCreate, pullsList } = vi.hoisted(() => ({
  reposGet: vi.fn(),
  pullsCreate: vi.fn(),
  pullsList: vi.fn(),
}));

vi.mock("@/lib/github/client", () => ({
  isGitHubConfigured: () => true,
  getOctokit: async () => ({
    rest: {
      repos: { get: reposGet },
      pulls: { create: pullsCreate, list: pullsList },
    },
  }),
}));

beforeEach(() => {
  reposGet.mockReset();
  pullsCreate.mockReset();
  pullsList.mockReset();
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
