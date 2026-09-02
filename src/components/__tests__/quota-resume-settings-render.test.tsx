import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ResumeBoundView } from "@/lib/settings-resolver";
import { QuotaResumePanel } from "../quota-resume-settings";

/**
 * The quota resume bound as the settings screen shows it (issue #169).
 *
 * The same contract the tier panel is held to — what is in force, where it came
 * from, and what clearing it would fall back to — plus the one thing a *count*
 * field has to say that a tier field does not: with no override and no
 * variable, the number in force comes from a built-in default, and a row that
 * did not say so would be naming a number from nowhere.
 */

function field(over: Partial<ResumeBoundView> = {}): ResumeBoundView {
  return {
    label: "Quota resumes per attempt",
    help: "How many times one attempt may pause on the account's quota.",
    options: ["0", "1", "2", "3", "4", "5"],
    source: "environment",
    override: null,
    envVar: "MAX_RESUMES_PER_ATTEMPT",
    envValue: null,
    resumes: 3,
    ...over,
  };
}

function render(over: Partial<ResumeBoundView> = {}): string {
  return renderToStaticMarkup(
    <QuotaResumePanel
      bound={field(over)}
      busy={false}
      disabled={false}
      saveError={null}
      onChoose={() => {}}
    />
  );
}

describe("the quota settings panel", () => {
  it("offers every allowed count plus the way back to the environment", () => {
    const html = render();

    for (const option of ["0", "1", "2", "3", "4", "5", "environment"]) {
      expect(html).toContain(`>${option}</label>`);
    }
  });

  it("says where an unset field's number actually comes from", () => {
    const html = render();

    expect(html).toContain("3 resumes per attempt (built-in default)");
    expect(html).toContain("from MAX_RESUMES_PER_ATTEMPT unset");
  });

  it("reads an overridden field as this screen's, and names what it would fall back to", () => {
    const html = render({
      source: "override",
      override: "1",
      resumes: 1,
      envValue: "4",
    });

    expect(html).toContain("ui override");
    expect(html).toContain("1 resume per attempt");
    expect(html).toContain("MAX_RESUMES_PER_ATTEMPT = 4, unused");
  });

  it("spells out what zero means, rather than showing a bare 0", () => {
    // Zero is a real choice, and the least self-explanatory one on the row.
    expect(render({ source: "override", override: "0", resumes: 0 })).toContain(
      "no resumes — a quota pause goes straight to a human"
    );
  });

  it("renders nothing to press while the settings are still loading", () => {
    const html = renderToStaticMarkup(
      <QuotaResumePanel
        bound={null}
        busy={false}
        disabled
        saveError={null}
        onChoose={() => {}}
      />
    );

    expect(html).not.toContain("input");
  });
});
