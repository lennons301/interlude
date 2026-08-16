import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { renderMarkdown } from "../markdown";

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

  it("renders a blockquote — the transcript's one structural device", () => {
    const html = renderMarkdown("> **Recommendation**\n>\n> ship it");

    expect(html).toContain("<blockquote>");
    expect(html).toContain("<strong>Recommendation</strong>");
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

  it("the stylesheet pulls nothing from a CDN", () => {
    const css = readFileSync(
      path.join(process.cwd(), "src/app/globals.css"),
      "utf8"
    );

    expect(css).not.toMatch(/@import\s+(url\()?["']?https?:/);
    expect(css).not.toMatch(/url\(\s*["']?https?:/);
  });
});
