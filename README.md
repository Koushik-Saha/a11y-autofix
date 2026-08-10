# a11y-autofix

[![CI](https://github.com/Koushik-Saha/a11y-autofix/actions/workflows/ci.yml/badge.svg)](https://github.com/Koushik-Saha/a11y-autofix/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

**Every accessibility tool that fixes issues automatically is paid — this one is free.**

`a11y-autofix` scans React components with [axe-core](https://github.com/dequelabs/axe-core), generates a proposed fix for each violation via the Claude API, and re-runs axe-core against the patched component before showing it to you. No fix is ever surfaced or applied unless it has been proven to actually resolve the violation — an unresolved fix is shown as `unverified`, never silently discarded and never auto-applied.

## Install

```sh
npm install a11y-autofix
```

Requires Node 18+ and an Anthropic API key (`ANTHROPIC_API_KEY` in the environment, or an [`ant auth login`](https://platform.claude.com/docs/en/api/sdks/cli) profile).

## CLI usage

```sh
npx a11y-autofix scan <path>
```

Scans a single component file or every `.tsx`/`.jsx` file in a directory, and prints each violation plus its proposed fix as a unified diff:

```
src/components/Avatar.tsx
  [violation] image-alt (critical): Images must have alternative text
  --- a/src/components/Avatar.tsx
  +++ b/src/components/Avatar.tsx
  @@ -8,1 +8,1 @@
  -<img src={avatarUrl} />
  +<img src={avatarUrl} alt="User avatar" />
  [verified] fix confirmed (pass --write to apply)

1 violation(s) found across 1 file(s): 1 verified, 0 unverified, 0 errored.
```

Nothing is written to disk in this mode — it's a report. Pass `--write` to apply verified fixes:

```sh
npx a11y-autofix scan src/components --write
```

**Unverified fixes are always printed, with the reason they didn't verify, and are never applied — `--write` or not.** The exit code is non-zero whenever a violation is still unresolved at the end of the run, so `scan` (with or without `--write`) works as a CI gate.

```sh
npx a11y-autofix scan --help
```

## Programmatic usage

The same pipeline the CLI runs is exposed as `scan()` — it returns structured results instead of printing them, and never calls `process.exit`:

```ts
import { scan } from 'a11y-autofix';

const result = await scan('src/components/Avatar.tsx', { write: true });

for (const entry of result.violations) {
  if (entry.status === 'errored') {
    console.error(`${entry.violation.id}: ${entry.error}`);
    continue;
  }

  console.log(`${entry.violation.id}: ${entry.status}`);
  console.log(entry.patch.newSnippet);

  if (entry.status === 'unverified') {
    console.log(
      'still flagged:',
      entry.verification.remainingViolations.map((v) => v.id),
    );
  }
}
```

`result.violations` is a discriminated union on `status`:

| `status`       | Fields available                                               | Meaning                                                                                                                                                     |
| -------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `'verified'`   | `context`, `patch`, `verification`, `applied`                  | The fix resolved the violation with no regressions. `applied` is `true` only if `write` was passed.                                                         |
| `'unverified'` | `context`, `patch`, `verification`, `applied` (always `false`) | A fix was generated but axe-core still flags something after applying it — see `verification.remainingViolations` / `newViolations`. Never written to disk. |
| `'errored'`    | `error`                                                        | context/generate/verify threw for this violation (e.g. an unfixable JSX node, a Claude API error) — the rest of the scan continues.                         |

`scan()` throws only if `targetPath` doesn't exist; per-violation failures never abort the scan.

The individual pipeline stages (`detectViolations`, `gatherContext`, `generateFix`, `verifyFix`) are also exported, if you want to drive the pipeline yourself instead of using `scan()`.

## How the verify loop works

This is the part that makes the tool trustworthy rather than just plausible. The core risk with any LLM-generated fix is that the model _says_ it fixed something but didn't — so nothing here takes Claude's word for it.

```
detect/  --violations-->  context/  --FixContext-->  generate/  --Patch-->  verify/  --VerificationResult-->  cli/ / scan()
   ^                                                                            |
   |                                                                            |
   +----------------------- re-run axe-core against the patched component -----+
```

1. **detect** renders your component in a real DOM (jsdom + `@testing-library/react`) and runs axe-core against it — real accessibility testing, not pattern matching.
2. **context** locates the exact JSX element behind a violation by parsing the component's AST — never by string-matching source text — and extracts it, its parent, its siblings, and its prop types, so the model has real surrounding context to work from.
3. **generate** sends Claude only that one element and constrains its response, via structured output, to a single field: the replacement JSX. It cannot touch the parent, the siblings, or anything else in the file.
4. **verify** is the trust boundary. It applies the proposed patch to the component's source **in memory only** — the file on disk is never modified at this stage — re-renders the patched component, and re-runs axe-core against it. Two things have to be true for a fix to pass:
   - the original violation is actually gone, and
   - no new violation was introduced by the fix.

   Only a fix that clears both checks is marked `verified`. Everything else — a fix that didn't fully resolve the issue, or fixed one thing while breaking another — comes back `unverified`, carrying the exact violations that prove it. It is never discarded, and it is never written to your files, `--write` or not.

If you run with `--write`, this is also the only thing that decides what touches disk: verified fixes get applied, unverified ones don't, full stop. The test suite (`verify.test.ts`, `scan.test.ts`, `cli.test.ts`) covers both directions directly — a fix that genuinely resolves a violation, and a fix that changes something irrelevant and is correctly caught and rejected — so this isn't just a design claim, it's asserted behavior you can read and re-run yourself.

See [`PLAN.md`](./PLAN.md) for the full module-by-module design notes, including known limitations (e.g. `color-contrast` currently can't be detected — jsdom has no real paint implementation for axe-core to measure against) and open decisions.

## Contributing

See [`CONTRIBUTING.md`](./CONTRIBUTING.md) for setup, the development loop, and what to check before opening a PR.

## License

[MIT](./LICENSE)
