import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { REGISTERED_LANGUAGES, renderMarkdown } from "../markdown";

describe("renderMarkdown — GFM", () => {
  it("renders headings and nested lists", () => {
    const html = renderMarkdown("## Options\n\n1. first\n   - nested\n2. second");

    expect(html).toContain("<h2>Options</h2>");
    expect(html).toContain("<ol>");
    expect(html).toContain("<ul>");
    expect(html).toContain("<li>nested</li>");
  });

  it("renders tables", () => {
    const html = renderMarkdown("| a | b |\n| - | - |\n| 1 | 2 |");

    expect(html).toContain("<table>");
    expect(html).toContain("<th>a</th>");
    expect(html).toContain("<td>2</td>");
  });

  it("renders task lists and strikethrough", () => {
    const html = renderMarkdown("- [x] done\n- [ ] todo\n\n~~gone~~");

    expect(html).toContain('type="checkbox"');
    expect(html).toContain("<del>gone</del>");
  });

  it("marks a recommendation — the transcript's one structural device", () => {
    const heading = renderMarkdown("> ### Recommendation\n>\n> ship it");
    const lead = renderMarkdown("> **My recommendation:** ship it");

    expect(heading).toContain('class="fleet-recommendation"');
    expect(heading).toContain("<h3>Recommendation</h3>");
    expect(lead).toContain('class="fleet-recommendation"');
  });

  it("leaves every other quote unmarked, so the mark still means something", () => {
    for (const source of [
      "> just quoting you here",
      "> ### Caveat\n>\n> this is not a recommendation",
      "> ### Options\n>\n> a, b or c",
    ]) {
      const html = renderMarkdown(source);
      expect(html).toContain("<blockquote>");
      expect(html).not.toContain("fleet-recommendation");
    }
  });

  it("cannot be spoofed by a class in the agent's own text", () => {
    const html = renderMarkdown('<blockquote class="fleet-recommendation">nope</blockquote>');

    // The source never becomes an element at all, so it never carries a class.
    expect(html).not.toMatch(/<blockquote/);
  });
});

describe("renderMarkdown — code", () => {
  it("highlights a fenced block in the registered languages", () => {
    const html = renderMarkdown("```ts\nconst x = 1;\n```");

    expect(html).toContain('class="hljs language-ts"');
    expect(html).toContain("hljs-keyword"); // const
    expect(html).toContain("hljs-number"); // 1
  });

  it("highlights aliases the grammars bring with them", () => {
    expect(renderMarkdown("```sh\necho hi\n```")).toContain("hljs-built_in");
    expect(renderMarkdown("```py\nx = 'a'\n```")).toContain("hljs-string");
  });

  /**
   * One snippet per registered grammar. The assertion is deliberately about
   * *whether the grammar ran*, not which token names it chose: a grammar
   * executed on a different highlight.js core than the one it was compiled
   * against throws at render time (issue #150), and only exercising all of them
   * turns that into a test failure instead of a blank code block months later.
   */
  const snippets: Record<(typeof REGISTERED_LANGUAGES)[number], string> = {
    bash: 'echo "hi"',
    css: "a { color: red; }",
    diff: "@@ -1 +1 @@\n-old\n+new",
    dockerfile: "FROM node:24",
    go: "package main",
    javascript: "const x = 1;",
    json: '{ "a": 1 }',
    markdown: "# heading",
    python: "def f():\n    pass",
    rust: "fn main() {}",
    sql: "SELECT 1;",
    typescript: "const x: number = 1;",
    xml: '<a href="x">y</a>',
    yaml: "a: 1",
  };

  it("covers every grammar the pipeline registers", () => {
    expect(Object.keys(snippets).sort()).toEqual([...REGISTERED_LANGUAGES].sort());
  });

  for (const language of REGISTERED_LANGUAGES) {
    it(`runs the ${language} grammar`, () => {
      const html = renderMarkdown(`\`\`\`${language}\n${snippets[language]}\n\`\`\``);

      expect(html).toContain(`class="hljs language-${language}"`);
      expect(html).toMatch(/<span class="hljs-/);
    });
  }

  it("leaves an unregistered language unhighlighted instead of failing", () => {
    const html = renderMarkdown("```brainfuck\n+++.\n```");

    expect(html).toContain("<code");
    expect(html).toContain("+++.");
    expect(html).not.toContain("hljs-keyword");
  });

  it("does not guess a language for an unlabelled block", () => {
    const html = renderMarkdown("```\nplain text\n```");

    expect(html).toContain("plain text");
    expect(html).not.toContain("hljs-");
  });

  it("keeps inline code", () => {
    expect(renderMarkdown("use `pnpm test`")).toContain("<code>pnpm test</code>");
  });
});

describe("renderMarkdown — sanitization", () => {
  /**
   * "Inert" here means no live markup reaches the DOM. Raw HTML is escaped to
   * literal text, so `onerror=` can legitimately still be *visible* in the
   * output — as characters in a text node, never as an attribute. So each case
   * asserts on markup: which tags must not exist, and (for the cases markdown
   * itself can produce, like a link URL) which values must be gone entirely.
   */
  const inert: Array<{
    name: string;
    source: string;
    noTags?: string[];
    noText?: string[];
  }> = [
    {
      name: "a script tag is shown as text, never executed",
      source: "before\n\n<script>alert(1)</script>\n\nafter",
      noTags: ["script"],
    },
    {
      name: "an inline event handler cannot survive",
      source: 'an <img src="x" onerror="alert(1)"> image',
      noTags: ["img"],
    },
    {
      name: "an iframe cannot survive",
      source: '<iframe src="https://evil.example"></iframe>',
      noTags: ["iframe"],
    },
    {
      name: "a javascript: link is stripped by the allowlist",
      source: "[click](javascript:alert(1))",
      noText: ["javascript:"],
    },
    {
      name: "a data: image URL is stripped by the allowlist",
      source: "![x](data:text/html;base64,PHNjcmlwdD4=)",
      noText: ["data:text/html"],
    },
    {
      name: "a style attribute smuggled in raw HTML cannot survive",
      source: '<div style="position:fixed;inset:0">covered</div>',
      noTags: ["div"],
    },
    {
      name: "a style element cannot survive",
      source: "<style>body{display:none}</style>",
      noTags: ["style"],
    },
  ];

  for (const testCase of inert) {
    it(testCase.name, () => {
      const html = renderMarkdown(testCase.source);
      for (const tag of testCase.noTags ?? []) {
        expect(html).not.toMatch(new RegExp(`</?${tag}[\\s>/]`, "i"));
      }
      for (const needle of testCase.noText ?? []) {
        expect(html).not.toContain(needle);
      }
    });
  }

  it("shows raw HTML as literal text so nothing silently disappears", () => {
    const html = renderMarkdown("wrap it in a <Component> like so");

    expect(html).toContain("&#x3C;Component>");
    expect(html).not.toContain("<Component>");
  });

  it("keeps the whole script source visible as text", () => {
    const html = renderMarkdown("<script>alert(1)</script>");

    expect(html).toContain("alert(1)");
    expect(html).not.toContain("<script");
  });

  it("carries no attacker-chosen class onto a real element", () => {
    const html = renderMarkdown('# hi\n\n<p class="evil">x</p>');

    expect(html).toContain("<h1>hi</h1>");
    expect(html).not.toMatch(/<p[^>]*class=/);
  });
});

describe("self-hosted pipeline", () => {
  it("renders without reaching the network — no remote URL in the output", () => {
    const html = renderMarkdown("```ts\nconst x = 1;\n```\n\n# heading");

    expect(html).not.toMatch(/https?:\/\//);
  });

  /**
   * The grammars are imported straight from `highlight.js`; `rehype-highlight`
   * runs them on the core its own `lowlight` resolves. Two cores in the tree is
   * a runtime-only failure with no compile-time signal (issue #150), so the
   * invariant is asserted where it is actually recorded — the lockfile.
   */
  it("resolves exactly one highlight.js core", () => {
    const lock = readFileSync(
      path.join(process.cwd(), "pnpm-lock.yaml"),
      "utf8"
    );
    const cores = new Set(
      [
        // Package entries: `  highlight.js@11.11.2:`
        ...lock.matchAll(/^ {2}highlight\.js@([^:\s]+):/gm),
        // Resolved edges, i.e. lowlight's: `      highlight.js: 11.11.2`
        ...lock.matchAll(/^\s+highlight\.js: (\S+)$/gm),
      ].map((match) => match[1])
    );

    // One entry, so: the lockfile does mention it (a drifted regex fails here)
    // and every dependant resolves the same core.
    expect([...cores]).toHaveLength(1);
  });

  it("the stylesheet pulls nothing from a CDN", () => {
    const css = readFileSync(
      path.join(process.cwd(), "src/app/globals.css"),
      "utf8"
    );

    expect(css).not.toMatch(/@import\s+(url\()?["']?https?:/);
    expect(css).not.toMatch(/url\(\s*["']?https?:/);
  });
});
