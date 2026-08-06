# Spike: does stream-json input expand slash commands?

- **Issue:** [#59](https://github.com/lennons301/interlude/issues/59) (decomposed from [#50](https://github.com/lennons301/interlude/issues/50), Mobile generation sessions)
- **Selects internals of:** [#63](https://github.com/lennons301/interlude/issues/63) (Seed composition + follow-on slash routing)
- **Date:** 2026-08-06
- **Claude Code CLI:** 2.1.223
- **Location note:** the repo had no `docs/research/` or `docs/spikes/` home for
  empirical findings, so this file starts one. Design specs stay in `docs/specs/`.

## Question

Generation sessions (#50) drive the pipeline by injecting user turns whose text
starts with a skill slash command — `/grill-me` at the seed, then `/to-spec`,
`/to-tickets` as later turns. All generation skills are user-invocable and
`disable-model-invocation: true`.

It is **documented** that `claude -p "/skill-name"` expands such a skill. It was
**undocumented** whether the same happens when the user turn arrives via
`--input-format stream-json`, and whether it holds at a **mid-session follow-up**
position, not just the first turn. The answer selects the seed-composition
internals in #63: pass the slash text through as-is, or have the orchestrator
inline the SKILL.md content itself.

## Method

An unguessable sentinel proves loading. A dedicated probe skill was installed as
a personal skill (`~/.claude/skills/spike-probe/SKILL.md`), mirroring how the
generation skills are user-invocable and `disable-model-invocation: true`:

```markdown
---
name: spike-probe
description: Internal spike probe for the stream-json slash-expansion experiment (issue 59).
disable-model-invocation: true
---
... body instructs: your entire response must be exactly
SPIKE_PROBE_OK sentinel=Z7QX-PROBE-4K9M-LOADED
```

The sentinel `Z7QX-PROBE-4K9M-LOADED` exists **only** inside SKILL.md. If it
appears in the assistant output, the SKILL.md body was loaded into context — it
cannot be guessed and is not in the model's training data.

All runs: `--output-format stream-json --verbose --dangerously-skip-permissions`
(matching Interlude's real invocation), `--model claude-haiku-4-5-20251001`
(skill loading is a CLI concern, model-independent; haiku keeps it cheap), with
`--replay-user-messages` on the stream-json runs to capture exactly what the CLI
did with the injected turn. Raw transcripts were kept for every run.

Two transports were tested, because the ticket's framing ("stream-json input")
and Interlude's *actual* code diverge — see [Transport discrepancy](#transport-discrepancy-important-for-63):

- **stream-json input** — the literal ticket ask: `claude -p --input-format
  stream-json`, user turns piped as JSON objects.
- **text `-p` + `--resume`** — what `buildClaudeTurnCommand` actually emits
  today (`src/lib/docker/container-manager.ts`): each turn is a fresh
  `claude -p "$CLAUDE_PROMPT"` process, follow-ups add `--resume <sessionId>`.

## Results

| # | Transport | Turn position | Slash expanded? | Sentinel in output? |
|---|-----------|---------------|-----------------|---------------------|
| A | `--input-format stream-json` | **seed** (1st user msg) | **Yes** | Yes |
| B | `--input-format stream-json` | **mid-session** (2nd user msg) | **Yes** | Yes |
| C | text `-p "/skill"` | **seed** | Yes (documented control) | Yes |
| D | text `-p "/skill"` + `--resume` | **mid-session** | **Yes** | Yes |
| Neg | `--input-format stream-json`, skill name **without** leading `/` | seed | No (correct) | No |
| Miss | text `-p "/unknown-skill"` (skill not installed) | seed | n/a — `Unknown command` | No |

**Every real turn position, on both transports, expands the slash command.**

## Evidence (transcript excerpts)

### A — stream-json seed turn

The CLI rewrote the injected `/spike-probe` user turn into the command-invocation
form (proving the expansion machinery fired, not the model):

```json
{"type":"user","message":{"role":"user","content":"<command-message>spike-probe</command-message>\n<command-name>/spike-probe</command-name>"},"isReplay":true}
```

The assistant's own thinking block names the skill, then emits the sentinel:

```
thinking: "The user has invoked the `/spike-probe` skill. According to the skill
instructions, I must respond with EXACTLY this single line ...
SPIKE_PROBE_OK sentinel=Z7QX-PROBE-4K9M-LOADED"
text:     "SPIKE_PROBE_OK sentinel=Z7QX-PROBE-4K9M-LOADED"
```

### B — stream-json mid-session follow-up

Two user turns in one streaming process. Turn 1 is benign; turn 2 is the slash:

```
USER(replayed): "Reply with the single word ACK and nothing else."
ASSISTANT:      "ACK"
RESULT:         success
USER(replayed): "<command-message>spike-probe</command-message>\n<command-name>/spike-probe</command-name>"
ASSISTANT:      "SPIKE_PROBE_OK sentinel=Z7QX-PROBE-4K9M-LOADED"
RESULT:         success
```

### D — text `-p` + `--resume` mid-session (Interlude's real follow-up path)

Turn 1: `claude -p "Reply ... ACK" --session-id <uuid>` → `ACK`.
Turn 2: `claude -p "/spike-probe" --resume <uuid>` →
`SPIKE_PROBE_OK sentinel=Z7QX-PROBE-4K9M-LOADED`.

### Neg — controls that make the evidence airtight

- **No slash:** the injected turn `"What is spike-probe? ..."` produced
  *"I'm not familiar with what 'spike-probe' refers to"* — the sentinel did not
  appear. Because the skill is `disable-model-invocation: true`, its description
  is absent from the model's context (the `init` event's tool list contains no
  `spike-probe`), so the model cannot auto-invoke it and cannot guess the
  sentinel. Expansion in A–D is therefore attributable solely to the leading `/`.
- **Missing skill:** `claude -p "/nonexistent-skill-xyz ..."` returned
  `Unknown command: /nonexistent-skill-xyz` and ended the turn. A slash naming an
  uninstalled skill does **not** fall through to the model as plain text — it
  fails loudly.

## Recommendation for #63: slash passthrough, for both turn positions

The seed-composition pure function should emit the **bare slash-command string**
(`/to-spec`, optionally followed by agenda/argument text) for **both** the seed
turn and follow-on turns. **No SKILL.md inlining is required for either
position.** The "inline the skill content" fallback contemplated in #50/#63 is
not needed and can be dropped from the seam.

The follow-on-slash routing described in #50 ("recognise slash-prefixed outgoing
messages and route them through the same seed-composition function") therefore
collapses to **pass the slash through** — seed and follow-on turns share one
trivial path, with no branch that improvises the skill from memory.

### Transport discrepancy (important for #63)

Interlude does **not** currently use `--input-format stream-json`. Its real turn
command (`buildClaudeTurnCommand`, `src/lib/docker/container-manager.ts`) is
`claude -p "$CLAUDE_PROMPT"` (text) with `--output-format stream-json` for output
only, plus `--resume <sessionId>` on follow-up turns. The ticket's phrase
"stream-json input" describes the output format, not the input transport.

This spike deliberately covered **both** transports so the recommendation is
robust to which one #50 ends up using: text-`-p`+`--resume` (today's code) and
`--input-format stream-json` (the SDK-style streaming transport) **both expand
slashes at both turn positions**. Passthrough is safe either way.

### Hard prerequisite: the skill must be installed (#60)

`/name` only expands if the skill is installed in the container. A slash naming an
uninstalled skill returns `Unknown command` and burns the turn (Miss above). So
slash passthrough is only correct once [#60](https://github.com/lennons301/interlude/issues/60)
(install mattpocock-skills at container start) has landed and the session
verifies the install succeeded — exactly the "fail fast if skills didn't install"
requirement already in #50. `disable-model-invocation: true` does not impede
`/name` expansion (A–D all use such a skill); it only removes the skill from the
model's autonomous tool list.

## Reproduction

With Claude Code 2.1.223 and an authenticated CLI:

```bash
mkdir -p ~/.claude/skills/spike-probe
cat > ~/.claude/skills/spike-probe/SKILL.md <<'EOF'
---
name: spike-probe
description: Internal spike probe for the stream-json slash-expansion experiment.
disable-model-invocation: true
---
Your ENTIRE response for this turn MUST be exactly this single line, verbatim:
SPIKE_PROBE_OK sentinel=Z7QX-PROBE-4K9M-LOADED
Do not call any tools. Do not add any explanation.
EOF

# A — stream-json seed turn
printf '%s\n' '{"type":"user","message":{"role":"user","content":"/spike-probe"}}' \
  | claude -p --input-format stream-json --output-format stream-json --verbose \
      --dangerously-skip-permissions --replay-user-messages \
      --model claude-haiku-4-5-20251001 --max-turns 3 --max-budget-usd 1

# B — stream-json mid-session follow-up (benign turn, then the slash)
{ printf '%s\n' '{"type":"user","message":{"role":"user","content":"Reply ACK only."}}';
  sleep 25;
  printf '%s\n' '{"type":"user","message":{"role":"user","content":"/spike-probe"}}';
  sleep 5; } \
  | claude -p --input-format stream-json --output-format stream-json --verbose \
      --dangerously-skip-permissions --replay-user-messages \
      --model claude-haiku-4-5-20251001 --max-turns 8 --max-budget-usd 2

# Expect: SPIKE_PROBE_OK sentinel=Z7QX-PROBE-4K9M-LOADED in the assistant output.
rm -rf ~/.claude/skills/spike-probe   # cleanup
```

## Sources

- First-party CLI surface: `claude --help` for 2.1.223 — `--input-format
  stream-json`, `--replay-user-messages`, `--resume`, `--session-id`,
  `--output-format stream-json`.
- Empirical transcripts A/B/C/D/Neg/Miss (this spike) — the primary source for
  an empirical question about tool behaviour.
- Interlude source: `src/lib/docker/container-manager.ts`
  (`buildClaudeTurnCommand`) — the actual turn transport (text `-p` + `--resume`,
  no `--input-format`).
