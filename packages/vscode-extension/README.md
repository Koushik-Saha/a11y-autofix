# a11y-autofix for VS Code

Inline WCAG diagnostics for React and Vue components, with one-click fixes that are verified before they ever touch your buffer. Powered by [`a11y-autofix`](https://github.com/Koushik-Saha/a11y-autofix)'s own detect → context → generate → verify pipeline — this extension doesn't reimplement any of that logic, it just surfaces it in the editor.

## Features

- **Red squiggles on real WCAG violations.** Every `.tsx`, `.jsx`, and `.vue` file is scanned with [axe-core](https://github.com/dequelabs/axe-core) on open and on save. Critical/serious violations show as errors; everything else as warnings.
- **"Fix with a11y-autofix" quick fix.** Click the lightbulb on a squiggle to generate a fix via the Claude API. The fix is applied to your file **only if axe-core re-confirms, on a second render, that the violation is actually gone and no new one was introduced** — an unverified suggestion is never silently applied. This is the same verify loop the `a11y-autofix` CLI and GitHub Action use.
- **Confidence-aware.** Fixes that need a retry to pass verification are still applied (and still safe — every applied fix is verified, no exceptions), but the confirmation message tells you whether it took a first-try (`high`) or a retry (`medium`) to get there.
- **Nothing is applied on your behalf.** A quick fix only runs when you click it. Diagnostics alone never call the Claude API and never need an API key.

## Requirements

- VS Code `^1.85.0`.
- An Anthropic API key to generate fixes (see [Extension Settings](#extension-settings) below) — **not required** just to see diagnostics.
- Your workspace's own React/Vue and its component files on disk. Scans always read the file **as saved**, not unsaved editor state (see [How scanning works](#how-scanning-works)).

## Extension Settings

| Setting                       | Default | Description                                                                                                                                                                                                                        |
| ----------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `a11yAutofix.anthropicApiKey` | `""`    | Anthropic API key used to generate fixes. If unset, falls back to the `ANTHROPIC_API_KEY` environment variable the CLI already uses. Only read when you invoke a fix — diagnostics never need it.                                  |
| `a11yAutofix.disabledRules`   | `[]`    | axe-core rule ids to never show as diagnostics in this editor, e.g. `["landmark-unique", "tabindex"]`. This is an extension-only setting — the CLI doesn't have an equivalent rule filter (yet), so it isn't shared configuration. |

## Commands

- **Fix with a11y-autofix** — shown as a quick fix (lightbulb) on any diagnostic this extension raises. Not in the command palette; it needs a specific violation to act on.
- **a11y-autofix: Rescan this file** — re-runs the scan against the active file's current on-disk content, without needing to touch and re-save it.

## How scanning works

Diagnostics are computed from the file **on disk**, not your unsaved edits. Editing a file doesn't move its squiggles until you save — this is deliberate, not a missing debounce: `a11y-autofix`'s element-location logic (an AST walk over the component, matched against axe-core's own selector output) and the fix pipeline both operate on disk content, and mixing a live buffer for detection with disk content for fixing risks a squiggle silently pointing at the wrong element. For the same reason, the fix quick fix refuses to run on an unsaved (dirty) document — you'll be asked to save first.

## Known limitations

- Not yet published to the VS Code Marketplace — see the [main repo](https://github.com/Koushik-Saha/a11y-autofix) for how to build and install a local `.vsix`.
- A fix is a single-element replacement (it can't add a new element). Some violations — e.g. an `<input>` with no nearby `<label>` — are fixed with `aria-label` rather than a real associated `<label>` element, since inserting a sibling element isn't something this architecture supports today. See the main repo's `PLAN.md` for the full rundown of what each rule type's fix looks like and why.
- Applying a fix leaves the file dirty (unsaved), same as any other quick fix or edit in VS Code — it doesn't save on your behalf. The diagnostic for a just-fixed violation clears once you save.

## More

This extension is one part of the `a11y-autofix` project, which also ships a standalone CLI and a GitHub Action that posts verified fixes as inline PR suggestions. See the [main README](https://github.com/Koushik-Saha/a11y-autofix#readme) for the full pipeline, the CLI, and the Action.

## Release Notes

### 0.1.0

Initial release: diagnostics on open/save, the "Fix with a11y-autofix" quick fix, and the `anthropicApiKey`/`disabledRules` settings.
