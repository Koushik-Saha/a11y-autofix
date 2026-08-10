# a11y-autofix — Plan

An open-source npm CLI that scans React components with axe-core, generates
verified WCAG fix diffs using the Claude API, and re-runs axe-core to confirm
each fix before showing it to the user. No fix is surfaced unless it has been
proven to actually resolve the violation.

## Pipeline

```
detect/  --violations-->  context/  --FixContext-->  generate/  --Patch-->  verify/  --VerificationResult-->  scan()  --ScanResult-->  cli/
   ^                                                                            |                                          |
   |                                                                            |                                          +-> library consumers
   +----------------------- re-run axe-core against the patched component -----+
```

1. **detect/** — Renders the target React component(s) and runs axe-core
   against them. Produces `AxeViolation[]`.
2. **context/** — For a given violation, gathers the source code and any
   related project context (surrounding files, conventions) needed to
   reason about a fix. Produces `FixContext`.
3. **generate/** — Sends the `FixContext` to the Claude API, constrained via
   structured output to return only a replacement for the single located
   JSX element. Produces a `Patch` (`filePath`, `violationId`, `oldSnippet`
   — owned by `context/`'s AST extraction, not generated — and
   `newSnippet`). Output is _unverified_ at this stage.
4. **verify/** — Applies the `Patch` in memory (the file on disk is never
   touched), re-runs `detect/` against both the original and patched source,
   and confirms: (a) the original violation is gone, (b) no new violations
   were introduced. Produces a `VerificationResult` with
   `status: 'verified' | 'unverified'` — an unverified result is returned,
   not discarded, so callers can surface why the patch didn't work.
5. **scan** (`src/scan.ts`) — Orchestrates 1–4 over a file or directory,
   applying verified patches to disk when `write` is requested (never
   unverified ones), and returns a structured `ScanResult`. This is the
   shared core: both `cli/` and the public library API (`import { scan }
from 'a11y-autofix'`) call into it.
6. **cli/** — Renders a `ScanResult` to the terminal as unified diffs plus a
   verified/unverified/errored outcome per violation, and sets the process
   exit code. The only module responsible for user-facing output; it does
   no pipeline work of its own.

## Module boundaries

- `detect/` and `verify/` share the same axe-core execution path — `verify/`
  calls back into `detect/` rather than duplicating axe invocation logic.
- `context/` depends only on `detect/`'s types (an `AxeViolation`).
- `generate/` depends only on `context/`'s types (a `FixContext`) and is the
  only module that talks to the Claude API.
- `scan.ts` is the sole consumer of all four pipeline modules and contains
  all the orchestration logic (including the `write`-to-disk side effect,
  reusing `verify/`'s `applyPatchToSource`) — it does no terminal I/O.
- `cli/` is the sole consumer of `scan.ts` and the only place that does I/O
  with the terminal (diff rendering, `process.exitCode`); it holds no
  pipeline logic of its own.
- `src/index.ts` re-exports the four pipeline modules plus `scan` for
  programmatic (non-CLI) use as a library — this is what
  `import { scan } from 'a11y-autofix'` resolves to, wired via
  `package.json`'s `exports` field.

## Tech choices

- **Language**: TypeScript, strict mode, compiled with `tsc` (CommonJS
  output) to `dist/`.
- **CLI framework**: `commander`.
- **Claude API**: `@anthropic-ai/sdk`.
- **A11y engine**: `axe-core`.
- **Lint/format**: ESLint 9 flat config (`typescript-eslint`) + Prettier,
  with `eslint-config-prettier` disabling stylistic overlap.
- **Dev loop**: `tsx` for running the CLI from source without a build step.
- **Headless rendering**: `jsdom` + `@testing-library/react`, with target
  component files compiled on the fly via `esbuild` (bundled, JSX-transformed
  CJS) so `detect/` can `require` arbitrary `.tsx`/`.jsx` files without the
  caller needing a build step.
- **Tests**: `vitest`.
- **Source parsing**: `ts-morph`, for locating and extracting JSX/TypeScript
  AST nodes in `context/`.
- **Structured output**: `zod` + `@anthropic-ai/sdk`'s `messages.parse()` /
  `zodOutputFormat()` in `generate/`, to constrain the model's response to
  a single typed field rather than parsing free text.

## Status

All modules — `detect/`, `context/`, `generate/`, `verify/`, `scan.ts`, and
`cli/` — are implemented. `npx a11y-autofix` works locally via `npm link`,
and so does `import { scan } from 'a11y-autofix'` (verified from a genuinely
separate consumer project, both CJS `require` and ESM `import`).
`detect/`, `context/`, `verify/`, `scan.ts`, and `cli/` are tested with
vitest; `generate/` isn't (see below).

### Done

- [x] Repo scaffold: `package.json` (with `bin` entry), `tsconfig.json`,
      ESLint flat config, Prettier config, `.gitignore`.
- [x] `src/` structure: `detect/`, `context/`, `generate/`, `verify/`,
      `cli/`, plus `src/index.ts` re-exporting the library API.
- [x] Type contracts between modules (`AxeViolation`, `FixContext`,
      `Patch`, `VerificationResult`) sketched as interfaces.
- [x] `cli/index.ts` stub wired up with `commander` (`--version`, a `scan`
      command placeholder).
- [x] `detect/`: given a component file or directory, compiles it with
      esbuild (bundled, JSX-transformed CJS), renders it into a
      per-call jsdom environment via `@testing-library/react`, and runs
      axe-core against the result (`color-contrast` disabled — it needs
      real layout/canvas, which jsdom can't provide). Tests: `test/detect.test.ts`
      against fixtures in `test/fixtures/` (missing alt text, missing form
      label, a clean control, and a directory scan).
- [x] `context/`: given a violation, parses the component with ts-morph and
      locates the offending JSX element structurally — matching axe's target
      selector's tag name/nth-child/parent against the AST, with the
      violation's raw HTML attributes as a tie-breaker — never by
      string-matching source text. Extracts the element, its immediate JSX
      parent, sibling elements, and (when present) the first typed
      component parameter's prop type. Tests: `test/context.test.ts` runs
      `detectViolations` then `gatherContext` on the real result for three
      fixtures, asserting the located node/parent/siblings/line-number and,
      for `TypedMissingAlt.tsx`, the resolved prop type text. Related-file
      resolution (surrounding files, conventions) is not implemented —
      `relatedFiles` is always `[]`.
- [x] `generate/`: sends the located element (plus parent/siblings/prop
      types as context only) to Claude, with structured output
      (`output_config.format` via `zodOutputFormat`) constraining the
      response to a single `newSnippet` field — the model is never asked to
      reproduce the original element, so `oldSnippet` on the returned
      `Patch` always comes verbatim from `context/`'s AST extraction. Not
      unit-tested — it calls the live Claude API with no mocking layer, and
      this environment has no Anthropic credentials to run it against.
      Verified instead by running the real `detect/` → `context/` →
      `generate/` chain against a fixture and confirming it fails at
      credential resolution (i.e. after full request construction), not at
      any earlier step. Revisit once `verify/` exists and/or credentials are
      available — an integration test that mocks `Anthropic.messages.parse`
      would cover the prompt-building and Patch-assembly logic without a
      live call.
- [x] `verify/`: applies a `Patch` to the component's source in memory
      (`String.prototype.replace`, guarded to require exactly one
      occurrence of `oldSnippet` — otherwise throws rather than guessing
      which occurrence to patch) and re-renders it via `detect/`'s new
      `detectViolationsInSource` (source text in, never touches disk).
      Re-runs both the original and patched source through the same
      pipeline and diffs the two violation sets: `status: 'verified'` only
      when the target rule id is gone from the patched result _and_ no
      violation with a rule id absent from the original set appeared. An
      unresolved patch comes back as `status: 'unverified'` with the
      `remainingViolations`/`newViolations` that prove it — never thrown
      away. Refactored `detect/`'s esbuild compile + jsdom-render + axe-run
      pipeline so both the file-reading path (`detectViolations`) and the
      in-memory path (`detectViolationsInSource`) share one implementation,
      per the module-boundaries rule above. Tests: `test/verify.test.ts`
      covers both the verified and unverified paths (plus a patch that
      doesn't apply cleanly, which throws).
- [x] `scan.ts`: orchestrates detect → context → generate → verify per
      violation for every file at a target path and returns a `ScanResult`
      (`{ targetPath, filesScanned, violations }`). Each entry in
      `violations` is a discriminated union on `status` —
      `'verified' | 'unverified'` entries carry `context`/`patch`/
      `verification`/`applied`; `'errored'` entries (context/generate/verify
      threw — an unfixable JSX node, a Claude API error, a bad patch) carry
      just `error`, and don't abort the rest of the scan. `write: true`
      applies verified fixes to disk immediately per violation, re-reading
      the file fresh each time so multiple fixes to the same file layer
      correctly (reuses `verify/`'s exported `applyPatchToSource` guard,
      not a second copy of that logic); unverified fixes are never written,
      `write` or not. `detect/`'s internal `resolveComponentFiles` is
      exported so this can list a directory's component files and run the
      per-file pipeline against each one (`detectViolations` itself still
      aggregates a whole directory into one flat, file-unattributed
      violation list — fine for its own tests, not enough here). Throws
      only if `targetPath` doesn't exist. Tests: `test/scan.test.ts` mocks
      only `generateFix` (the sole piece needing live Claude credentials)
      and runs the real detect/context/verify pipeline against scratch
      fixture copies — covers verified+applied, unverified+never-written
      (even with `write: true`), verified-but-not-written (`write` unset),
      an errored entry, a directory scan across a violating and a clean
      file, and the nonexistent-path throw.
- [x] `cli/`: reduced to a thin renderer over `scan.ts` — calls `scan()`,
      then prints a unified diff (`--- a/`/`+++ b/`/`@@ ... @@` hunk, using
      `context.element.location.startLine` for the header) and a
      verified/unverified/errored outcome line for every violation, plus a
      summary line. Exit code is 1 whenever a violation is still unresolved
      at the end of the run (everything, in print-only mode;
      unverified/errored only, in `--write` mode). `runScan` is exported
      separately from the `program.parse` call (gated on
      `require.main === module`) so tests can drive it directly. Tests:
      `test/cli.test.ts` (unchanged from before the `scan.ts` extraction —
      still mocks only `generateFix`) confirms the CLI's printed output and
      write behavior are identical post-refactor. Confirmed working end to
      end via the real binary: `npm link` + `npx a11y-autofix scan <path>`
      against both a clean and a violating fixture, and `--version`/`--help`
      on both the top-level command and `scan`.
- [x] Public library API: `import { scan } from 'a11y-autofix'` — same
      `scan.ts` function the CLI calls, just without any printing.
      `package.json` gained an `exports` map (`"."` → `dist/index.d.ts` /
      `dist/index.js`) so the package resolves cleanly for both `require`
      and `import` consumers (verified from a separate scratch project
      linked via `npm link a11y-autofix`, both CJS and ESM). `src/index.ts`
      now re-exports `scan.ts` alongside the four pipeline modules.
      `README.md` documents both the CLI and the programmatic API,
      including the `ScanViolationResult` status table.

- [x] Fixture coverage for the 5 target violation types (2026-08-10):
      added `MissingButtonName.tsx` (`button-name` — icon-only close
      button), `MissingLinkName.tsx` (`link-name` — empty anchor next to a
      heading), `DuplicateLandmarks.tsx` (`landmark-unique` — two unlabeled
      `<nav>`s), and `LowContrastText.tsx` (`color-contrast` — see below).
      Alt text and form labels were already covered by `MissingAlt.tsx` /
      `MissingLabel.tsx`. `test/pipeline-e2e.test.ts` runs the real
      detect → context → verify pipeline (generateFix mocked with a
      hand-authored "ideal" fix per type, same approach as `scan.test.ts`)
      against all 5 and asserts `status: 'verified'` for each — this
      confirms the pipeline _mechanics_ (AST location, patch application,
      re-verification) work for every type, plus an explicit assertion
      that `color-contrast` produces zero violations under the current
      config. See the prompt-quality review below for what this can't
      tell us, and the concrete findings from a static prompt read.
- [x] npm-publish prep (2026-08-10): `package.json` gained `repository`,
      `bugs`, and `homepage` (pointing at the GitHub repo) plus two more
      keywords; `files: ["dist"]` and the `exports` map were already in
      place from earlier work. `npm pack --dry-run` confirmed the tarball
      contains exactly `dist/`, `LICENSE`, `README.md`, and `package.json`
      — nothing from `src/`, `test/`, or the project's own markdown docs
      leaks in. Added root `LICENSE` (MIT) and `CONTRIBUTING.md` (setup,
      dev loop, the pre-PR check list, and a note on how the test suite
      avoids needing live Claude credentials for anything but `generate/`
      itself). Added `.github/workflows/ci.yml`, running
      typecheck/lint/format:check/build/test on every PR and push to
      `main`, matrixed across Node 18.x and 20.x — both versions were
      verified locally first (via `nvm`, in an isolated copy of the repo)
      to confirm the `engines: ">=18"` claim is actually true, not just
      asserted. Rewrote `README.md` to lead with the free-vs-paid framing,
      then install/CLI/programmatic usage, then a detailed "How the verify
      loop works" section — the credibility section — spelling out the
      four pipeline stages and the two conditions (`remainingViolations`
      empty, `newViolations` empty) a fix must clear to be marked
      `verified`, with a pointer to the tests that assert both outcomes.

### Not started

- Remaining `cli/` polish, none of it blocking: colored/richer terminal
  output, a config file for the API key and ignore patterns, and an
  accept/reject prompt for individual fixes (right now `scan --write`
  applies every verified fix unconditionally).

## Open decisions (revisit before implementing)

- Rendering headlessly via jsdom (settled for `detect/`, see Tech choices)
  assumes a single hoisted `react` shared between this package and the
  scanned target. A target with its own separately installed React copy
  could hit a duplicate-React / "invalid hook call" mismatch, since
  `detect/` bundles the target's React via esbuild but renders through this
  package's own `@testing-library/react`. Revisit if/when `verify/` or
  real-world usage against external projects surfaces this — options include
  resolving React relative to the target and requiring version alignment,
  or switching to a real browser via Playwright for higher-fidelity,
  isolated rendering.
- `verify/` requires `Patch.oldSnippet` to occur exactly once in the
  current source and throws otherwise (see Done, above); `cli/`'s
  `--write` step reuses that same exported check
  (`applyPatchToSource`). A component with two structurally-identical
  offending elements (rare, but possible) would still need position-aware
  replacement instead of a plain string match — not implemented.
- `detectViolations` still returns one flat, file-unattributed violation
  list for a directory target (see `cli/`'s Done entry above, which works
  around this by having `cli/` resolve files itself and call
  `detectViolations` once per file instead). Worth revisiting if another
  caller ever needs directory-wide results with per-violation file
  attribution in one call.

## `generate/` prompt-quality review (2026-08-10)

**Caveat up front:** this environment has no Anthropic credentials (no
`ANTHROPIC_API_KEY`, no `ant` profile — same gap noted when `generate/` was
first built), so none of this is from watching the real model's output. The
5-fixture end-to-end test above only proves the pipeline _mechanics_ handle
all 5 types once _some_ fix is proposed — it can't judge whether Claude's
actual proposed text is good. What follows is a static read of
`src/generate/index.ts`'s system prompt and of what context `context/`
does/doesn't hand it, against each violation type's specific needs. Treat
it as a prompt-review starting point, not a benchmark result — re-run this
kind of check for real once credentials are available (`scan --write`
against `test/fixtures/`, eyeballing each generated `newSnippet`).

**1. `color-contrast` — not a prompt problem, it's not reachable at all.**
`detect/` disables this rule outright (jsdom has no canvas/paint
implementation for axe-core to measure against — confirmed empirically:
even a `#cccccc`-on-`#ffffff` fixture produces zero violations). No amount
of prompt tuning in `generate/` touches this, because `context/` and
`generate/` never run for it — `detectViolations` never reports it in the
first place. Fixing this requires a detection-layer change (a real canvas
impl via the `canvas` npm package, or moving to a real browser via
Playwright — see the jsdom limitation noted earlier in this file), not a
`generate/` change. Flagging it here so it isn't mistaken for a
`generate/` weakness later.

**2. `label` — the prompt's own scope rule blocks the more idiomatic fix.**
The system prompt forbids touching anything but the one flagged element
("Do not touch the parent, the siblings, or anything else in the file").
For a bare `<input>` with no label, that leaves exactly one fix shape
available: an `aria-label` (or `aria-labelledby` pointing at an existing
id) on the input itself. The more idiomatic fix most developers would
reach for — a real `<label htmlFor="...">` — requires _adding a sibling
element_, which the current single-element-replacement architecture
structurally cannot do. This isn't a wording problem in the prompt; it's a
scope constraint that rules out the better fix for this one rule. Worth
a decision: either accept `aria-label` as the standing fix for `label`
(defensible — it satisfies WCAG 4.1.2 same as a real `<label>`), or extend
`context`/`generate`/`verify` to support adding a sibling node for this
rule specifically (bigger change, affects the "one element only" guarantee
the rest of the system leans on).

**3. `image-alt` / `button-name` — quality is bounded by what's actually in
context, not by prompt wording.** Both need Claude to _know_ what the
image/button does; the prompt already tells it to use "surrounding
context" and to avoid generic placeholders. The gap is upstream of
`generate/`: `context/` hands over sibling/parent JSX text, but not (a) the
resolved value of a dynamic `src` (e.g. `src={avatarUrl}` — Claude sees the
prop name, never the image), or (b) the implementation of a named event
handler (`onClick={handleDelete}` — Claude sees the identifier, never what
it does). For well-labeled surrounding code (a heading, descriptive prop
names) this is probably fine; for a bare icon button or dynamically-sourced
image with no nearby text, no prompt wording fixes a genuine information
gap. If this turns out to be a real problem in practice, it's a `context/`
scoping question (resolve simple prop values, inline handler bodies) more
than a `generate/` prompt one.

**4. `link-name` — the prompt doesn't distinguish "has an accessible name"
from "is genuinely accessible."** axe-core's `link-name` check (like
`button-name`) only requires _some_ accessible name — an `aria-label` with
empty visible text passes it exactly as well as real link text does. But
an aria-label-only fix is worse in practice: sighted users navigating
without a screen reader see nothing, and it doesn't help SEO or
browser-chrome link lists. The current prompt has no preference between
"add visible text" and "add aria-label" for elements where visible text is
the norm (links, buttons with visible labels elsewhere in the UI). This
is a concrete, cheap prompt-tightening candidate: for `link-name` (and
arguably `button-name` when the button isn't icon-only), prefer adding
real child text over `aria-label` when the fix allows it.

**5. `landmark-unique` — different failure shape than the other four, and
the prompt doesn't say so.** This is the only one of the 5 that's
_relational_: the violation exists because of a pair of elements (two
landmarks with colliding implicit names), not because of anything wrong
with the flagged element in isolation. Confirmed empirically that
uniquely labeling _only_ the flagged element (leaving its sibling landmark
untouched) is sufficient to resolve it — so the single-element-fix
architecture does work here, and `context/` already includes the sibling
landmark in its context block, which should let Claude pick a
non-colliding label. But the prompt never says anything like "you don't
need the sibling to also change" — for a violation that's inherently about
a _pair_, an unguided model could plausibly try to produce a fix that
assumes both landmarks change together, which the architecture doesn't
support. A one-line addition covering relational rules would remove that
ambiguity rather than leaving it to be inferred.

**If tightening the prompt from these findings:** items 2 and 5 are the
sharpest (structural, not just wording) and worth prioritizing; item 4 is
a small, low-risk addition; item 3 needs a `context/` change more than a
`generate/` one; item 1 isn't a `generate/` issue at all. None of this has
been applied to `SYSTEM_PROMPT` yet — reported for a decision, not acted
on unprompted.
