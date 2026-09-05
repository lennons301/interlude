import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { SESSION_SKILLS } from "@/db/schema";
import { CLAUDE_CODE_IMAGE } from "@/lib/harness/claude-code/image";
import type { HarnessImage } from "@/lib/harness/adapter";

const HASH_LABEL = "co.interlude.agent-dockerfile-sha256";

const sha256 = (contents: string | Buffer) =>
  createHash("sha256").update(contents).digest("hex");

/** The hash a Dockerfile on disk produces — computed exactly the way the module
 * under test does, so the "fresh" cases carry a genuinely matching label rather
 * than a hard-coded string that could drift. */
const hashOf = (dockerfile: string) =>
  sha256(readFileSync(path.join(process.cwd(), dockerfile)));

const BASE_DOCKERFILE = "Dockerfile.agent-base";
const BASE_IMAGE_NAME = "interlude-agent-base:latest";

/** A second adapter's layer (issue #216): a fixture file, so the per-adapter
 * claims below are made over two real layers rather than one under two names. */
const FIXTURE_IMAGE: HarnessImage = {
  name: "interlude-agent-fixture:latest",
  dockerfile: "src/test/fixtures/Dockerfile.agent-fixture",
};

// Mutable fake Docker, reconfigured per test via `state.inspect`, keyed by the
// image reference asked for — the builder now inspects more than one image.
const { state, buildImageSpy } = vi.hoisted(() => ({
  state: {
    inspect: (async () => ({ Config: { Labels: {} } })) as (name: string) => Promise<unknown>,
  },
  buildImageSpy: vi.fn(async (): Promise<unknown> => "BUILD_STREAM"),
}));

vi.mock("@/lib/docker/client", () => ({
  getDocker: () => ({
    getImage: (name: string) => ({ inspect: () => state.inspect(name) }),
    buildImage: buildImageSpy,
    modem: {
      followProgress: (_stream: unknown, onFinished: (err: unknown) => void) =>
        onFinished(null),
    },
  }),
}));

// Keep the build hermetic: no real tar stream off the filesystem. The Dockerfiles
// are still read for real by node:fs/promises, which is what yields the hashes.
vi.mock("tar-fs", () => ({ pack: () => "TAR_STREAM" }));

import {
  AGENT_BASE_IMAGE,
  BASE_IMAGE_BUILD_ARG,
  DOCKERFILE_HASH_LABEL,
  ensureImage,
  imageStamp,
  probeImageBuilt,
  SKILLS_REF_LABEL,
} from "../image-builder";

type BuildOptions = {
  t: string;
  dockerfile: string;
  labels: Record<string, string>;
  buildargs?: Record<string, string>;
};

/** The options of every build asked for, in order. `.mock.calls` carries no
 * argument types for a no-arg fake, so reach them through `unknown`. */
const builds = (): BuildOptions[] =>
  buildImageSpy.mock.calls.map((call) => (call as unknown as [unknown, BuildOptions])[1]);

const missing = async (): Promise<never> => {
  throw new Error("no such image");
};

const labelled = (labels: Record<string, string> | null) => ({ Config: { Labels: labels } });

/** An inspect fake answering per image: names absent from the map are missing. */
function imagesOnDaemon(images: Record<string, Record<string, string> | null>) {
  return async (name: string) =>
    name in images ? labelled(images[name]) : missing();
}

const baseHash = hashOf(BASE_DOCKERFILE);
const claudeStamp = imageStamp(baseHash, hashOf(CLAUDE_CODE_IMAGE.dockerfile));
const fixtureStamp = imageStamp(baseHash, hashOf(FIXTURE_IMAGE.dockerfile));

beforeEach(() => {
  buildImageSpy.mockClear();
  state.inspect = async () => labelled({});
});

describe("the base and the layers", () => {
  it("names the base the layers' Dockerfiles default to", () => {
    expect(AGENT_BASE_IMAGE).toEqual({ name: BASE_IMAGE_NAME, dockerfile: BASE_DOCKERFILE });
    expect(DOCKERFILE_HASH_LABEL).toBe(HASH_LABEL);
    // Each layer's `ARG BASE_IMAGE=` default is the tag the builder passes, so
    // a manual `docker build` after a base build lands on the same base.
    for (const layer of [CLAUDE_CODE_IMAGE.dockerfile, FIXTURE_IMAGE.dockerfile]) {
      const text = readFileSync(path.join(process.cwd(), layer), "utf8");
      expect(text).toContain(`ARG ${BASE_IMAGE_BUILD_ARG}=${BASE_IMAGE_NAME}`);
      expect(text).toContain(`FROM \${${BASE_IMAGE_BUILD_ARG}}`);
    }
  });

  it("is the label the deploy prunes by, so a rename cannot turn that prune into a no-op", () => {
    // The deploy forces a rebuild at the first pass after it lands by pruning
    // every unused image carrying the stamp — the only statement of the label
    // outside this module, and one that fails silently behind `|| true`.
    const deploy = readFileSync(path.join(process.cwd(), ".github", "workflows", "deploy.yml"), "utf8");
    expect(deploy).toContain(`docker image prune -a -f --filter label=${DOCKERFILE_HASH_LABEL}`);
  });

  it("stamps an adapter image with a hash that changes when either file does", () => {
    expect(imageStamp("a", "b")).toBe(imageStamp("a", "b"));
    expect(imageStamp("a", "b")).not.toBe(imageStamp("a2", "b"));
    expect(imageStamp("a", "b")).not.toBe(imageStamp("a", "b2"));
    // Not the base's own stamp: a base image and an adapter image built from an
    // identical layer must never read as current for each other.
    expect(imageStamp("a", "b")).not.toBe("a");
  });
});

describe("ensureImage (issue #216)", () => {
  it("builds the base and then the adapter image when both are missing", async () => {
    state.inspect = missing;
    await ensureImage(CLAUDE_CODE_IMAGE);

    expect(builds().map((b) => b.t)).toEqual([BASE_IMAGE_NAME, CLAUDE_CODE_IMAGE.name]);
    const [base, adapter] = builds();
    expect(base.dockerfile).toBe(BASE_DOCKERFILE);
    expect(base.labels[HASH_LABEL]).toBe(baseHash);
    expect(base.buildargs).toBeUndefined();
    expect(adapter.dockerfile).toBe(CLAUDE_CODE_IMAGE.dockerfile);
    expect(adapter.labels[HASH_LABEL]).toBe(claudeStamp);
    // The layer is told which base to build on — the one just built.
    expect(adapter.buildargs).toEqual({ [BASE_IMAGE_BUILD_ARG]: BASE_IMAGE_NAME });
  });

  it("skips every build when the adapter image's stamp matches both files on disk", async () => {
    const inspected: string[] = [];
    state.inspect = async (name) => {
      inspected.push(name);
      return labelled({ [HASH_LABEL]: claudeStamp });
    };
    await ensureImage(CLAUDE_CODE_IMAGE);

    expect(buildImageSpy).not.toHaveBeenCalled();
    // One round trip on the warm path (issue #151): a current adapter image
    // needs no base, so the base is not even inspected.
    expect(inspected).toEqual([CLAUDE_CODE_IMAGE.name]);
  });

  it("rebuilds only the adapter image when its layer changed and the base is current", async () => {
    const editedLayer = sha256("FROM ${BASE_IMAGE}\nRUN npm install -g @anthropic-ai/claude-code@next\n");
    state.inspect = imagesOnDaemon({
      [BASE_IMAGE_NAME]: { [HASH_LABEL]: baseHash },
      [CLAUDE_CODE_IMAGE.name]: { [HASH_LABEL]: imageStamp(baseHash, editedLayer) },
    });
    await ensureImage(CLAUDE_CODE_IMAGE);

    expect(builds().map((b) => b.t)).toEqual([CLAUDE_CODE_IMAGE.name]);
  });

  it("rebuilds the base and every adapter image when the base changed — the base once", async () => {
    // The daemon as a base edit leaves it: both adapter images stamped against
    // the previous base, and the base itself stamped with its previous hash.
    const previousBase = sha256("FROM node:20-slim\n");
    const daemon: Record<string, Record<string, string> | null> = {
      [BASE_IMAGE_NAME]: { [HASH_LABEL]: previousBase },
      [CLAUDE_CODE_IMAGE.name]: {
        [HASH_LABEL]: imageStamp(previousBase, hashOf(CLAUDE_CODE_IMAGE.dockerfile)),
      },
      [FIXTURE_IMAGE.name]: {
        [HASH_LABEL]: imageStamp(previousBase, hashOf(FIXTURE_IMAGE.dockerfile)),
      },
    };
    state.inspect = imagesOnDaemon(daemon);
    // A build lands on the daemon, as it would: the next inspect sees its stamp.
    buildImageSpy.mockImplementation(async (...args: unknown[]) => {
      const opts = args[1] as BuildOptions;
      daemon[opts.t] = { [HASH_LABEL]: opts.labels[HASH_LABEL] };
      return "BUILD_STREAM";
    });

    await ensureImage(CLAUDE_CODE_IMAGE);
    await ensureImage(FIXTURE_IMAGE);

    // Both adapter images rebuilt; the base rebuilt by the first, found current
    // by the second.
    expect(builds().map((b) => b.t)).toEqual([
      BASE_IMAGE_NAME,
      CLAUDE_CODE_IMAGE.name,
      FIXTURE_IMAGE.name,
    ]);
    expect(builds()[1].labels[HASH_LABEL]).toBe(claudeStamp);
    expect(builds()[2].labels[HASH_LABEL]).toBe(fixtureStamp);
    buildImageSpy.mockImplementation(async () => "BUILD_STREAM");
  });

  it("leaves another adapter's current image alone when one layer changed", async () => {
    const editedFixture = sha256("FROM ${BASE_IMAGE}\nRUN echo changed\n");
    state.inspect = imagesOnDaemon({
      [BASE_IMAGE_NAME]: { [HASH_LABEL]: baseHash },
      [CLAUDE_CODE_IMAGE.name]: { [HASH_LABEL]: claudeStamp },
      [FIXTURE_IMAGE.name]: { [HASH_LABEL]: imageStamp(baseHash, editedFixture) },
    });

    await ensureImage(CLAUDE_CODE_IMAGE);
    await ensureImage(FIXTURE_IMAGE);

    expect(builds().map((b) => b.t)).toEqual([FIXTURE_IMAGE.name]);
  });

  it("rebuilds an existing but unstamped adapter image (manual/old build)", async () => {
    state.inspect = imagesOnDaemon({
      [BASE_IMAGE_NAME]: { [HASH_LABEL]: baseHash },
      [CLAUDE_CODE_IMAGE.name]: null,
    });
    await ensureImage(CLAUDE_CODE_IMAGE);
    expect(builds().map((b) => b.t)).toEqual([CLAUDE_CODE_IMAGE.name]);
  });

  it("rebuilds the base too when it is missing under a stale adapter image", async () => {
    state.inspect = imagesOnDaemon({
      [CLAUDE_CODE_IMAGE.name]: { [HASH_LABEL]: "stale" },
    });
    await ensureImage(CLAUDE_CODE_IMAGE);
    expect(builds().map((b) => b.t)).toEqual([BASE_IMAGE_NAME, CLAUDE_CODE_IMAGE.name]);
  });

  it("does not treat the base's own stamp as a current adapter image", async () => {
    // An adapter image that somehow carries the bare base hash — the stamp a
    // base build writes — is not known to be current on its layer.
    state.inspect = imagesOnDaemon({
      [BASE_IMAGE_NAME]: { [HASH_LABEL]: baseHash },
      [CLAUDE_CODE_IMAGE.name]: { [HASH_LABEL]: baseHash },
    });
    await ensureImage(CLAUDE_CODE_IMAGE);
    expect(builds().map((b) => b.t)).toEqual([CLAUDE_CODE_IMAGE.name]);
  });
});

describe("probeImageBuilt", () => {
  it("answers true for an image the daemon holds and false on a positive 404", async () => {
    state.inspect = async () => labelled({});
    expect(await probeImageBuilt(CLAUDE_CODE_IMAGE.name)).toBe(true);
    state.inspect = async () => {
      throw Object.assign(new Error("no such image"), { statusCode: 404 });
    };
    expect(await probeImageBuilt(CLAUDE_CODE_IMAGE.name)).toBe(false);
  });

  it("throws on anything else, so a caller can tell 'not built' from 'no answer'", async () => {
    state.inspect = async () => {
      throw new Error("connect ENOENT /var/run/docker.sock");
    };
    await expect(probeImageBuilt(CLAUDE_CODE_IMAGE.name)).rejects.toThrow(/ENOENT/);
  });
});

/**
 * Issue #215: `ensureImage` reports the skills ref stamped on the image it
 * leaves in place, off the inspect the staleness check already made — one
 * daemon round trip on the warm path, not a second one for the label. The
 * label is the base Dockerfile's and reaches the adapter image by inheritance.
 */
describe("ensureImage reports the pinned skills ref (issue #215)", () => {
  const fresh = labelled({ [HASH_LABEL]: claudeStamp, [SKILLS_REF_LABEL]: "v1.2.3" });

  it("reads it off a current image without building", async () => {
    state.inspect = async () => fresh;
    expect(await ensureImage(CLAUDE_CODE_IMAGE)).toEqual({ skillsRef: "v1.2.3" });
    expect(buildImageSpy).not.toHaveBeenCalled();
  });

  it("reads it off the image it just rebuilt, not the stale one", async () => {
    let adapterInspects = 0;
    state.inspect = async (name) => {
      if (name === BASE_IMAGE_NAME) return labelled({ [HASH_LABEL]: baseHash });
      return adapterInspects++ === 0
        ? labelled({ [HASH_LABEL]: "stale", [SKILLS_REF_LABEL]: "v1.0.0" })
        : fresh;
    };
    expect(await ensureImage(CLAUDE_CODE_IMAGE)).toEqual({ skillsRef: "v1.2.3" });
    expect(builds().map((b) => b.t)).toEqual([CLAUDE_CODE_IMAGE.name]);
  });

  it("is null when the image carries no skills label", async () => {
    state.inspect = async () => labelled({ [HASH_LABEL]: claudeStamp });
    expect(await ensureImage(CLAUDE_CODE_IMAGE)).toEqual({ skillsRef: null });
  });
});

const base = readFileSync(path.join(process.cwd(), BASE_DOCKERFILE), "utf8");
const claudeLayer = readFileSync(path.join(process.cwd(), CLAUDE_CODE_IMAGE.dockerfile), "utf8");

/** A Dockerfile's instructions alone — its comments explain what they replaced,
 * so a "never runs X" assertion has to read past them. */
const instructionsOf = (dockerfile: string) =>
  dockerfile
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");

/** The value of a single-line `ARG NAME=value` in the base Dockerfile, unquoted. */
function buildArg(name: string): string | undefined {
  const match = new RegExp(`^ARG ${name}=(.*)$`, "m").exec(base);
  return match?.[1].replace(/^"(.*)"$/, "$1");
}

/**
 * Issue #216: the agent Dockerfile is a base plus one layer per adapter. The
 * base carries everything that is not a harness; the Claude Code layer carries
 * exactly the two things the single Dockerfile did for Claude Code — the CLI
 * install and the headless pre-acceptance — so the Claude Code image contains
 * what the single image contained before, and nothing base-shaped names a
 * harness.
 */
describe("the base and the Claude Code layer (issue #216)", () => {
  const baseInstructions = instructionsOf(base);
  const layerInstructions = instructionsOf(claudeLayer);

  it("keeps the base free of any harness", () => {
    // The harness launchers are npm globals, so no global npm install at all
    // belongs in the base; and neither the Claude CLI nor its pre-acceptance.
    expect(baseInstructions).not.toContain("npm install -g");
    expect(baseInstructions).not.toContain("@anthropic-ai");
    expect(baseInstructions).not.toContain("bypassPermissionsModeAccepted");
    expect(baseInstructions).not.toContain(".claude.json");
    // The base still names harnesses in two places, both as *readers* of the
    // skills rather than as things installed: the installer's agent targets,
    // and the `~/.claude` directory the Claude Code links land in.
    expect(base).toContain("-a claude-code -a codex -a opencode");
    expect(baseInstructions).toContain("mkdir -p /home/node/.claude");
  });

  it("carries the tooling every harness needs in the base", () => {
    for (const tool of ["git", "curl", "ca-certificates", "iproute2", "jq"]) {
      expect(baseInstructions).toMatch(new RegExp(`\\b${tool}\\b`));
    }
    expect(baseInstructions).toContain("/usr/local/bin/yq");
    expect(baseInstructions).toContain("install -y --no-install-recommends gh");
    expect(baseInstructions).toContain("corepack prepare pnpm@latest --activate");
    expect(baseInstructions).toContain("mkdir -p /workspace && chown node:node /workspace");
    expect(baseInstructions).toContain("USER node");
    expect(baseInstructions).toContain("WORKDIR /workspace");
  });

  it("installs the Claude CLI and pre-accepts its headless mode in the layer, and nowhere else", () => {
    expect(layerInstructions).toContain("RUN npm install -g @anthropic-ai/claude-code");
    expect(layerInstructions).toContain(
      `RUN echo '{"bypassPermissionsModeAccepted": true}' > /home/node/.claude.json && chown node:node /home/node/.claude.json`
    );
    // Root only for the install; the image ends as the workspace user, as the
    // single image did.
    const root = layerInstructions.indexOf("USER root");
    const install = layerInstructions.indexOf("npm install -g");
    const node = layerInstructions.lastIndexOf("USER node");
    expect(root).toBeGreaterThan(-1);
    expect(install).toBeGreaterThan(root);
    expect(node).toBeGreaterThan(install);
    expect(layerInstructions.trim().endsWith("USER node")).toBe(true);
  });

  it("builds the layer on the base image the builder names", () => {
    expect(layerInstructions).toContain(`ARG ${BASE_IMAGE_BUILD_ARG}=${AGENT_BASE_IMAGE.name}`);
    expect(layerInstructions).toContain(`FROM \${${BASE_IMAGE_BUILD_ARG}}`);
    // Nothing the base already did is repeated in the layer.
    expect(layerInstructions).not.toContain("apt-get");
    expect(layerInstructions).not.toContain("skills");
    expect(layerInstructions).not.toContain("WORKDIR");
  });
});

describe("Dockerfile.agent-base contents (issue #60)", () => {
  it("installs the GitHub CLI so generation-session skills can drive the tracker", () => {
    expect(base).toContain("install -y --no-install-recommends gh");
    expect(base).toContain("https://cli.github.com/packages");
  });
});

/**
 * Issue #215: the estate's skills reach the image through the open Agent
 * Skills standard, pinned, at build — not through `claude plugin install` at
 * every container setup. The base Dockerfile is the one statement of the pin,
 * so these read it as text: what it installs, from where, for whom, and what
 * it refuses to build without.
 */
describe("Dockerfile.agent-base skills install (issue #215)", () => {
  const skillsRef = buildArg("SKILLS_REF");

  it("pins the skills to an explicit ref", () => {
    // A tag, not a branch: `main` would let an upstream release change a pass
    // mid-day, which is the drift this ticket removes.
    expect(skillsRef).toMatch(/^v\d+\.\d+\.\d+$/);
  });

  it("installs them with the Agent Skills installer at global scope for the Claude Code agent", () => {
    // The `/tree/<ref>` URL form is how the installer pins (it has no ref flag),
    // `-g` is global scope, and the installer itself is pinned too so a release
    // of the tool cannot change what the build does.
    expect(base).toContain(
      'npx -y "skills@${SKILLS_INSTALLER_VERSION}" add "https://github.com/mattpocock/skills/tree/${SKILLS_REF}"'
    );
    expect(buildArg("SKILLS_INSTALLER_VERSION")).toMatch(/^\d+\.\d+\.\d+$/);
    expect(base).toMatch(/ -g -y -s '\*' /);
    expect(base).toContain("-a claude-code");
  });

  it("runs no claude plugin command", () => {
    expect(instructionsOf(base)).not.toContain("claude plugin");
    expect(instructionsOf(claudeLayer)).not.toContain("claude plugin");
  });

  it("installs as the node user, so global scope is the home the harness reads", () => {
    const install = base.indexOf('npx -y "skills@');
    expect(install).toBeGreaterThan(-1);
    expect(base.lastIndexOf("USER node", install)).toBeGreaterThan(-1);
  });

  it("requires every schema-declared session skill and every vendored workflow, by name", () => {
    // The capability-contract rule: nothing a session or a `workflow:<skill>`
    // label can name may be absent from the image. The Dockerfile cannot read
    // the schema or the workflows directory at build (its context is itself),
    // so the list is written there and pinned here to both sources — a skill
    // added to either without being listed fails this test, and a listed skill
    // missing from the installed set fails the build.
    const required = buildArg("REQUIRED_SKILLS")?.split(/\s+/).filter(Boolean) ?? [];
    const workflows = readdirSync(path.join(process.cwd(), "docs", "agents", "workflows"))
      .filter((f) => f.endsWith(".md"))
      .map((f) => f.slice(0, -".md".length));
    expect(workflows.length).toBeGreaterThan(0);
    expect([...required].sort()).toEqual([...SESSION_SKILLS, ...workflows].sort());
  });

  it("fails the build when a required skill is missing from the installed set", () => {
    // Asserted where the skills land — the canonical folder, the Claude Code
    // link, and the lock's recorded ref — so an installer that quietly skipped
    // a skill, or resolved a ref other than the pinned one, cannot ship.
    expect(base).toContain("for skill in ${REQUIRED_SKILLS}; do");
    expect(base).toContain('test -f "/home/node/.agents/skills/${skill}/SKILL.md"');
    expect(base).toContain('test -f "/home/node/.claude/skills/${skill}/SKILL.md"');
    expect(base).toContain("/home/node/.agents/.skill-lock.json");
    expect(base).toMatch(/= "\$\{SKILLS_REF\}"/);
  });

  it("stamps the pinned ref on the image as a label", () => {
    // From the same build arg the install reads, so the label can never name a
    // ref other than the one installed — and on the base, so every adapter
    // image inherits it.
    expect(base).toContain(`LABEL ${SKILLS_REF_LABEL}=\${SKILLS_REF}`);
    expect(claudeLayer).not.toContain(SKILLS_REF_LABEL);
  });

  it("rebuilds every adapter image when the pinned ref changes", async () => {
    // The staleness check hashes the whole base file into every adapter's
    // stamp, so an image stamped against this base *at another ref* is stale
    // by construction — as is every other adapter's.
    const bumped = base.replace(/^ARG SKILLS_REF=.*$/m, "ARG SKILLS_REF=v0.0.0-other");
    expect(bumped).not.toBe(base);
    const bumpedBase = sha256(bumped);
    state.inspect = imagesOnDaemon({
      [BASE_IMAGE_NAME]: { [HASH_LABEL]: bumpedBase },
      [CLAUDE_CODE_IMAGE.name]: {
        [HASH_LABEL]: imageStamp(bumpedBase, hashOf(CLAUDE_CODE_IMAGE.dockerfile)),
      },
    });
    await ensureImage(CLAUDE_CODE_IMAGE);
    expect(builds().map((b) => b.t)).toEqual([BASE_IMAGE_NAME, CLAUDE_CODE_IMAGE.name]);
  });
});
