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

## Status

Scaffold only — no pipeline logic implemented yet. Every exported function in
`detect/`, `context/`, `generate/`, and `verify/` currently throws
`Not implemented`.

### Done

- [x] Repo scaffold: `package.json` (with `bin` entry), `tsconfig.json`,
      ESLint flat config, Prettier config, `.gitignore`.
- [x] `src/` structure: `detect/`, `context/`, `generate/`, `verify/`,
      `cli/`, plus `src/index.ts` re-exporting the library API.
- [x] Type contracts between modules (`AxeViolation`, `FixContext`,
      `FixDiff`, `VerificationResult`) sketched as interfaces.
- [x] `cli/index.ts` stub wired up with `commander` (`--version`, a `scan`
      command placeholder).

### Not started

- [ ] `detect/`: render a React component in a headless DOM (jsdom or
      Playwright — TBD) and run axe-core against it.
- [ ] `context/`: read source files, resolve imports/related files for
      prompt context.
- [ ] `generate/`: prompt design for Claude, diff parsing/formatting.
- [ ] `verify/`: apply a diff to a scratch copy, re-invoke `detect/`,
      compare before/after violation sets.
- [ ] `cli/`: real `scan` command output (diff rendering, accept/reject
      prompt), config file support (API key, ignore patterns).
- [ ] Tests (framework TBD — likely `vitest`).

## Open decisions (revisit before implementing)

- How to render React components headlessly for `detect/`/`verify/`:
  jsdom + `@testing-library/react` vs. a real browser via Playwright.
  Affects fidelity of detected violations vs. setup weight.
- Diff format from `generate/`: unified diff string vs. structured
  file-replacement — affects both the Claude prompt and how `cli/`
  renders/applies it.
- Whether `verify/` operates on a temp file or in-memory only.
