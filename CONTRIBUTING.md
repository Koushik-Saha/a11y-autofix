# Contributing

## Setup

Requires Node 18+ (tested on 18.x and 20.x — see `.github/workflows/ci.yml`).

```sh
git clone https://github.com/Koushik-Saha/a11y-autofix.git
cd a11y-autofix
npm install
```

## Development loop

```sh
npm run dev -- scan <path>   # run the CLI from source, no build step
npm run test:watch           # vitest in watch mode
```

Before opening a PR, run the same checks CI runs:

```sh
npm run typecheck
npm run lint
npm run format:check
npm run build
npm test
```

`npm run lint:fix` and `npm run format` will fix most lint/formatting issues automatically.

## About the test suite

Almost the entire suite (`detect/`, `context/`, `verify/`, `scan/`, `cli/`) runs against real fixtures with no network access or credentials required — it compiles fixture components with esbuild, renders them in jsdom, and runs real axe-core against them.

The one exception is `generate/`, which calls the live Claude API and has no unit tests of its own for that reason. Everywhere else in the suite that needs a patch (`scan.test.ts`, `cli.test.ts`, `pipeline-e2e.test.ts`), `generateFix` is mocked with a hand-authored fix via `vi.mock('../src/generate', ...)` — this exercises the real pipeline around it (AST location, patch application, re-verification) without needing `ANTHROPIC_API_KEY`. You only need real credentials if you're testing `generate/` itself.

## Adding a new WCAG rule / fixture

See `test/fixtures/` for the existing pattern — one small component per violation type, plus `test/pipeline-e2e.test.ts` which runs the full pipeline against all of them. If you add support for a new axe-core rule, add a fixture that triggers it and a case in `pipeline-e2e.test.ts` alongside it.

## Architecture

`PLAN.md` has the full module-by-module design notes, the reasoning behind key decisions (e.g. why `color-contrast` is disabled, why fixes are constrained to one JSX element at a time), and a running list of open decisions. Read it before making a structural change, and update it as part of your PR if the change affects module boundaries or contracts.

## Pull requests

- Keep changes focused — a PR that fixes one thing is easier to review than one that also reformats unrelated code.
- Add or update tests for any behavior change.
- Update `PLAN.md` if you change a module's contract, add a module, or resolve one of its open decisions.
- Make sure the full check suite above passes before requesting review.
