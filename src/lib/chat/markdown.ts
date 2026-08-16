/**
 * The transcript's markdown pipeline (issue #121). An agent turn is a
 * document — headings, lists, tables, fenced code — so it is rendered as one,
 * with GFM and syntax highlighting, in the fleet palette.
 *
 * Self-hosted end to end: unified/remark/rehype and highlight.js are npm
 * dependencies bundled with the app, and the token colours are fleet CSS
 * variables in `globals.css` — no highlighter theme is imported and nothing is
 * fetched from a CDN at build or at runtime.
 *
 * Safety is two independent layers, because agent output is semi-trusted text:
 *
 * 1. `remarkLiteralHtml` turns raw HTML in the source into literal text before
 *    it can become a node. `<script>` is shown, never run — and, just as
 *    importantly for a coding transcript, prose about `<Component>` survives
 *    instead of silently vanishing the way dropped HTML would.
 * 2. `rehype-sanitize` then runs over the tree anyway, on GitHub's default
 *    schema. Markdown can produce dangerous nodes without any raw HTML at all
 *    — `[x](javascript:…)` is a link node — so the allowlist is not redundant
 *    with layer 1, it covers a different attack.
 *
 * Highlighting runs *after* sanitizing on purpose: the schema keeps
 * `class="language-…"` on `<code>` (which is what tells the highlighter the
 * language) and strips everything else, so the only classes in the output are
 * the ones this trusted plugin adds afterwards.
 */

import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import go from "highlight.js/lib/languages/go";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import rehypeHighlight from "rehype-highlight";
import rehypeSanitize from "rehype-sanitize";
import rehypeStringify from "rehype-stringify";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";
import { visit } from "unist-util-visit";

/**
 * The grammars this app's transcripts actually contain, rather than
 * highlight.js's full common set — this ships to the browser, and each
 * unregistered grammar is bundle weight for a language no agent here writes.
 * Aliases (`ts`, `tsx`, `js`, `sh`, `yml`, `py`, `html`) come with the
 * grammars. An unregistered language is not an error: the block renders
 * unhighlighted.
 */
const LANGUAGES = {
  bash,
  css,
  diff,
  dockerfile,
  go,
  javascript,
  json,
  markdown,
  python,
  rust,
  sql,
  typescript,
  xml,
  yaml,
};

/** Layer 1: raw HTML in agent output is text, not markup. */
function remarkLiteralHtml() {
  return (tree: import("mdast").Root) => {
    visit(tree, "html", (node: { type: string }) => {
      node.type = "text";
    });
  };
}

/**
 * The transcript's one structural device is a rule marking a *recommendation*,
 * and the sign-off is explicit that nothing else earns one — "if everything is
 * marked, nothing reads as different". Markdown has no recommendation node, so
 * the marker is the label the agent already writes: a blockquote whose leading
 * heading or bold lead-in says so. Every other blockquote stays unruled.
 *
 * Runs after sanitizing, in the same trusted slot as the highlighter, so the
 * class it adds is not stripped and cannot be spoofed by an attribute in the
 * source — nothing in agent text reaches this element's `className`.
 */
function rehypeRecommendation() {
  return (tree: import("hast").Root) => {
    visit(tree, "element", (node: import("hast").Element) => {
      if (node.tagName !== "blockquote") return;
      if (/recommend/i.test(leadingLabel(node))) {
        node.properties = { ...node.properties, className: ["fleet-recommendation"] };
      }
    });
  };
}

/**
 * The quote's label and nothing else: a leading heading, or a bold lead-in
 * opening its first paragraph. Reading the whole body instead would mark a
 * caveat that merely mentions recommending — the label is the agent saying
 * what the block *is*, which is what the device marks.
 */
function leadingLabel(quote: import("hast").Element): string {
  const lead = quote.children.find(
    (child): child is import("hast").Element => child.type === "element"
  );
  if (!lead) return "";
  if (/^h[1-6]$/.test(lead.tagName)) return textOf(lead);

  if (lead.tagName === "p") {
    const first = lead.children.find(
      (child) => child.type !== "text" || child.value.trim() !== ""
    );
    if (first?.type === "element" && first.tagName === "strong") return textOf(first);
  }
  return "";
}

function textOf(node: import("hast").ElementContent): string {
  if (node.type === "text") return node.value;
  if (node.type === "element") return node.children.map(textOf).join("");
  return "";
}

/** Built once — a unified processor is reusable, and rebuilding it per
 * message would re-register every grammar on every streamed chunk. */
const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkLiteralHtml)
  .use(remarkRehype)
  .use(rehypeSanitize)
  .use(rehypeHighlight, { languages: LANGUAGES, detect: false })
  .use(rehypeRecommendation)
  .use(rehypeStringify);

/** Render one agent turn to sanitized HTML. Synchronous: the transcript
 * re-renders on every streamed message and must not race itself. */
export function renderMarkdown(markdownSource: string): string {
  return String(processor.processSync(markdownSource));
}
