# Workflow: tdd

Test-driven development for an unattended implement pass. Adapted from the
estate's `mattpocock-skills` tdd skill (v1.2.0) for runs where no user is
available to answer questions.

## The loop

TDD is the red → green loop, worked in **vertical slices**: one failing test,
then only enough code to make it pass, then the next slice. Never write all
the tests first and all the implementation after — bulk-written tests verify
imagined behaviour and go insensitive to real changes.

- **Red before green.** Write the failing test first and run it to see it
  fail. Then write only enough code to pass it. Don't anticipate future tests
  or add speculative features.
- **One slice at a time.** One seam, one test, one minimal implementation per
  cycle. Commit each slice.
- **Refactoring is not part of the loop.** Keep the red → green cycle small;
  clean-ups come after the behaviour is pinned.

## Seams — where tests go

A **seam** is the public boundary you test at: the interface where behaviour
is observable without reaching inside. Tests live at seams, never against
internals.

**Test only at seams the ticket confirms.** In an unattended pass there is no
one to confirm a seam with, so the ticket must do it: use the seams named by
the ticket's "Seams under test" section (or equivalently explicit wording in
its acceptance criteria). Do not invent tests at seams the ticket does not
confirm — if critical logic has no confirmed seam, that is a finding to state
in the PR body, not a licence to guess.

## What a good test is

Tests verify behaviour through public interfaces, not implementation details.
A good test reads like a specification — it names a capability, and it
survives refactors because it doesn't care about internal structure.

Avoid these anti-patterns:

- **Implementation-coupled** — mocks internal collaborators, tests private
  methods, or verifies through a side channel. The tell: the test breaks on
  refactor while behaviour hasn't changed.
- **Tautological** — the assertion recomputes the expected value the way the
  code does, so it passes by construction. Expected values come from an
  independent source of truth: a known-good literal, a worked example, the
  ticket itself.
- **Horizontal slicing** — all tests first, then all implementation. Work
  tracer-bullet style instead; let each cycle's learning shape the next test.
