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
