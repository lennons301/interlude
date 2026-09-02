/**
 * Model choice as a **tier** rather than a vendor model identifier (issue
 * #166). A tier is the durable thing the owner actually means — "the expensive
 * one", "the everyday one", "the cheap one" — and it survives a change of
 * provider, which a model id does not. Everything that lets a human express a
 * model choice (the settings UI, a ticket's `model:` directive) speaks tiers;
 * only the last step, reaching the CLI's `--model` flag, speaks ids.
 *
 * A leaf module on purpose. Three surfaces speak the vocabulary — the
 * directive parser, the settings resolver and `config.ts` — and it imports
 * none of them, so all three can share it. (`config.ts` and the settings
 * resolver do reference each other, but only for types, which erase.)
 */

/** The vocabulary, ordered most to least capable — the order the quota degrade
 * ladder (issue #164) will step down. */
export const MODEL_TIERS = ["heavy", "standard", "light"] as const;

export type ModelTier = (typeof MODEL_TIERS)[number];

/**
 * The vendor names the platform used before tiers existed (issue #80's
 * `model:` directive allowlist), kept working as aliases so a ticket already
 * carrying `model: opus` does not break — and so an operator who thinks in
 * Anthropic's names is not made to translate.
 */
export const MODEL_TIER_ALIASES: Readonly<Record<string, ModelTier>> = {
  opus: "heavy",
  sonnet: "standard",
  haiku: "light",
};

/**
 * What a tier means to the harness in force — today, one lane running the
 * Claude Code CLI, whose `--model` flag accepts these short aliases. Issue
 * #164's execution lanes replace this single map with a per-lane one; keeping
 * the mapping in one named place now is what makes that an additive change
 * rather than a hunt.
 */
export const TIER_MODEL_IDS: Readonly<Record<ModelTier, string>> = {
  heavy: "opus",
  standard: "sonnet",
  light: "haiku",
};

/**
 * The tier a written value names, or null if it names none. Accepts a tier or
 * a legacy vendor alias, case-insensitively. Null is not an error at every
 * call site: an env var may legitimately pin a full model id
 * (`claude-opus-4-8`), which names no tier but is still passed through to the
 * CLI verbatim — see the settings resolver.
 */
export function normalizeModelTier(raw: string | null | undefined): ModelTier | null {
  if (raw == null) return null;
  const value = raw.trim().toLowerCase();
  if ((MODEL_TIERS as readonly string[]).includes(value)) return value as ModelTier;
  return MODEL_TIER_ALIASES[value] ?? null;
}

/** The accepted vocabulary, for an error message or a doc line: the tiers
 * first, then the aliases that resolve to them. */
export function describeModelTierVocabulary(): string {
  return (
    `${MODEL_TIERS.join(", ")} ` +
    `(aliases: ${Object.keys(MODEL_TIER_ALIASES).join(", ")})`
  );
}
