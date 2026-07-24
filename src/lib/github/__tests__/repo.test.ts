import { describe, it, expect } from "vitest";
import { parseRepoFromGitUrl } from "../repo";

describe("parseRepoFromGitUrl", () => {
  it("parses https URL with .git suffix", () => {
    expect(parseRepoFromGitUrl("https://github.com/lennons301/test-repo.git")).toEqual({
      owner: "lennons301",
      repo: "test-repo",
    });
  });

  it("parses https URL without .git suffix", () => {
    expect(parseRepoFromGitUrl("https://github.com/lennons301/test-repo")).toEqual({
      owner: "lennons301",
      repo: "test-repo",
    });
  });

  it("parses https URL with trailing slash", () => {
    expect(parseRepoFromGitUrl("https://github.com/lennons301/test-repo/")).toEqual({
      owner: "lennons301",
      repo: "test-repo",
    });
  });

  it("parses ssh scp-style URL", () => {
    expect(parseRepoFromGitUrl("git@github.com:lennons301/test-repo.git")).toEqual({
      owner: "lennons301",
      repo: "test-repo",
    });
  });

  it("returns null for non-github hosts", () => {
    expect(parseRepoFromGitUrl("https://gitlab.com/lennons301/test-repo.git")).toBeNull();
  });

  it("returns null for unparseable input", () => {
    expect(parseRepoFromGitUrl("not a url")).toBeNull();
    expect(parseRepoFromGitUrl("")).toBeNull();
  });
});
