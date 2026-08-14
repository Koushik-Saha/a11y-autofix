# a11y-autofix

[![CI](https://github.com/Koushik-Saha/a11y-autofix/actions/workflows/ci.yml/badge.svg)](https://github.com/Koushik-Saha/a11y-autofix/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

**Every accessibility tool that fixes issues automatically is paid — this one is free.**

`a11y-autofix` scans React and Vue components with [axe-core](https://github.com/dequelabs/axe-core), generates a proposed fix for each violation via the Claude API, and re-runs axe-core against the patched component before showing it to you. No fix is ever surfaced or applied unless it has been proven to actually resolve the violation — an unresolved fix is shown as `unverified`, never silently discarded and never auto-applied.

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
  [verified] fix confirmed (pass --write to apply) (confidence: high)

1 violation(s) found across 1 file(s): 1 verified, 0 unverified, 0 errored.
```

Every fix carries a **confidence** level based on how much retrying it took to verify: `high` means it passed on the first attempt, `medium` means the model was shown a rejected first attempt and got it right on the retry, `low` means both attempts failed (`status` stays `unverified`). See [How the verify loop works](#how-the-verify-loop-works) below for what the retry actually does.

Nothing is written to disk in this mode — it's a report. Pass `--write` to apply verified fixes:

```sh
npx a11y-autofix scan src/components --write
```

**Unverified fixes are always printed, with the reason they didn't verify, and are never applied — `--write` or not.** The exit code is non-zero whenever a violation is still unresolved at the end of the run, so `scan` (with or without `--write`) works as a CI gate.

```sh
npx a11y-autofix scan --help
```

Pass `--json` to get the full scan result as machine-readable JSON on stdout instead of the human-readable diff — this is what the [GitHub Action](#github-action) below consumes:

```sh
npx a11y-autofix scan src/components --json > result.json
```

### Interactive mode

`--write` applies every verified fix unconditionally. `--interactive` reviews them one at a time instead:

```sh
npx a11y-autofix scan src/components --interactive --write
```

For each verified fix, you get a diff and a prompt:

```
src/components/Avatar.tsx:8
  [violation] image-alt (critical): Images must have alternative text
  Suggested fix:
  --- src/components/Avatar.tsx
  +++ src/components/Avatar.tsx
  -<img src={avatarUrl} />
  +<img src={avatarUrl} alt="User avatar" />
Apply this fix? [y]es / [n]o / [e]dit / [q]uit remaining:
```

- **y** applies it (only if `--write` was also passed — without `--write`, `--interactive` is a dry-run review and nothing is ever written, whatever you answer).
- **n** skips it. The violation stays reported as `verified` (the AI's suggestion genuinely works) but `applied: false`.
- **e** lets you type a replacement. **Your edit goes through the exact same verification as every AI-generated fix** — it's re-rendered and re-checked with axe-core before anything is written. If it doesn't resolve the violation, you're shown why (same `remainingViolations`/`newViolations` detail as everywhere else) and asked again; nothing unverified is ever applied, including your own edits.
- **q** stops asking — everything remaining in this scan is treated as skipped, no more prompts.

Without `--interactive`, none of this applies — `--write` behaves exactly as it always has.

### Local corrections log

Pass `--log-corrections` alongside `--interactive` to save every fix you reject or edit to `.a11y-autofix/corrections.log`, for your own reference (e.g. to spot patterns in what the model keeps getting wrong for your codebase):

```sh
npx a11y-autofix scan src/components --interactive --write --log-corrections
```

**Privacy, precisely:**

- **Off by default.** Nothing is logged unless you pass `--log-corrections` explicitly, every time — there's no persistent setting to forget about.
- **Fully local, no network code involved.** The only thing this does is append a line of JSON to a file on your own disk (`fs.appendFileSync`). Nothing about this feature makes a network call, and it's structurally impossible for it to: `--log-corrections` only ever reaches this file-writing code, never anything that talks to a server. This is separate and disconnected from both the Claude API calls `scan` makes to generate fixes and the [GitHub Action](#github-action)'s PR-posting — a corrections log is never read by, or sent through, either of those.
- **`.a11y-autofix/` excludes itself from git**, automatically, the first time it's created — the CLI writes a `.gitignore` containing `*` inside that directory, so the log is excluded regardless of whether your project's own `.gitignore` mentions it. "Local" shouldn't depend on you remembering to add an entry yourself; an ordinary `git add .` in your project won't pick this up.
- **Only rejections and edits are logged** — accepting a suggestion isn't a "correction," so it's never written. A logged entry looks like:
  ```json
  {
    "timestamp": "2026-08-13T10:15:00.000Z",
    "filePath": "src/components/Avatar.tsx",
    "startLine": 8,
    "violationId": "image-alt",
    "action": "rejected",
    "suggested": "<img src={avatarUrl} alt=\"User avatar\" />"
  }
  ```
  (`action: "edited"` entries also include your `edited` replacement text.)
- **No effect in CI.** The [GitHub Action](#github-action) runs `scan --json` non-interactively — there's no human present to reject or edit anything, so this code path never runs there regardless of any flag.

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

`patch.confidence` (`'high' | 'medium' | 'low'`) records how many generation attempts it took: `'high'` verified on the first try, `'medium'` needed one retry (the model was shown the rejected attempt and why), `'low'` means both attempts failed and `status` is `'unverified'`. It's present on every `patch`, regardless of `status`.

The CLI's `--interactive` mode is built entirely on two `scan()` options, exported for anyone who wants to build their own review UI instead of the built-in terminal prompt: pass `onVerifiedFix` to be asked for a `VerifiedFixDecision` (`{ action: 'accept' }`, `{ action: 'reject' }`, or `{ action: 'edit', newSnippet }`) for each verified fix — an edit is re-verified the same way every AI-generated fix is, before ever being applied — and `onFixResolved` for a fire-and-forget callback reporting how each one was ultimately resolved. See `src/cli/interactive.ts` for the reference implementation.

The individual pipeline stages (`detectViolations`, `gatherContext`, `generateFix`, `verifyFix`) are also exported, if you want to drive the pipeline yourself instead of using `scan()`.

## GitHub Action

This repo doubles as a GitHub Action (`action.yml` at the root) that runs `a11y-autofix` on a pull request and posts the results directly on it:

- **High-confidence, verified fixes** whose location falls inside the PR's diff are posted as inline review comments carrying a GitHub [suggested change](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/reviewing-changes-in-a-pull-request/incorporating-feedback-in-your-pull-request) — a reviewer accepts one with a single click, same as any other suggestion. "High confidence" means the fix verified on its first generation attempt, with no retry.
- **Everything else** — unverified fixes, errored violations, medium-confidence verified fixes (needed a retry), and verified fixes that land outside this PR's diff (GitHub's API won't let a comment anchor to a line the diff doesn't show) — goes into one sticky summary comment instead, updated in place on every push rather than reposted. A medium-confidence fix's summary entry includes the diff so you can review and apply it yourself.

```yaml
# .github/workflows/a11y-autofix.yml
name: a11y-autofix
on: pull_request

permissions:
  contents: read
  pull-requests: write

jobs:
  scan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: Koushik-Saha/a11y-autofix@v1
        with:
          path: src/components
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
```

### Inputs

| Input                | Default               | Description                                                                                                                                                           |
| -------------------- | --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `path`               | `.`                   | Path to scan, relative to the repo root.                                                                                                                              |
| `anthropic-api-key`  | _(required)_          | Passed through as `ANTHROPIC_API_KEY`.                                                                                                                                |
| `github-token`       | `${{ github.token }}` | Needs `pull-requests: write` to post the review and summary comment.                                                                                                  |
| `review-event`       | `COMMENT`             | `COMMENT` or `REQUEST_CHANGES` for the review carrying the inline suggestions. Never `APPROVE` — this Action proposes fixes, it doesn't vouch for the rest of the PR. |
| `fail-on-unresolved` | `false`               | Fail the job if any violation is unverified or errored. A verified fix waiting to be accepted as a suggestion does **not** count as unresolved.                       |

**A note on `pull_request_target`:** the Action also runs on `pull_request_target` events (needed if your workflow scans fork PRs with write access), but that event runs with your base branch's secrets and permissions by default — the usual fork-PR security caveats apply to your workflow, not to anything this Action does differently. If you're not sure you need it, use `pull_request`.

## VS Code extension

`packages/vscode-extension` (npm workspace, published separately as `vscode-a11y-autofix`) runs the same pipeline inline in the editor — no separate CLI invocation needed:

- **Red squiggles** on every axe-core violation, scanned on file open/save (deliberately not on every keystroke — see below).
- **"Fix with a11y-autofix"** quick fix on each squiggle, which generates and verifies a patch via the same `resolveFix` the CLI uses (one retry, confidence-scored) and applies it to the buffer only once it verifies. Nothing is written for an unverified fix — same guarantee as everywhere else in this tool.

It imports `detectViolations`, `gatherContext`, `resolveFix`, and `applyPatchToSource` directly from this package (via a `file:../..` workspace dependency) rather than reimplementing any detection, generation, or verification logic.

Scanning reads the file **from disk**, not the live editor buffer — the same `FrameworkAdapter`s the CLI uses (ts-morph for React, `@vue/compiler-sfc` for Vue) always read from disk, and mixing that with a live buffer would risk a squiggle's location drifting from what a fix actually targets. This is why scans run on open/save rather than on every keystroke, and why the fix command refuses to run against a dirty (unsaved) document. The `a11yAutofix.disabledRules` setting (a list of axe-core rule ids) filters diagnostics client-side and isn't shared with the CLI, which has no rule-filtering config of its own yet.

Not yet published to the VS Code Marketplace. To run it locally: `npm install` at the repo root, then open `packages/vscode-extension` in VS Code and press F5 (`Run Extension`) to launch an Extension Development Host. Set the `a11yAutofix.anthropicApiKey` setting, or export `ANTHROPIC_API_KEY`, before invoking a fix — diagnostics alone need no API key.

To build an installable `.vsix` instead: `npm run package` inside `packages/vscode-extension`. This does more than call `vsce package` directly — see `packages/vscode-extension/scripts/package.js` and its `PLAN.md` entry for why a plain `vsce package` fails against this monorepo's `file:../..` dependency, and how the script works around it in an isolated scratch directory without touching this repo's own `node_modules`. `vsce publish` itself is left to a human with marketplace publishing rights; nothing here runs it automatically.

## How the verify loop works

This is the part that makes the tool trustworthy rather than just plausible. The core risk with any LLM-generated fix is that the model _says_ it fixed something but didn't — so nothing here takes Claude's word for it.

```
detect/  --violations-->  context/  --FixContext-->  generate/  --Patch-->  verify/  --VerificationResult-->  cli/ / scan()
   ^                                                                            |
   |                                                                            |
   +----------------------- re-run axe-core against the patched component -----+
```

1. **detect** renders your component in a real DOM (jsdom, plus `@testing-library/react` for React or Vue's own `createApp().mount()` for Vue) and runs axe-core against it — real accessibility testing, not pattern matching.
2. **context** locates the exact element behind a violation by parsing the component's AST (JSX via ts-morph for React, the template AST via `@vue/compiler-sfc` for Vue) — never by string-matching source text — and extracts it, its parent, its siblings, and its prop types, so the model has real surrounding context to work from.
3. **generate** sends Claude only that one element and constrains its response, via structured output, to a single field: the replacement markup. It cannot touch the parent, the siblings, or anything else in the file.
4. **verify** is the trust boundary. It applies the proposed patch to the component's source **in memory only** — the file on disk is never modified at this stage — re-renders the patched component, and re-runs axe-core against it. Two things have to be true for a fix to pass:
   - the original violation is actually gone, and
   - no new violation was introduced by the fix.

   Only a fix that clears both checks is marked `verified`. Everything else — a fix that didn't fully resolve the issue, or fixed one thing while breaking another — comes back `unverified`, carrying the exact violations that prove it. It is never discarded, and it is never written to your files, `--write` or not.

If you run with `--write`, this is also the only thing that decides what touches disk: verified fixes get applied, unverified ones don't, full stop. The test suite (`verify.test.ts`, `scan.test.ts`, `cli.test.ts`) covers both directions directly — a fix that genuinely resolves a violation, and a fix that changes something irrelevant and is correctly caught and rejected — so this isn't just a design claim, it's asserted behavior you can read and re-run yourself.

**One retry, fed the failure.** If step 4 comes back `unverified`, `scan()` doesn't just give up — it calls **generate** exactly one more time, this time showing the model its rejected attempt and _why_ it was rejected (which rule was still flagged, or what new violation it introduced), then re-runs **verify** on the result. Whether that took zero retries or one is recorded as `patch.confidence`: `'high'` for a first-attempt pass, `'medium'` for a fix that needed the retry, `'low'` if both attempts failed (`status` stays `unverified` either way — the retry only affects `confidence`, never what counts as verified). The [GitHub Action](#github-action) uses this: only `'high'`-confidence fixes become one-click inline suggestions, so a fix that needed convincing gets a human's eyes on it first.

See [`PLAN.md`](./PLAN.md) for the full module-by-module design notes, including known limitations (e.g. `color-contrast` currently can't be detected — jsdom has no real paint implementation for axe-core to measure against) and open decisions.

## Contributing

See [`CONTRIBUTING.md`](./CONTRIBUTING.md) for setup, the development loop, and what to check before opening a PR.

## License

[MIT](./LICENSE)
