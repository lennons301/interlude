import { getOctokit } from "./client";

/**
 * Reading a file from a repo's default branch. `missing` (a 404 or a
 * directory where a file should be) is a real config problem the caller
 * fails closed on; `transient` is an API hiccup worth retrying silently.
 */
export type RepoFileResult =
  | { ok: true; text: string }
  | { ok: false; missing: true }
  | { ok: false; missing: false; reason: string };

/**
 * Fetch one file from a repo's default branch. No `ref` is ever passed:
 * for gate config this is a security property — a PR must not be able to
 * widen its own gates from its head branch.
 */
export async function fetchFileFromDefaultBranch(
  owner: string,
  repo: string,
  path: string
): Promise<RepoFileResult> {
  try {
    const octokit = await getOctokit();
    const { data } = await octokit.rest.repos.getContent({ owner, repo, path });

    if (Array.isArray(data) || data.type !== "file" || typeof data.content !== "string") {
      return { ok: false, missing: true };
    }
    return { ok: true, text: Buffer.from(data.content, "base64").toString("utf8") };
  } catch (err) {
    if ((err as { status?: number }).status === 404) {
      return { ok: false, missing: true };
    }
    return {
      ok: false,
      missing: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}
