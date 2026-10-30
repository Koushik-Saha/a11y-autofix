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

### Project configuration

Commit an `a11y-autofix.config.json` to the directory you run `a11y-autofix` from (normally the project root) to set defaults for everyone on the project. A full example:

```json
{
  "apiKeyEnv": "TEAM_ANTHROPIC_KEY",
  "ignore": ["src/legacy/**", "**/*.stories.tsx"],
  "disableRules": ["region", "landmark-one-main"],
  "severity": "serious",
  "browser": true
}
```

| Setting        | Default               | What it does                                                                                                                                                                                                                                             |
| -------------- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apiKeyEnv`    | `"ANTHROPIC_API_KEY"` | Name of the environment variable that holds the Anthropic API key. The key itself never goes in config, and an `apiKey` setting is rejected. If the named variable isn't set, fixes fail with a clear error; it never falls back to `ANTHROPIC_API_KEY`. |
| `ignore`       | `[]`                  | Glob patterns for component files to skip, matched against paths relative to the project root (`/` separators on every OS). Skipped files are never rendered.                                                                                            |
| `disableRules` | `[]`                  | axe-core rule ids never to report. Must be real rule ids; a typo is an error, not a silent no-op.                                                                                                                                                        |
| `severity`     | `"minor"`             | Minimum impact to report: `critical`, `serious`, `moderate` or `minor`. Violations axe-core gives no impact are always reported.                                                                                                                         |
| `browser`      | `false`               | Default for [`--browser`](#color-contrast---browser).                                                                                                                                                                                                    |

Instead of a separate file, the same object can go under an `"a11y-autofix"` key in `package.json`. If both exist, the config file wins, and the two are never merged.

**Precedence:** a command-line flag beats the config, and the config beats the default. Each setting has a flag: `--api-key-env <name>`, `--ignore <glob>` and `--disable-rule <id>` (both repeatable), `--severity <level>`, and `--browser` / `--no-browser`. A flag replaces the config's value outright: `--ignore` on the command line replaces the config's `ignore` list rather than adding to it.

**Invalid config stops the run** before anything is scanned, with every problem listed, for example:

```
Invalid a11y-autofix.config.json:
  - disableRules[1]: unknown axe-core rule id "image_alt"
  - severity: Invalid option: expected one of "minor"|"moderate"|"serious"|"critical"
  - disabledRule: unknown setting
```

**Suppressed is not the same as fixed.** A violation hidden by `disableRules` or `severity` is still detected. It is never sent to the model or fixed, and it is always counted. The summary line reports it separately from verified fixes, and so does the Action's PR comment. Suppressed violations don't make the exit code non-zero:

```
1 violation(s) found across 2 file(s): 1 verified, 0 unverified, 0 errored. 3 suppressed by config (region ×2, landmark-one-main ×1). 1 file(s) skipped by config ignore.
```

With `--json`, each suppressed violation is listed in `suppressed` (with `reason: "disabled-rule"` or `"below-severity"`), skipped files are listed in `ignoredFiles`, and a `config` object records where the settings came from and what they resolved to:

```json
"config": {
  "source": "file",
  "path": "/repo/a11y-autofix.config.json",
  "settings": { "apiKeyEnv": "TEAM_ANTHROPIC_KEY", "ignore": ["src/legacy/**", "**/*.stories.tsx"], "disableRules": ["region", "landmark-one-main"], "severity": "serious", "browser": true }
}
```

`source` is `"file"`, `"package"` (the `package.json` key) or `"none"`.

### Color contrast (`--browser`)

By default, components are rendered in [jsdom](https://github.com/jsdom/jsdom): fast, with no browser to download. But jsdom has no layout or paint, so axe-core can't measure contrast there, and **the default mode cannot detect `color-contrast` violations** (low-contrast text, the most common accessibility failure on the web). `--browser` renders each component in headless Chromium via [Playwright](https://playwright.dev) instead and runs axe-core's full default ruleset, `color-contrast` included:

```sh
npm install --save-dev playwright      # optional peer dependency, only needed for --browser
npx playwright install chromium
npx a11y-autofix scan src/components --browser
```

```
src/components/Notice.tsx
  [violation] color-contrast (serious): Elements must meet minimum color contrast ratio thresholds
  --- a/src/components/Notice.tsx
  +++ b/src/components/Notice.tsx
  @@ -14,3 +14,3 @@
  -<p style={{ color: '#cccccc', backgroundColor: '#ffffff' }}>
  +<p style={{ color: '#767676', backgroundColor: '#ffffff' }}>
  [verified] fix confirmed (pass --write to apply) (confidence: high)
```

- **Everything else is identical.** Same components, same esbuild bundling, same violation format. The test suite checks that, apart from `color-contrast`, browser mode reports exactly the same violations as jsdom mode for every fixture. Fixes are verified in the same mode they were detected in.
- **It never falls back to jsdom.** If Playwright or its Chromium isn't installed, `--browser` exits non-zero with the command to install it. It does not quietly scan in jsdom, which would quietly skip contrast.
- **Contrast fixes keep your colors.** The fix changes only the text color: the existing color, same hue, darkened or lightened by the smallest amount that meets the ratio axe-core requires. That color is computed in code, not by the model, and the model is told not to touch the background, fonts or text. If the text sits on a background image or gradient, there's no single background color to compute against, so the violation is reported as `[not auto-fixable]` and left for you rather than guessed.
- **Slower.** Chromium takes a few seconds to launch (once per scan, shared by every render), then roughly 0.3–1s per render. Each fix is rendered twice to verify it.

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

`result.violations` has one entry per offending source element — two `<img>`s missing `alt` are two entries, each with its own `patch` — as a discriminated union on `status`:

| `status`       | Fields available                                               | Meaning                                                                                                                                                                                                                                  |
| -------------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `'verified'`   | `context`, `patch`, `verification`, `applied`                  | The fix resolved the violation with no regressions. `applied` is `true` only if `write` was passed.                                                                                                                                      |
| `'unverified'` | `context`, `patch`, `verification`, `applied` (always `false`) | A fix was generated but axe-core still flags something after applying it — see `verification.remainingViolations` / `newViolations`. Never written to disk.                                                                              |
| `'errored'`    | `error`, `reason?`                                             | context/generate/verify threw for this violation (e.g. an unfixable JSX node, a Claude API error) — the rest of the scan continues. `reason: 'not-auto-fixable'` marks a deliberate refusal (e.g. low contrast over a background image). |

`scan()` doesn't read the [project config](#project-configuration) itself; pass the same settings as options: `ignore` (with `root`, the directory the globs are relative to, by default `process.cwd()`), `disableRules`, `severity` and `apiKeyEnv`. Suppressed violations come back in `result.suppressed`, separate from `result.violations`, and skipped files in `result.ignoredFiles`. `loadProjectConfig(dir)` and `resolveSettings(config, overrides)` are exported if you want the CLI's loading and precedence rules.

`scan()` throws only if `targetPath` doesn't exist, or (with `{ browser: true }`) if Playwright/Chromium can't be launched — a `BrowserUnavailableError`, never a silent fallback to jsdom. Per-violation failures never abort the scan.

Pass `{ browser: true }` to detect and verify in headless Chromium, which adds `color-contrast` checks — see [Color contrast](#color-contrast---browser). `detectViolations` and `verifyFix` take the same `browser` option.

Each `patch` has a `kind`. `'replace'` is the default: `newSnippet` replaces `oldSnippet` at `position`. `'insert'` adds `insertion: { anchor, position: 'before' | 'after', snippet, anchorSnippet }`, where `snippet` is the new element and `anchorSnippet` is the flagged element afterwards (unchanged, or with an added id). An insertion's `newSnippet` is those two composed in order, so applying any patch is still "replace `position` with `newSnippet`". A `label` replacement carries `fallback: { preferred: 'insert', reason }`. `--json`, the CLI's `--write` output (`kind: insert — added a new <label> before the flagged element`) and the corrections log (`"kind"`) all record the kind.

`patch.confidence` (`'high' | 'medium' | 'low'`) records how many generation attempts it took: `'high'` verified on the first try, `'medium'` needed one retry (the model was shown the rejected attempt and why), `'low'` means both attempts failed and `status` is `'unverified'`. It's present on every `patch`, regardless of `status`.

The CLI's `--interactive` mode is built entirely on two `scan()` options, exported for anyone who wants to build their own review UI instead of the built-in terminal prompt: pass `onVerifiedFix` to be asked for a `VerifiedFixDecision` (`{ action: 'accept' }`, `{ action: 'reject' }`, or `{ action: 'edit', newSnippet }`) for each verified fix — an edit is re-verified the same way every AI-generated fix is, before ever being applied — and `onFixResolved` for a fire-and-forget callback reporting how each one was ultimately resolved. See `src/cli/interactive.ts` for the reference implementation.

The individual pipeline stages (`detectViolations`, `gatherContext`, `generateFix`, `verifyFix`) are also exported, if you want to drive the pipeline yourself instead of using `scan()`. `detectViolations` accepts a file or a directory; every violation it returns carries the `filePath` it was found in, and `result.files` lists each file it rendered (clean ones included).

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

The Action runs from the repository root, so a committed [project config](#project-configuration) applies there too: ignored files are skipped, and suppressed violations are counted in the summary comment. The exception is `apiKeyEnv`: the Action always uses its own `anthropic-api-key` input.

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

1. **detect** renders your component in a real DOM (jsdom, plus `@testing-library/react` for React or Vue's own `createApp().mount()` for Vue; or headless Chromium with `--browser`) and runs axe-core against it — real accessibility testing, not pattern matching.
2. **context** locates the exact element behind a violation by parsing the component's AST (JSX via ts-morph for React, the template AST via `@vue/compiler-sfc` for Vue) — never by string-matching source text — and extracts it, its parent, its siblings, and its prop types, so the model has real surrounding context to work from. Where it can do so statically, it also resolves what the element's dynamic props refer to — `src={avatarUrl}` to the constant's string, `onClick={handleDelete}` to the handler's code, following relative imports but never into packages or `node_modules` — so alt text and labels can be specific. Nothing is executed; anything it can't resolve is simply left out.
3. **generate** sends Claude only that one element and constrains its response, via structured output, to a single field: the replacement markup. It cannot touch the parent, the siblings, or anything else in the file. The one exception is a short allowlist of rules whose idiomatic fix _adds_ an element: for `label` (and `bypass`, which a single component never triggers today), the response may instead be an **insertion**, one new element placed directly before or after the flagged one. That's how an unlabeled `<input>` gets a real `<label htmlFor>`. If the input has no id, the same patch gives it one, as the input's only change. For every other rule the response schema has only the replacement field, so an insertion can't even be expressed.
4. **verify** is the trust boundary. It applies the proposed patch to the component's source **in memory only** — the file on disk is never modified at this stage — re-renders the patched component, and re-runs axe-core against it. Two things have to be true for a fix to pass:
   - the original violation is actually gone, and
   - no new violation was introduced by the fix.

   An insertion is checked the same way, plus more. Its parts must be consistent and allowed for the rule (only a `<label>` for `label`; the flagged element keeps its tag). It also fails if it makes an id non-unique that a label or ARIA attribute points at. axe-core reports that case (`duplicate-id-aria`) only as "needs review", so verify asks for it explicitly. When an insertion is rejected, the retry offers only a replacement, so `label` falls back to an `aria-label`, and the patch records that fallback and why.

   The patch is applied at the exact position context/ found the element, so in a file with two identical offending elements each one gets, and is verified on, its own fix. If the file was edited after the scan, applying a fix fails with "file changed since scan — re-run scan" rather than patching whatever is at that position now.

   Only a fix that clears both checks is marked `verified`. Everything else — a fix that didn't fully resolve the issue, or fixed one thing while breaking another — comes back `unverified`, carrying the exact violations that prove it. It is never discarded, and it is never written to your files, `--write` or not.

If you run with `--write`, this is also the only thing that decides what touches disk: verified fixes get applied, unverified ones don't, full stop. The test suite (`verify.test.ts`, `scan.test.ts`, `cli.test.ts`) covers both directions directly — a fix that genuinely resolves a violation, and a fix that changes something irrelevant and is correctly caught and rejected — so this isn't just a design claim, it's asserted behavior you can read and re-run yourself.

**One retry, fed the failure.** If step 4 comes back `unverified`, `scan()` doesn't just give up — it calls **generate** exactly one more time, this time showing the model its rejected attempt and _why_ it was rejected (which rule was still flagged, or what new violation it introduced), then re-runs **verify** on the result. Whether that took zero retries or one is recorded as `patch.confidence`: `'high'` for a first-attempt pass, `'medium'` for a fix that needed the retry, `'low'` if both attempts failed (`status` stays `unverified` either way — the retry only affects `confidence`, never what counts as verified). The [GitHub Action](#github-action) uses this: only `'high'`-confidence fixes become one-click inline suggestions, so a fix that needed convincing gets a human's eyes on it first.

See [`PLAN.md`](./PLAN.md) for the full module-by-module design notes, including known limitations (e.g. `color-contrast` can't be detected in the default jsdom mode — jsdom has no real paint implementation for axe-core to measure against — only with `--browser`) and open decisions.

## Real-model eval

The test suite mocks the model, so it proves the pipeline works but not that the model's fixes are any good. `npm run eval:real` runs the real pipeline (detect -> context -> generate -> verify, with the same single retry `scan` uses) against every component fixture in `test/fixtures/`, calling the Claude API for real. It needs `ANTHROPIC_API_KEY`; without one it exits 1 and calls nothing. It is never part of `npm test` or CI.

```sh
ANTHROPIC_API_KEY=… npm run eval:real                       # every fixture, jsdom
ANTHROPIC_API_KEY=… npm run eval:real -- --browser          # Chromium, adds color-contrast
ANTHROPIC_API_KEY=… npm run eval:real -- --only Vue         # fixtures whose path contains "Vue"
ANTHROPIC_API_KEY=… npm run eval:real -- --update-baseline  # also write evals/baseline.md
npm run eval:compare [report] [--baseline path]             # newest evals/report-*.md vs evals/baseline.md
```

Each run writes `evals/report-<date>.md` (gitignored; only `evals/baseline.md` is committed). The report contains:

- for each fixture: the violations found, the fix proposed (the exact `newSnippet`), whether it verified, and if not, why (rules still flagged, rules introduced, or the error);
- acceptance per violation type: verified, verified first try, unverified and errored counts;
- every rejected attempt quoted in full next to the original element, including first attempts that a retry then fixed;
- tokens (input, output, thinking, cache) and estimated cost per fixture and in total, plus the average cost per violation and per 100 violations. Prices are in `scripts/eval/pricing.ts`. A model without a listed price shows "unknown" rather than a guess.

The full run data is embedded at the end of the report, so `eval:compare` reads what the run recorded rather than re-parsing prose. `eval:compare` is the gate for prompt and model changes:

- **Exit 1** when any violation the baseline verified (identified by fixture, rule and occurrence) is now unverified, errored or missing. This is per violation, so a type that drops from 3/3 to 2/3 fails.
- **Exit 2** when it can't compare: no report yet, an empty baseline, a different `--browser` mode, or a damaged data section. A gate that couldn't run is never reported as a pass.
- **Exit 0** otherwise. Improvements and new cases are listed but not gated. Fixtures skipped with `--only` are not gated either.

Model output varies between runs, so a single flaky regression is possible. Re-run before concluding that a prompt change broke something.

The committed `evals/baseline.md` is currently an empty marker. The harness was added without an API key available, so no real results exist yet, and none were made up.

## Contributing

See [`CONTRIBUTING.md`](./CONTRIBUTING.md) for setup, the development loop, and what to check before opening a PR.

## License

[MIT](./LICENSE)
