import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { SESSION_SKILLS } from "@/db/schema";

const HASH_LABEL = "co.interlude.agent-dockerfile-sha256";

// The hash the real Dockerfile.agent on disk should produce — computed exactly
// the way the module under test does, so the "fresh" cases carry a genuinely
// matching label rather than a hard-coded string that could drift.
const realHash = createHash("sha256")
  .update(readFileSync(path.join(process.cwd(), "Dockerfile.agent")))
  .digest("hex");

// Mutable fake Docker, reconfigured per test via `state.inspect`.
const { state, buildImageSpy } = vi.hoisted(() => ({
  state: {
    inspect: async (): Promise<unknown> => ({ Config: { Labels: {} } }),
  },
  buildImageSpy: vi.fn(async (): Promise<unknown> => "BUILD_STREAM"),
}));

vi.mock("@/lib/docker/client", () => ({
  getDocker: () => ({
    getImage: () => ({ inspect: () => state.inspect() }),
    buildImage: buildImageSpy,
    modem: {
      followProgress: (_stream: unknown, onFinished: (err: unknown) => void) =>
        onFinished(null),
    },
  }),
}));

// Keep the build hermetic: no real tar stream off the filesystem. The Dockerfile
// is still read for real by node:fs/promises, which is what yields realHash.
vi.mock("tar-fs", () => ({ pack: () => "TAR_STREAM" }));

import {
  ensureImage,
  buildImage,
  imageExists,
  imageSkillsRef,
  SKILLS_REF_LABEL,
} from "../image-builder";

const missing = async (): Promise<never> => {
  throw new Error("no such image: interlude-agent:latest");
};

beforeEach(() => {
  buildImageSpy.mockClear();
  state.inspect = async () => ({ Config: { Labels: {} } });
});

describe("ensureImage", () => {
  it("builds when the image is missing", async () => {
    state.inspect = missing;
    await ensureImage();
    expect(buildImageSpy).toHaveBeenCalledTimes(1);
  });

  it("rebuilds when the stamped Dockerfile hash no longer matches (issue #78)", async () => {
    state.inspect = async () => ({ Config: { Labels: { [HASH_LABEL]: "stale" } } });
    await ensureImage();
    expect(buildImageSpy).toHaveBeenCalledTimes(1);
  });

  it("skips the build when the stamped hash matches the on-disk Dockerfile", async () => {
    state.inspect = async () => ({ Config: { Labels: { [HASH_LABEL]: realHash } } });
    await ensureImage();
    expect(buildImageSpy).not.toHaveBeenCalled();
  });

  it("rebuilds an existing but unstamped image (manual/old build)", async () => {
    state.inspect = async () => ({ Config: { Labels: null } });
    await ensureImage();
    expect(buildImageSpy).toHaveBeenCalledTimes(1);
  });
});

describe("buildImage", () => {
  it("stamps the current Dockerfile hash as a label on interlude-agent:latest", async () => {
    await buildImage();
    expect(buildImageSpy).toHaveBeenCalledTimes(1);
    // `.mock.calls` carries no argument types for a no-arg fake, so reach the
    // build options through `unknown`.
    const [, opts] = buildImageSpy.mock.calls[0] as unknown as [
      unknown,
      { t: string; dockerfile: string; labels: Record<string, string> },
    ];
    expect(opts.t).toBe("interlude-agent:latest");
    expect(opts.dockerfile).toBe("Dockerfile.agent");
    expect(opts.labels[HASH_LABEL]).toBe(realHash);
  });
});

describe("imageExists", () => {
  it("is true when the image inspects and false when it does not", async () => {
    state.inspect = async () => ({ Config: { Labels: {} } });
    expect(await imageExists()).toBe(true);
    state.inspect = missing;
    expect(await imageExists()).toBe(false);
  });
});

describe("imageSkillsRef (issue #215)", () => {
  it("reads the pinned skills ref off the image's label", async () => {
    state.inspect = async () => ({
      Config: { Labels: { [HASH_LABEL]: realHash, [SKILLS_REF_LABEL]: "v1.2.3" } },
    });
    expect(await imageSkillsRef()).toBe("v1.2.3");
  });

  it("is null for an image built before the label existed", async () => {
    state.inspect = async () => ({ Config: { Labels: { [HASH_LABEL]: "old" } } });
    expect(await imageSkillsRef()).toBeNull();
  });

  it("is null when the image is absent", async () => {
    state.inspect = missing;
    expect(await imageSkillsRef()).toBeNull();
  });
});

const dockerfile = readFileSync(path.join(process.cwd(), "Dockerfile.agent"), "utf8");

/** The Dockerfile's instructions alone — its comments explain what they replaced,
 * so a "never runs X" assertion has to read past them. */
const instructions = dockerfile
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("#"))
  .join("\n");

/** The value of a single-line `ARG NAME=value` in the Dockerfile, unquoted. */
function buildArg(name: string): string | undefined {
  const match = new RegExp(`^ARG ${name}=(.*)$`, "m").exec(dockerfile);
  return match?.[1].replace(/^"(.*)"$/, "$1");
}

describe("Dockerfile.agent contents (issue #60)", () => {
  it("installs the GitHub CLI so generation-session skills can drive the tracker", () => {
    expect(dockerfile).toContain("install -y --no-install-recommends gh");
    expect(dockerfile).toContain("https://cli.github.com/packages");
  });
});

/**
 * Issue #215: the estate's skills reach the image through the open Agent
 * Skills standard, pinned, at build — not through `claude plugin install` at
 * every container setup. The Dockerfile is the one statement of the pin, so
 * these read it as text: what it installs, from where, for whom, and what it
 * refuses to build without.
 */
describe("Dockerfile.agent skills install (issue #215)", () => {
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
    expect(dockerfile).toContain(
      'npx -y "skills@${SKILLS_INSTALLER_VERSION}" add "https://github.com/mattpocock/skills/tree/${SKILLS_REF}"'
    );
    expect(buildArg("SKILLS_INSTALLER_VERSION")).toMatch(/^\d+\.\d+\.\d+$/);
    expect(dockerfile).toMatch(/ -g -y -s '\*' /);
    expect(dockerfile).toContain("-a claude-code");
  });

  it("runs no claude plugin command", () => {
    expect(instructions).not.toContain("claude plugin");
  });

  it("installs as the node user, so global scope is the home the harness reads", () => {
    const install = dockerfile.indexOf('npx -y "skills@');
    expect(install).toBeGreaterThan(-1);
    expect(dockerfile.lastIndexOf("USER node", install)).toBeGreaterThan(-1);
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
    expect(dockerfile).toContain("for skill in ${REQUIRED_SKILLS}; do");
    expect(dockerfile).toContain('test -f "/home/node/.agents/skills/${skill}/SKILL.md"');
    expect(dockerfile).toContain('test -f "/home/node/.claude/skills/${skill}/SKILL.md"');
    expect(dockerfile).toContain("/home/node/.agents/.skill-lock.json");
    expect(dockerfile).toMatch(/= "\$\{SKILLS_REF\}"/);
  });

  it("stamps the pinned ref on the image as a label", () => {
    // From the same build arg the install reads, so the label can never name a
    // ref other than the one installed.
    expect(dockerfile).toContain(`LABEL ${SKILLS_REF_LABEL}=\${SKILLS_REF}`);
  });

  it("rebuilds the image when the pinned ref changes", async () => {
    // The staleness check hashes the whole Dockerfile, so an image stamped with
    // the hash of this Dockerfile *at another ref* is stale by construction.
    const bumped = dockerfile.replace(/^ARG SKILLS_REF=.*$/m, "ARG SKILLS_REF=v0.0.0-other");
    expect(bumped).not.toBe(dockerfile);
    const bumpedHash = createHash("sha256").update(bumped).digest("hex");
    state.inspect = async () => ({ Config: { Labels: { [HASH_LABEL]: bumpedHash } } });
    await ensureImage();
    expect(buildImageSpy).toHaveBeenCalledTimes(1);
  });
});
