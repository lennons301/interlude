/**
 * The working directory every agent pass runs in: where setup clones the
 * project and where each turn's command starts.
 *
 * A leaf with no imports, because three things must agree on it and sit on
 * different sides of the harness seam: the container manager's setup and push
 * scripts clone into and run from it; a harness adapter's command starts in
 * it; and the turn manager hands it to the adapter as the `cwd` its session
 * artefact paths derive from (`sessionArtifactPaths(sessionId, cwd)`, issues
 * #169, #217) — so the paths a pause copies out are for the directory the pass
 * actually worked in.
 */
export const AGENT_WORKDIR = "/workspace/repo";
