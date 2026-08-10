# a11y-autofix

Scans React components with [axe-core](https://github.com/dequelabs/axe-core), generates a proposed fix for each violation via the Claude API, and re-runs axe-core against the patched component before showing it to you. **No fix is ever surfaced or applied unless it has been proven to actually resolve the violation** — an unresolved fix is shown as `unverified`, never silently discarded and never auto-applied.

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

## How it works

```
detect/  --violations-->  context/  --FixContext-->  generate/  --Patch-->  verify/  --VerificationResult-->  cli/ / scan()
   ^                                                                            |
   |                                                                            |
   +----------------------- re-run axe-core against the patched component -----+
```

1. **detect** renders the component(s) and runs axe-core against them.
2. **context** locates the exact JSX element behind a violation by parsing the component's AST (not by string-matching), and extracts it, its parent, its siblings, and its prop types.
3. **generate** sends that to Claude, constrained to return only a replacement for that one element — nothing else in the file is touched.
4. **verify** applies the patch in memory (never to disk), re-renders, and re-runs axe-core to confirm the violation is actually gone and nothing new broke.
5. **cli** / **scan()** render or return the result.

See [`PLAN.md`](./PLAN.md) for the full module-by-module design notes and open decisions.
