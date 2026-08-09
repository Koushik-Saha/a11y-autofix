# a11y-autofix — Plan

An open-source npm CLI that scans React components with axe-core, generates
verified WCAG fix diffs using the Claude API, and re-runs axe-core to confirm
each fix before showing it to the user. No fix is surfaced unless it has been
proven to actually resolve the violation.

## Pipeline

```
detect/  --violations-->  context/  --FixContext-->  generate/  --FixDiff-->  verify/  --VerificationResult-->  cli/
   ^                                                                              |
   |                                                                              |
   +------------------------- re-run axe-core against the patched component -----+
```

1. **detect/** — Renders the target React component(s) and runs axe-core
   against them. Produces `AxeViolation[]`.
2. **context/** — For a given violation, gathers the source code and any
   related project context (surrounding files, conventions) needed to
   reason about a fix. Produces `FixContext`.
3. **generate/** — Sends the `FixContext` to the Claude API and gets back a
   proposed patch plus a plain-language explanation. Produces `FixDiff`.
   Output is _unverified_ at this stage.
4. **verify/** — Applies the `FixDiff` to a scratch copy of the component,
   re-runs `detect/` against it, and confirms: (a) the original violation is
   gone, (b) no new violations were introduced. Produces
   `VerificationResult`. Only `passed: true` results are shown to the user.
5. **cli/** — Wires the above into commands (`scan`, ...), and is the only
   module responsible for user-facing output and prompts.

## Module boundaries

- `detect/` and `verify/` share the same axe-core execution path — `verify/`
  calls back into `detect/` rather than duplicating axe invocation logic.
- `context/` depends only on `detect/`'s types (an `AxeViolation`).
- `generate/` depends only on `context/`'s types (a `FixContext`) and is the
  only module that talks to the Claude API.
- `cli/` is the sole consumer of all four modules and the only place that
  does I/O with the terminal (prompts, diff rendering, colors).
- `src/index.ts` re-exports the four pipeline modules for programmatic
  (non-CLI) use as a library.

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

## Status

`detect/` and `context/` are implemented and tested. `generate/` and
`verify/` still throw `Not implemented`.

### Done

- [x] Repo scaffold: `package.json` (with `bin` entry), `tsconfig.json`,
      ESLint flat config, Prettier config, `.gitignore`.
- [x] `src/` structure: `detect/`, `context/`, `generate/`, `verify/`,
      `cli/`, plus `src/index.ts` re-exporting the library API.
- [x] Type contracts between modules (`AxeViolation`, `FixContext`,
      `FixDiff`, `VerificationResult`) sketched as interfaces.
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

### Not started

- [ ] `generate/`: prompt design for Claude, diff parsing/formatting.
- [ ] `verify/`: apply a diff to a scratch copy, re-invoke `detect/`,
      compare before/after violation sets.
- [ ] `cli/`: real `scan` command output (diff rendering, accept/reject
      prompt), config file support (API key, ignore patterns).

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
- Diff format from `generate/`: unified diff string vs. structured
  file-replacement — affects both the Claude prompt and how `cli/`
  renders/applies it.
- Whether `verify/` operates on a temp file or in-memory only.
