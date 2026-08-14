# a11y-autofix — Plan

An open-source npm CLI that scans React and Vue components with axe-core,
generates verified WCAG fix diffs using the Claude API, and re-runs axe-core
to confirm each fix before showing it to the user. No fix is surfaced unless
it has been proven to actually resolve the violation.

## Pipeline

```
detect/  --violations-->  context/  --FixContext-->  generate/  --Patch-->  verify/  --VerificationResult-->  scan()  --ScanResult-->  cli/
   ^                                                                            |                                          |
   |                                                                            |                                          +-> library consumers
   +----------------------- re-run axe-core against the patched component -----+
```

1. **detect/** — Renders the target component(s) (React or Vue) and runs
   axe-core against them. Produces `AxeViolation[]`.
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
  `detect/` itself is split into a framework-agnostic `index.ts` and a
  `RenderAdapter` boundary in `detect/adapters/` (added 2026-08-11, see the
  "Vue support" Done entry below) — nothing outside `detect/adapters/` may
  import `@vue/compiler-sfc`/`vue` (or, later, a Svelte compiler) directly.
- `context/` depends only on `detect/`'s types (an `AxeViolation`). Since
  2026-08-10, `context/` itself is split into a framework-agnostic
  `index.ts` and a `FrameworkAdapter` boundary in `context/adapters/` — see
  the "Framework adapter refactor" Done entry below. Nothing outside
  `context/adapters/` may import `ts-morph` (or, later, a Svelte parser)
  directly. `context/adapters/`'s `FrameworkAdapter` (locate-and-describe)
  and `detect/adapters/`'s `RenderAdapter` (compile-and-mount) are
  deliberately two separate interfaces, not one shared one — see the Vue
  support entry for why.
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
- **Headless rendering**: `jsdom` + `@testing-library/react` for React,
  `jsdom` + Vue's own `createApp().mount()` for Vue, with target component
  files compiled on the fly (`esbuild`, bundled CJS — JSX-transformed for
  React; script+template compiled via `@vue/compiler-sfc` then bundled for
  Vue) so `detect/` can render arbitrary `.tsx`/`.jsx`/`.vue` files without
  the caller needing a build step of their own.
- **Tests**: `vitest`.
- **Source parsing**: `ts-morph` for locating and extracting JSX/TypeScript
  AST nodes (React) and for a second pass over a Vue `<script setup>`
  block's `defineProps<T>()` type argument; `@vue/compiler-sfc` for
  locating elements in a Vue template's own AST.
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

- [x] 5 more violation types, per the WebAIM Million cross-reference below
      (2026-08-10): `detect/`, `context/`, and `generate/` needed **no
      code changes** — all three are already rule-agnostic (`detect/` runs
      axe-core's full default rule set, `context/` locates any single JSX
      element by selector structure, `generate/`'s prompt is generic). This
      round was purely fixtures + tests, exactly like the first 5. Two of
      the originally-recommended 5 (duplicate IDs, bypass/skip-links) were
      dropped after empirical probing — not guessed — against raw
      axe-core: `duplicate-id`/`duplicate-id-active` are `enabled: false`
      by default in the installed axe-core version (deprecated), and
      `duplicate-id-aria` (the one enabled variant) didn't fire even
      against a realistic duplicate-id-referenced-by-`aria-labelledby`
      case, tested both through this pipeline and directly against raw
      axe-core with no React/esbuild involved. `bypass` is a whole-page
      check ("Page must have means to bypass repeated blocks"), not a
      per-element one, and doesn't fire at all when scanning a single
      rendered component with no landmarks — confirms the document-root
      scope mismatch already flagged below, and rules out even the
      narrower "repair a broken skip-link target" framing floated below,
      since `bypass` doesn't validate `href` targets at all. Substituted
      `input-button-name` and `tabindex` instead (user-approved after
      being shown the probe results) — both confirmed firing cleanly and
      in isolation before fixtures were written. Added fixtures
      `InvalidAriaAttributeValue.tsx` (`aria-valid-attr-value` — invalid
      `aria-checked` enum value), `MissingAriaWidgetName.tsx`
      (`aria-input-field-name` — a `role="textbox"` custom widget with no
      accessible name), `MissingFrameTitle.tsx` (`frame-title`),
      `MissingInputButtonName.tsx` (`input-button-name`), and
      `PositiveTabIndex.tsx` (`tabindex`). Each was verified via a probe
      script to trigger exactly its one target rule and nothing else
      before being wired into a test — several naive candidates (e.g. a
      bare `<div role="switch">`) fire two rules at once
      (`aria-required-attr` + `aria-toggle-field-name`) and had to be
      adjusted (giving it an `aria-label`) to isolate the one under test,
      same discipline the first 5 fixtures already followed.
      `test/pipeline-e2e.test.ts`'s `cases` table now covers all 10 types
      end to end (`generateFix` mocked with a hand-authored ideal fix per
      type, same as before); typecheck/lint/full suite (31 tests, 6 files)
      all pass.

- [x] Framework adapter refactor (2026-08-10): split `context/` into a
      framework-agnostic `index.ts` and a new `context/adapters/` boundary,
      so a future Vue/Svelte adapter can be added without touching
      `detect/`, `generate/`, `verify/`, or `context/index.ts` itself.
      `context/adapters/types.ts` defines the `FrameworkAdapter` interface
      (`id`, `supports(componentPath)`, `gatherElementContext(options)` →
      `FrameworkElementContext`) plus `JsxElementSnapshot`/
      `JsxSourceLocation`, which move there unchanged (kept their names,
      "Jsx" prefix and all, to avoid an unrequested public-API rename —
      `src/index.ts` still re-exports them from `context/`, so this isn't a
      breaking change for library consumers). `context/adapters/react.ts`
      is a verbatim move of every ts-morph-specific function that used to
      live in `context/index.ts` (`locateJsxElement`, `extractPropTypes`,
      the attribute tie-breaker, etc.) behind a single `reactAdapter`
      object. `context/index.ts` now does nothing framework-specific: it
      resolves the component path, picks the first adapter in an `ADAPTERS`
      array whose `supports()` accepts the file extension (today just
      `reactAdapter`), calls `gatherElementContext`, and assembles the
      result into a `FixContext` — same public `gatherContext` signature
      and behavior as before. Deliberately did **not** touch `detect/`'s
      rendering pipeline (esbuild JSX transform + `@testing-library/react` + the `typeof candidate !== 'function'` component check) even though
      it's equally React-specific — the user scoped this refactor to
      `context/` only. That means today's `FrameworkAdapter` only solves
      "locate an element and describe it" for a new framework; actually
      running a Vue/Svelte component through `detect/` to produce
      violations in the first place would need its own adapter-style split
      there first (different rendering/mounting per framework), which is
      unstarted and not implied by this refactor. No behavior changed:
      `gatherContext`'s call signature, `FixContext`'s shape, and every
      error message are identical to before. Confirmed via the full
      existing suite (all 31 tests, including all 3 `context.test.ts`
      cases and all 11 `pipeline-e2e.test.ts` cases) passing unmodified,
      plus a clean `typecheck`/`lint`/`format:check`/`build`.

- [x] Vue support, end to end (2026-08-11): both halves of what the
      framework-adapter refactor above left unstarted are now implemented —
      `context/`'s `FrameworkAdapter` for locating elements, and a new,
      separate `RenderAdapter` split in `detect/` for actually rendering a
      component and producing violations in the first place. `scan()` now
      works on `.vue` files exactly as it does on `.tsx`/`.jsx`, with no
      changes to `generate/`, `verify/`, or `scan.ts` — confirmed via the
      compiled CLI binary against a `.vue` fixture, which correctly detects
      the violation and only fails at Claude credential resolution (no API
      key in this environment), the same proof-of-integration standard used
      for `generate/` itself. **Parser choice, researched and confirmed
      before implementing:** compared `vue-eslint-parser` (what
      `eslint-plugin-vuejs-accessibility` is built on) against
      `@vue/compiler-sfc` (the official compiler package Vue tooling itself
      is built on) by actually installing both and parsing sample SFCs, not
      going by docs. `vue-eslint-parser@10.4.1` requires `eslint` as a peer
      and pulls in `espree`/`eslint-visitor-keys` versions that declare
      `engines: node ^20.19.0 || ^22.13.0 || >=24` — a real conflict with
      this project's `engines: ">=18"` claim and its Node 18.x CI leg, not a
      theoretical one. `@vue/compiler-sfc` has no such constraint and its
      `descriptor.template.ast` gives the same shape ts-morph gives for JSX
      (tag, children, attributes, `loc.{line,column,offset}`), so it was the
      clear choice. User confirmed via AskUserQuestion before any code was
      written. **`context/adapters/vue.ts`** (`FrameworkAdapter`): parses
      with `@vue/compiler-sfc`'s `parse()`, walks `descriptor.template.ast`
      (a `RootNode`/`ElementNode` tree from `@vue/compiler-core`) to locate
      the violating element using the same algorithm as `react.ts` — tag
      name + nth-child + parent tag, with axe's raw HTML attributes as a
      tie-breaker. `parseSelector`/`parseHtmlAttributes` were extracted out
      of `react.ts` into a new shared `context/adapters/axe-selector.ts`,
      since that logic parses axe's own selector/HTML output format and has
      nothing to do with either framework — both adapters now import it
      instead of duplicating it (react.ts keeps its own JSX-specific
      `class`→`className`/`for`→`htmlFor` attribute-name translation
      locally, since Vue templates use the plain HTML names). Prop-type
      extraction targets `<script setup>`'s `defineProps<Props>()` call
      specifically: the script block's text is parsed as a second,
      in-memory ts-morph source file (`useInMemoryFileSystem: true`), then
      the same resolve-a-same-file-interface-or-type-alias logic `react.ts`
      already had is reused. Deliberately out of scope, matching the same
      "cover the common case, not every case" discipline the React adapter
      already uses for its own prop-type extraction: Options API
      (`props: {...}`) components aren't specially handled, and elements
      inside `v-if`/`v-for`/`v-else` branches aren't walked into (those are
      separate AST node types the tree-walk doesn't recurse into) — both
      confirmed as real gaps, not typos, and left for later since none of
      the fixtures need them. **`detect/adapters/vue.ts`** (`RenderAdapter`,
      a new interface — see the module-boundaries note above for why it's
      not the same interface as `context/`'s): compiles the SFC's script and
      template separately via `@vue/compiler-sfc`'s
      `compileScript`/`compileTemplate` (mirroring what
      `vue-loader`/`@vitejs/plugin-vue` do at build time), stitches them
      into one CommonJS module's source text by hand (`const __sfc__ =
<compiled script>; __sfc__.render = <compiled template>;
module.exports = __sfc__;`), bundles that with esbuild exactly like
      `react.ts` does, then mounts it with Vue's own `createApp().mount()`.
      The `export default ...` replace had to be a regex
      (`/export default\s*/`), not a literal string match: a plain
      `<script setup>` compiles to `export default { ... }`, but adding
      `defineProps<Props>()` with a TS type argument changes the shape to
      `export default /*@__PURE__*/_defineComponent({ ... })` — caught by
      testing against `VueTypedMissingAlt.vue` specifically, not assumed.
      **Real bug found and fixed, not just theorized:** the first working
      version threw `Cannot read properties of null (reading
'createElement')` on every render. Root cause, traced to
      `node_modules/@vue/runtime-dom/dist/runtime-dom.cjs.js`: `const doc =
typeof document !== "undefined" ? document : null;` at module scope —
      evaluated once, the first time `vue` is `require`d anywhere in the
      process. Since `detect/adapters/vue.ts` was originally a normal
      top-level `import { createApp } from 'vue'`, that first require
      happened at process start, before `withJsdomEnvironment` had ever set
      up a jsdom `document` global — permanently baking in `doc = null` for
      the rest of the process. (React doesn't have this problem:
      `@testing-library/react`'s `render()` looks up `document` dynamically
      at call time rather than caching it at import time.) Fixed by never
      statically importing `vue`: `requireFreshVue()` deletes every
      `vue`/`@vue/*` entry from `require.cache` and re-requires `vue` fresh
      on every render call, from inside `withJsdomEnvironment`, so
      `runtime-dom`'s cached `doc` always reflects the jsdom instance
      created for that specific call rather than a stale or nonexistent
      one. Same bundle-Vue-in tradeoff as the existing React/duplicate-React
      note in Open Decisions below applies here too (documented there, not
      solved). Separately, Vue's dev-mode "missing required prop" warning
      fires on every scan of a typed component (nothing passes real props
      when scanning in isolation — same as React) and is suppressed via
      `app.config.warnHandler` rather than left to spam scan output.
      **Fixtures**: `VueMissingAlt.vue` (`image-alt`), `VueMissingLabel.vue`
      (`label`), `VueMissingButtonName.vue` (`button-name`),
      `VueMissingLinkName.vue` (`link-name`), `VueDuplicateLandmarks.vue`
      (`landmark-unique`), `VueTypedMissingAlt.vue` (`<script setup
lang="ts">` + `defineProps<T>()`, for prop-type extraction), and
      `VueAccessibleCard.vue` (a clean control) — each verified via a probe
      script to trigger exactly its one target rule (or zero, for the clean
      one) before being wired into a test, same discipline as every
      previous fixture round. `detect/`'s directory-scan `isComponentFile`
      now checks every registered adapter's `supports()` rather than a
      hardcoded extension set, so `.vue` files are picked up automatically
      alongside `.tsx`/`.jsx` in the same directory scan. **Tests**:
      `test/detect.test.ts` gained Vue-specific cases (missing alt, missing
      label, clean component, directory scan discovering `.vue` alongside
      `.tsx`) plus `resolveComponentFiles` now being exercised directly
      rather than only through `detectViolations`. `test/context.test.ts`
      gained 3 Vue cases (element/parent/siblings mapping, a
      landmark-unique relational case, and the `defineProps<T>()` prop-type
      case). `test/pipeline-e2e.test.ts`'s `cases` table gained the 5 core
      Vue types (image-alt, label, button-name, link-name,
      landmark-unique) run through the real detect → context → verify
      pipeline with hand-authored ideal fixes (`generateFix` mocked, same
      as every other entry in that table) — full suite is now 43 tests
      across 6 files, all passing, plus clean
      `typecheck`/`lint`/`format:check`/`build`. **Dependencies added**:
      `vue`, `@vue/compiler-sfc`, `@vue/compiler-core` (all pinned to
      `^3.5.41`, the versions actually tested against) as regular
      `dependencies` — same "bundled, not peer" precedent as
      `react`/`react-dom`. `package.json`'s `description` and `keywords`
      updated to mention Vue. `npm pack --dry-run` re-checked: tarball
      still contains only `dist/`, `LICENSE`, `README.md`, `package.json`
      — the new adapter directories compile into `dist/context/adapters/`
      and `dist/detect/adapters/` as expected, nothing extra leaks in.
      **What's still not covered**: Svelte (structurally ready for via the
      same two adapter interfaces, not started); Vue Options API
      components; and elements inside `v-if`/`v-for`/`v-else`.
      `README.md`'s headline and pipeline-stage descriptions were updated
      to mention Vue alongside React; its "How the verify loop works"
      section's remaining JSX-specific wording (`generate`'s "replacement
      JSX" phrasing, etc.) wasn't audited line-by-line beyond the two spots
      that were flatly wrong.

- [x] GitHub Action (2026-08-11): `action.yml` at the repo root wraps the
      CLI end to end — build the local package into a tarball, install it
      into the consumer's workspace, run `a11y-autofix scan --json`, then
      post the results on the PR. Researched GitHub's current
      suggested-changes API before writing any code (see below), rather
      than assuming the old `position`-based comment format still applied.
      Added a `--json` flag to `cli/`'s `scan` command first (`runScan`
      now takes a `CliScanOptions` extending `ScanOptions` with `json?:
boolean`; `summarize`/`printScanResult` split apart so both the
      human and JSON paths share the same summary computation) — the CLI
      had no machine-readable output before this, so "wraps the existing
      CLI" needed that gap closed first, not worked around by having the
      Action import the library API instead. New `test/cli.test.ts` case
      spies on `console.log` and asserts the full `ScanResult` shape comes
      through unchanged. **API research:** confirmed via GitHub's current
      REST docs that inline suggestions are posted through `POST
/repos/{owner}/{repo}/pulls/{pull_number}/reviews`, with each
      comment's body containing a fenced ` ```suggestion ` block, and
      anchored via `path` + `line`/`side` (single-line) or additionally
      `start_line`/`start_side` (multi-line) — not the older
      diff-`position` field, which the docs still accept but no longer
      lead with. The single fact that shaped the whole design: a review
      comment can only anchor to a line the PR's diff actually shows —
      GitHub's API rejects one anchored elsewhere. That's why a "verified"
      fix isn't sufficient on its own to become an inline suggestion; it
      also has to fall inside the diff, which most of the code below
      exists to determine. **`action/lib/diff.js`** (`parseCommentableLines`):
      parses the unified-diff `patch` text GitHub's pulls-files API
      returns per changed file into the set of new-file line numbers
      actually visible in the diff (added lines plus their surrounding
      hunk context — lines outside every `@@` hunk were never touched by
      the PR and can't be commented on). `isRangeCommentable` requires
      every line in an element's `[startLine, endLine]` to be in that
      set, not just one end of it. **`action/lib/bucket.js`**
      (`bucketViolations`): the confidence gate. "High confidence" = both
      `status === 'verified'` (axe-core re-confirmed the fix) AND the
      location is in the diff (`isRangeCommentable`) — only that
      combination becomes an inline suggestion. Everything else
      (unverified, errored, or verified but outside the diff) goes to the
      summary bucket, tagged with why it isn't inline, so a
      genuinely-verified fix outside the diff is never confused with an
      unverified one in the summary comment's messaging.
      **`action/lib/suggestion.js`** (`buildSuggestionBody`): a GitHub
      suggestion replaces the entire line range it's anchored to, not
      just the substring that changed — so if `oldSnippet` is only part
      of a line (a JSX element inline next to other content), pasting
      `patch.newSnippet` straight into the block would silently drop
      everything else on that line. This applies the patch to the full
      file text first (the same replace-exactly-once logic as
      `src/verify/index.ts`'s `applyPatchToSource`, deliberately
      duplicated rather than imported — see below), then slices out the
      now-fixed line range. Tested explicitly against the
      shares-a-line-with-other-JSX case, not just the common
      single-element-per-line case. **`action/lib/render.js`**: pure
      markdown builders for the inline suggestion comment body and the
      sticky summary comment (marked with a `<!-- a11y-autofix-summary
-->` HTML comment so re-runs find and update the same comment
      instead of spamming a new one per push). **`action/lib/github.js`**
      (`createClient`): a ~70-line REST client using Node's built-in
      `fetch` (stable since Node 18, this package's own `engines` floor)
      — no `@octokit/rest` dependency for the six calls this needs.
      Handles pagination by fetching pages until one comes back short of
      `per_page`. **`action/post-results.js`**: the orchestration script
      `action.yml` invokes. Fetches the PR's changed files, buckets every
      violation, posts one review covering all inline suggestions
      (skipped entirely if there are none) plus the upserted summary
      comment. A genuine bug was found and fixed here via an integration
      test, not just unit tests of the pure pieces: computing each
      violation's path relative to `process.cwd()` without normalizing
      symlinks first (`entry.filePath` comes from detect/context's plain
      `path.resolve()`, which never follows symlinks, while
      `process.cwd()` can already be symlink-resolved — e.g. a macOS temp
      dir under `/tmp` resolving to `/private/tmp`) silently routed every
      violation to the summary bucket, since the textual relative-path
      comparison never matched. Fixed by `realpathSync`-normalizing both
      sides before comparing. `action/post-results.test.js` reproduces
      this with a real temp directory and a stubbed `fetch`, covering: an
      in-diff verified fix becoming an inline suggestion, an unverified
      one going to the summary, updating an existing sticky comment
      instead of duplicating it, and skipping entirely on a
      non-`pull_request` event. **`action/check-unresolved.js`**: backs
      the optional `fail-on-unresolved` input. Deliberately defines
      "unresolved" as `status !== 'verified'` (unverified or errored), not
      "not written to disk" — a verified fix sitting on the PR as an
      acceptable suggestion isn't a failure state for this workflow,
      that's the intended way to resolve it; gating CI red on "nobody
      clicked accept yet" would be needless friction for exactly the
      fixes this Action is most confident in. **`action.yml`**: composite
      action, not Docker — builds the local package from source (`npm ci
&& npm run build && npm pack`) rather than installing the
      last-published npm version, since `--json` is brand new and hasn't
      been published yet; installs the resulting tarball into the
      consumer's workspace (needed so `detect/`'s esbuild bundling
      resolves the consumer's React/Vue copy, not the action's own — same
      reasoning as the existing duplicate-React Open Decision). The scan
      step alone gets `continue-on-error: true` — its non-zero exit code
      on unresolved violations is an expected outcome, not an
      infrastructure failure, and posting still needs to run afterward.
      Supports both `pull_request` and `pull_request_target` triggers;
      `README.md`'s new "GitHub Action" section notes the standard
      fork-PR security caveats for the latter belong to the consumer's
      own workflow, not something this Action changes. Tests: 6 new files
      under `action/` (`diff`, `bucket`, `suggestion`, `render`, plus the
      `post-results`/`check-unresolved` integration tests), 29 tests
      total, all pure-JS (no build step needed to test or run this
      directory — deliberately not TypeScript, so the Action has no
      dependency on `src/`'s compile step; see the suggestion.js
      duplication note above for the one place that tradeoff shows up).
      `eslint.config.js` gained an `action/**/*.js` block (Node globals,
      `@typescript-eslint/no-require-imports` off) mirroring the existing
      `*.config.js` one. Full suite (existing + new) passing, plus a real
      end-to-end smoke test: the actual compiled CLI's `--json` output
      piped through the actual `post-results.js` against a stubbed
      `fetch`, not just synthetic fixtures.

- [x] Patch confidence + one retry (2026-08-12): `scan()` no longer gives
      up after a single failed verification. `scan.ts`'s new
      `resolveViolation` generates a fix, verifies it, and — only if that
      first attempt doesn't verify — retries exactly once, feeding the
      failure back to the model via `generate/`'s new `PreviousAttempt`
      (the rejected `newSnippet` plus `remainingViolations`/
      `newViolations` from `verifyFix`) so the retry has an actual reason
      to produce something different rather than being asked the same
      question twice. `confidence: 'high' | 'medium' | 'low'` records
      which attempt (if either) worked: `'high'` for a first-attempt pass,
      `'medium'` for a fix that needed the retry, `'low'` when both
      attempts failed (`status` stays `'unverified'`, same manual-review
      fallback as before this existed — the retry only ever changes
      `confidence`, never what counts as verified). Confidence can only be
      known after a fix is verified (or not), which by definition
      `generateFix()` alone never knows — a bare call to it produces one
      attempt, not a resolution — so it's not a field on `generate/`'s
      `Patch` type; scan.ts defines a new `ScoredPatch extends Patch`
      (`patch: ScoredPatch` on `ScanViolationFixed`) rather than forcing
      `generateFix()` to fabricate a meaningless confidence value on every
      call, including the ones library consumers make directly without
      ever going through `scan()`. The retry reuses the same `context` —
      re-gathering it would be redundant work, since the violation and
      source file haven't changed between attempts, only the prompt. Real
      cost implication, not hidden: any violation unresolved on the first
      try now costs a second Claude API call plus a second verify render,
      roughly doubling worst-case per-violation cost — worth knowing
      before scanning a large codebase for the first time. Surfaced
      everywhere a `Patch` already was: the CLI's `--json` output needed
      no code change at all (it already serializes the full `ScanResult`,
      and `ScoredPatch` just has one more field); the human-readable
      `printVerificationOutcome` now appends `(confidence: high/medium/
low)` to the verified/unverified line. The GitHub Action's
      `action/lib/bucket.js` gained a third condition alongside `status
=== 'verified'` and "inside the diff": `patch.confidence ===
'high'`, with a new `'verified-not-high-confidence'` reason for
      anything that's genuinely verified but only got there via retry —
      `action/lib/render.js`'s summary entry for that reason includes a
      diff-fenced code block of the actual fix so a human can review and
      apply it with `--write` themselves, and the inline suggestion body
      for a true high-confidence fix now says "(high confidence)"
      explicitly rather than leaving the trust basis implicit. Tests:
      `scan.test.ts` gained a dedicated medium-confidence case (two
      chained `mockImplementationOnce` calls, asserting the retry call
      actually received the first attempt's `previousAttempt`) plus
      confidence/call-count assertions on the existing high- and
      low-confidence cases, including confirming a _thrown_ `generateFix`
      error does not trigger a retry (only a failed verification does).
      `action/lib/bucket.test.js` and `action/lib/render.test.js` each
      gained a medium-confidence case. Full suite: 77 tests across 12
      files, all passing. **Pre-existing flakiness found while verifying,
      investigated but not
      resolved — not part of this feature and not caused by it:** the full
      suite (run repeatedly, both with and without this session's changes
      applied) intermittently fails 3–4 `detect.test.ts` Vue cases with
      `axe.run arguments are invalid`, plus an occasional directory-scan
      timeout. Initially looked file-concurrency-related — `detect/`'s
      `withJsdomEnvironment` mutates process-wide globals for the
      duration of each render, and axe-core is a module-level singleton —
      so a root `vitest.config.ts` with `fileParallelism: false` was added
      as a mitigation. That turned out to be wrong: further testing showed
      `detect.test.ts` fails intermittently even _alone_, with no other
      file involved, both with and without that config — the same 8-test
      file passed 8/8 in one run and failed 4/8 in the next, no code
      changed in between. A stronger attempt (`pool: 'threads'` +
      `poolOptions.threads.singleThread: true`) made things strictly
      worse — it runs tests inside a real `worker_threads` worker, where
      `process.chdir()` (used by `action/post-results.test.js`) throws
      unconditionally, breaking 3 previously-passing tests outright. Both
      the config file and that second attempt were reverted; this repo
      currently ships no `vitest.config.ts` at all, i.e. plain vitest
      defaults, same as before this was investigated. What's established:
      it's real (not a one-off), it's confined to `detect.test.ts`
      specifically (`test/pipeline-e2e.test.ts` exercises the same Vue
      render path far more times per run and has never failed), and it
      predates this session (nothing here touches `detect/`,
      `test/detect.test.ts`, or the Vue adapters). What's not established:
      the actual mechanism — a leading theory is jsdom's per-instance class
      identity (`new JSDOM()` gives each call a fresh `Element`/`Node`
      constructor set) tripping an `instanceof`-style check somewhere in
      axe-core's `normalizeRunParams`, but that's a
      hypothesis, not a confirmed root cause. Left as a known, reproducible
      issue for follow-up investigation rather than a false "fixed" entry
      — see Not started below.

- [x] `--interactive` / `--log-corrections` (2026-08-13): confirmed the
      privacy framing before writing any code, as asked, rather than after
      — grepped the whole codebase first and found zero existing
      telemetry/network code outside the Claude API calls `generate/`
      already makes and the GitHub Action's already-opt-in PR-posting;
      designed `--log-corrections` as explicit-flag-only (no persistent
      config, no env var) so it can never be silently on; and, since
      "nothing sent anywhere" is true of this package's own code but not
      automatically true once a file sits in the user's project directory
      (an ordinary `git add .` could commit and push it), added a concrete
      technical mitigation beyond documentation: `.a11y-autofix/` writes
      its own `.gitignore` containing `*` the first time it's created, so
      the log is excluded from git regardless of the user's own
      `.gitignore` state. Building `--log-corrections` required building
      `--interactive` first — the CLI had no accept/reject/edit prompt at
      all before this (`--write` applied every verified fix
      unconditionally), so "when a user rejects or edits a fix" wasn't a
      moment that could occur yet; this was flagged and confirmed with the
      user before implementing, same as the privacy question. `scan.ts`
      gained two new `ScanOptions` hooks: `onVerifiedFix` (called per
      verified fix, returns `accept` / `reject` / `edit`) and
      `onFixResolved` (fire-and-forget, reports the final outcome for the
      caller's own bookkeeping — cli/'s corrections logger is the only
      current consumer). An edited snippet is re-verified through the
      exact same `verifyFix` call every AI-generated patch gets before
      it's ever eligible to be written — accepting this without
      re-checking would have meant a human-authored edit could reach disk
      with zero guarantee it actually resolves the violation, undermining
      the one property this whole tool is built around. If an edit fails
      verification, `onVerifiedFix` is called again with the failure
      reason attached, looping until accept/reject; a genuine bug was
      caught and fixed while re-reading this logic before testing it, not
      after a test caught it: the `'accept'` branch originally applied
      `latestAttempt` (whatever was last shown to the user) rather than
      the original AI suggestion, meaning accepting right after a failed
      edit attempt would have written that unverified edit to disk. Fixed
      by making `'accept'` unconditionally mean "the original,
      already-verified suggestion" — the only path to applying anything
      else is a fresh edit that itself re-verifies. `src/cli/interactive.ts`
      implements the terminal prompt (y/n/e/q) via plain `node:readline`
      against injectable input/output streams, deliberately not spawning
      `$EDITOR` for the edit case (a real `git commit`-style editor
      integration would be nicer UX but needs a TTY and subprocess
      mocking to test hermetically) — multi-line edits are entered
      line-by-line, terminated by a lone `.`. Testing readline against a
      scripted mock input stream surfaced two real gotchas, not just
      theoretical ones: a `Readable` that signals EOF (`push(null)`)
      makes readline close itself before all queued `question()` calls
      resolve, breaking any test needing more than one answer; and
      pushing every scripted line synchronously in one burst caused
      readline to drop later lines entirely, requiring each line to be
      pushed on its own `setImmediate` tick instead, matching how a real
      typing user's input actually arrives one line at a time. `q` (quit)
      is handled entirely client-side in the handler's own closure state
      (no scan.ts changes needed) — once quit, every subsequent call
      returns `reject` immediately without prompting again.
      `src/cli/corrections-log.ts` writes `.a11y-autofix/corrections.log`
      as JSON Lines (one entry per rejected/edited fix — accepted fixes
      are never logged, since accepting isn't a correction). `cli/index.ts`
      wires both flags in: `--interactive` alone is a dry-run review
      (nothing is ever written regardless of the answer unless `--write`
      is also passed); `--json` combined with `--interactive` is rejected
      outright before scanning, since interleaving prompt text with the
      final JSON on stdout would corrupt it; `--log-corrections` without
      `--interactive` prints a warning and continues rather than erroring,
      since nothing can ever be rejected/edited outside interactive mode
      for it to log. Tests: `test/scan.test.ts` gained 8 cases covering
      accept/reject/edit-succeeds/edit-fails-then-rejects/
      edit-fails-then-succeeds, including one that specifically locks in
      the accept-after-failed-edit fix above. `test/interactive.test.ts`
      (8 cases) and `test/corrections-log.test.ts` (4 cases) are new;
      `test/cli.test.ts` gained 7 integration cases wiring
      `--interactive`/`--log-corrections` through `runScan` (with
      `createInteractiveHandler` mocked — the real prompt flow is already
      covered in `interactive.test.ts`) — one of these caught a second
      real bug, this time in the test code itself: calling
      `mock.mockRestore()` before asserting on `toHaveBeenCalledWith`
      silently zeroed the recorded call history, since `mockRestore()`
      also clears it, not just restores the original implementation;
      fixed by asserting before restoring. Full suite: 104 tests across 14
      files, all passing (excluding the separately-tracked pre-existing
      `detect.test.ts` flakiness above, unrelated to this feature).

- [x] VS Code extension (2026-08-13): new npm workspace at
      `packages/vscode-extension` (`vscode-a11y-autofix`), chosen over a
      separate repo so it can depend on this package via `file:../..`
      instead of a published version, and so `npm run typecheck`/`test` at
      the root can cover it in one command. Root `package.json` gained
      `"workspaces": ["packages/*"]`; empirically confirmed a child
      workspace can't declare a dependency on the monorepo root's own
      package name via a bare `"*"` version (tried it — a real npm 404, it
      goes to the public registry rather than linking locally) — `file:`
      is the correct form, verified to symlink correctly with live-edit
      reflection (no reinstall needed after editing the root package).
      **Reuses, doesn't reimplement:** `detectViolations`, `gatherContext`,
      and `applyPatchToSource` were already exported; `scan.ts`'s private
      `resolveViolation` (generate + verify + one retry + confidence) is
      now exported as `resolveFix` specifically so the extension's fix
      command gets the same retry/confidence behavior `scan()` gives every
      other caller, for one already-located violation, without
      reimplementing that loop or paying for a whole-file `scan()` call.
      **`src/diagnostics.ts`**: turns `detectViolations` +
      `gatherContext` output into VS Code `Diagnostic`s (1-indexed
      line/column from the core library converted to VS Code's 0-indexed
      `Position`); `critical`/`serious` impact maps to `DiagnosticSeverity.Error`,
      everything else to `Warning`. Scans the file **on disk**, never the
      live buffer — both `detectViolations` and `gatherContext`'s
      `FrameworkAdapter`s already read from disk, and mixing a live buffer
      for one with disk for the other risks the squiggle's location
      drifting from what a fix would actually target — which is also why
      `extension.ts` only triggers a rescan on open/save, never on
      keystroke. A syntax error mid-edit (or any `detectViolations`
      failure) yields an empty diagnostic list rather than throwing —
      TypeScript/ESLint already own that error surface. **`src/codeActions.ts`**:
      a `CodeActionProvider` filtering `context.diagnostics` down to this
      extension's own (tagged via `diagnostic.source`), one `CodeAction`
      per match invoking the `a11y-autofix.fix` command with the document
      URI, diagnostic range, and rule id (read from `diagnostic.code`'s
      object form — chosen over a bare string specifically so the Problems
      panel also gets a clickable link to axe-core's own rule docs).
      **`src/applyFix.ts`**: the fix command handler. Refuses to run
      against a dirty document (unsaved edits could shift where the
      violation actually is — same disk-consistency reasoning as
      diagnostics.ts) rather than trying to reconcile buffer and disk
      state. Diagnostics carry no live reference back to the `AxeViolation`
      that produced them, so it re-runs `detectViolations` and
      disambiguates by rule id plus `gatherContext`'s own start position —
      the same position the diagnostic was placed at — rather than
      trusting anything cached from the last scan; if the file changed
      since, no position matches and it reports "couldn't re-locate"
      rather than guessing and fixing the wrong element. Calls `resolveFix`
      for the generate+verify+retry+confidence work, then `applyPatchToSource`
      plus a `WorkspaceEdit` to apply a verified patch — deliberately
      leaves the document dirty afterward (standard VS Code quick-fix
      behavior; the success message says so) rather than force-saving,
      since a verified _fix_ being applied isn't the same as consent to
      _save_. **`src/extension.ts`**: activation wiring only — creates the
      `DiagnosticCollection`, hooks open/save/close/config-change, registers
      the code action provider and both commands
      (`a11y-autofix.fix`/`a11y-autofix.rescan`), and syncs the
      `a11yAutofix.anthropicApiKey` setting into `process.env.ANTHROPIC_API_KEY`
      (the only way for the setting to reach the Anthropic SDK, which reads
      that env var itself) — diagnostics need no key at all, only a fix
      does. **Tests** (18, `vitest`, `vscode` module resolved to a local
      hand-written mock via `test.alias` in the package's own
      `vitest.config.ts` — not `vi.mock`, since `vscode` isn't a real
      resolvable specifier and Vite's test-time alias intercepts resolution
      before that matters): `diagnostics.test.ts` covers extension
      filtering, 1-to-0-indexed range conversion, severity mapping, the
      empty-list-on-throw path, and skip-one-keep-the-rest when a single
      violation's element can't be located; `codeActions.test.ts` covers
      source filtering and both diagnostic-code shapes (object and bare
      string); `applyFix.test.ts` covers the dirty-document guard, the
      re-location miss case, disambiguating two same-rule violations by
      exact position, the verified-apply path (asserting the actual
      `WorkspaceEdit` replacement text), the unverified no-op path, and a
      thrown `resolveFix` reporting an error without touching the
      workspace; `extension.test.ts` is a lighter activation smoke test
      (collection/provider/commands registered, already-open documents
      scanned on activation). **CI wiring**: root `test`/`typecheck`
      scripts now delegate to `npm run <script> --workspaces --if-present`
      after their own root step. Found and fixed a real ordering bug this
      surfaced, not just a CI-config nicety: the extension's `file:../..`
      dependency resolves to the root package's `dist/*.d.ts`, which a
      fresh `npm ci` doesn't build — so `npm run typecheck` failed
      standalone (not just in a particular CI step order) until the root
      `typecheck` script itself was changed to build the root package
      before delegating to the workspace, making `npm run typecheck`
      self-sufficient regardless of invocation order. Also added a root
      `vitest.config.ts` excluding `packages/**` — without it, root's
      zero-config `vitest run` recursively picked up the workspace's own
      test files too, running them without that package's `vscode` alias
      and failing with an unresolvable-module error. Verified the entire
      fix by deleting `dist/` and `node_modules/` in a scratch clone and
      running `npm ci` followed by the exact CI sequence
      (typecheck/lint/format:check/build/test) end to end, not just
      re-running it in an already-built tree. Full monorepo result: 104
      root tests + 18 extension tests, clean typecheck/lint/format:check/build
      at both root and workspace level. **Not done**: not packaged as a
      `.vsix` or published to the Marketplace; no icon/gallery banner;
      `a11y-autofix.rescan` and the API key setting have no dedicated test
      beyond the activation smoke test above.

- [x] VS Code extension: settings, save-wiring proof, Marketplace README,
      vsce packaging (2026-08-14). Four follow-ups to the entry above, one
      of which surfaced a real, non-obvious packaging bug. **Real-time
      on save** was already wired (previous entry); rather than re-verify
      it against a live Extension Host (this environment can't run one),
      added a firing-based test in `extension.test.ts`: it captures the
      actual callback `activate()` registers with
      `onDidSaveTextDocument`/`onDidChangeConfiguration` from the vscode
      mock and invokes it directly, then asserts the diagnostic collection
      was actually updated — stronger than the prior test, which only
      checked that a listener got registered, not that firing it does
      anything. **`a11yAutofix.disabledRules`** (array of axe-core rule
      ids): user explicitly chose the extension-only option after being
      shown that the CLI has no rule-filtering mechanism to match, so
      "matching the CLI config" wasn't achievable as literally requested —
      confirmed via `AskUserQuestion` rather than either silently building
      a mismatched feature or unilaterally scope-creeping into adding CLI
      support. `diagnostics.ts`'s `scanDocument` filters by rule id
      _before_ calling `gatherContext` (the more expensive of the two core
      calls), not after building the diagnostic and discarding it.
      `extension.ts`'s config-change listener now rescans every open
      document when `disabledRules` changes (already existed for the API
      key setting; extended, not duplicated). Required extending the
      `vscode` test mock: `workspace.getConfiguration` previously always
      returned the caller's own default, so tests had no way to simulate a
      non-default setting — added a `configValues` map plus
      `setConfigValue(fullKey, value)` for tests to populate it.
      **`packages/vscode-extension/README.md`**: the Marketplace-facing
      one (distinct from this file and the root README) — features,
      requirements, a settings table, commands, an explanation of the
      disk-not-buffer scanning tradeoff aimed at end users rather than
      contributors, known limitations, and a release-notes section, per
      Marketplace convention. **vsce packaging — real bug found and fixed
      empirically, not just configured:** a plain `vsce package` run
      against the extension as committed genuinely fails: `node_modules/
a11y-autofix` is a _symlink_ (from the `file:../..` workspace
      dependency — see the previous entry), and vsce refuses to package
      any path that resolves outside the extension directory through a
      symlink — confirmed by actually running it and reading the exact
      error (`invalid relative path: extension/../../vitest.config.ts`,
      i.e. it walked through the symlink into this monorepo's own root
      and tripped on the root's own `vitest.config.ts` sitting there).
      **A real mistake made and caught while fixing this, worth recording
      so it isn't repeated:** the first fix attempt ran `npm install
<tarball> --prefix .` _inside_ `packages/vscode-extension` to swap the
      symlink for a real copy in place — this corrupted the actual
      workspace's npm state (subsequent `npm run build` failed with
      dozens of `npm ERR! extraneous`/`invalid` errors, since npm workspace
      hoisting no longer matched the root lockfile). Recovered by deleting
      `packages/vscode-extension/node_modules` and re-running `npm
install` from the root, confirmed clean via `git status` (nothing
      tracked was touched — `node_modules/` is gitignored) plus a full
      typecheck/test pass. **The actual fix**, informed by that failure:
      never mutate this repo's own `node_modules` for packaging. New
      `packages/vscode-extension/scripts/package.js` builds both packages
      normally, then does everything else — `npm pack` the root, copy
      `package.json`/`README.md`/`LICENSE`/`.vscodeignore`/`dist` into a
      fresh `fs.mkdtempSync` scratch directory, rewrite the scratch
      copy's `a11y-autofix` dependency to `file:./<tarball>` (a _tarball_
      file: reference always extracts to a real directory, never a
      symlink — the actual fix, not a workaround), `npm install
--omit=dev` there, then run vsce (via the root-hoisted `node_modules/
.bin/vsce`, since workspace devDependency binaries hoist to the
      monorepo root, not the local package) — entirely inside that
      scratch directory, copying only the resulting `.vsix` back out
      before deleting it. **Verified beyond "vsce didn't error":**
      unzipped the produced `.vsix` and confirmed `node_modules/
a11y-autofix` is a real (non-symlink) directory; loaded the packaged
      `dist/extension.js` in a plain Node process against a hand-stubbed
      `vscode` module and confirmed it requires cleanly — since
      `src/index.ts` eagerly re-exports `detect`/`context`/`generate`/
      `verify`/`scan`, this also proves every one of their heavy runtime
      dependencies (`ts-morph`, `jsdom`, `@vue/compiler-sfc`, `axe-core`,
      `@anthropic-ai/sdk`, `zod`) resolves correctly inside the packaged
      tree, not just the extension's own four small source files. vsce's
      own output is honest about the result, not hidden: 5618 files,
      24.3 MB, with vsce's built-in warning to bundle for size — a real,
      known limitation (this pulls in the core library's full dependency
      tree, unbundled) left as a follow-up rather than papered over or
      silently fixed with a risky full-bundle rewrite of untested scope.
      `.vscodeignore` gained `scripts/**`, `vitest.config.ts`, `*.tgz`,
      `*.vsix`; root `.gitignore` gained `*.vsix`/`*.tgz` so build
      artifacts never get committed. **Second real bug found while
      verifying, unrelated to packaging directly:** root
      `eslint.config.js`'s ignore pattern was `dist/**`/`node_modules/**`
      — matches only top-level `dist/`, not `packages/*/dist/**` — so
      `npm run lint` started failing against the extension's own _compiled
      output_ the moment it had a `dist/` on disk (order-dependent: passed
      before a build had run, failed after). Fixed to `**/dist/**`/`**/
node_modules/**`; also added a `packages/*/scripts/**/*.js` block
      (Node globals, `require` imports allowed) for `package.js` itself,
      mirroring the existing `action/**/*.js` exception. `LICENSE` (MIT)
      copied into the extension package directory — `vsce`/Marketplace
      convention expects one physically present alongside a
      `"license": "MIT"` in `package.json`, not just inherited from the
      monorepo root. `vsce publish` was deliberately never run — it needs
      a personal access token this environment doesn't have and would
      make the extension publicly visible on the Marketplace, a
      one-directional action appropriately left to a human. Full suite
      after all of this: 104 root tests + 23 extension tests (5 new:
      2 settings-filtering cases, 3 wiring-firing cases), clean
      typecheck/lint/format:check/build at both root and workspace level,
      confirmed via the actual `.vsix` build succeeding end to end.

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
  isolated rendering. The Vue render adapter (see the "Vue support" Done
  entry above) makes the identical tradeoff for `vue` — bundled in via
  esbuild rather than left external — for the same reason, and inherits
  the same open risk.
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

## Next violation types — WebAIM Million cross-reference (2026-08-10)

**Caveat up front:** no usage data exists to mine — there are no GitHub
issues yet (repo just went through npm-publish prep) — so this is axe-core's
rule list cross-referenced against the [2025 WebAIM Million
report](https://webaim.org/projects/million/2025) (fetched live), not
usage-informed. Re-derive this once real `--json` output or issues exist.

**Current 5 already cover 5 of WebAIM's top-6 error categories** (96% of
all detected errors across the million homepages): low contrast text
(79.1%, `color-contrast`), missing alt text (55.5%, `image-alt`), missing
form input labels (48.2%, `label`), empty links (45.4%, `link-name`), and
empty buttons (29.6%, `button-name`). Only the 6th — missing document
language (15.8%) — is uncovered, and it's a poor architectural fit (see
below). So the next 5 have to come from farther down WebAIM's frequency
list, weighted by fit to the single-JSX-element-replacement architecture
(`generate/` can only produce a drop-in replacement for one flagged node,
never add a sibling — same constraint already noted in the `label`
prompt-quality finding above).

**Implementation status (2026-08-10):** items 1, 2, and 4 shipped as
recommended — see the "5 more violation types" Done entry above. Items 3
and 5 turned out not to work as described once probed empirically against
real axe-core (not just read about) and were replaced, with the user's
sign-off, by `input-button-name` and `tabindex`; see that same Done entry
for what broke and why. Left the original reasoning below intact rather
than rewriting history.

**Recommended next 5, ranked:**

1. **ARIA attribute correctness** (`aria-valid-attr-value`,
   `aria-required-attr`, `aria-allowed-attr`, `aria-valid-attr`) — 79.4% of
   homepages now use ARIA outside landmarks (up from 74.6% in 2024), and
   WebAIM notes ARIA-heavy pages have _more_ errors on average, not fewer.
   Fix shape: correct/add one attribute value on the flagged node —
   identical difficulty to the existing `image-alt`/`label` fixes. Easy,
   high-value.
2. **ARIA widget accessible names** (`aria-input-field-name`,
   `select-name`, `aria-toggle-field-name`) — the ARIA-widget sibling of
   the existing accessible-names bucket: custom `role="combobox"`/
   `role="switch"` components and native `<select>`, instead of just
   native buttons/links. React component-library UIs (MUI, Radix, in-house
   design systems) lean on these patterns more than the marketing
   homepages WebAIM crawls, so real-world hit rate for this tool's
   audience likely exceeds WebAIM's raw ranking. Easy.
3. **Duplicate IDs** (`duplicate-id`, `duplicate-id-aria`,
   `duplicate-id-active`) — not a headline WebAIM 2025 stat, but a
   perennial top-10 axe finding and mechanically common in component-based
   UIs (a component instantiated twice, a static id copy-pasted). Flag:
   medium difficulty — renaming the flagged id is a single-element edit,
   but if anything elsewhere references it (`aria-labelledby`,
   `htmlFor`/`for`), the fix must find and update that too, and
   `context/` currently only gathers the immediate parent + siblings, which
   may not see a far-away reference. Needs a scoping decision (widen
   context-gathering, or refuse to auto-fix ids with external references)
   before shipping.
4. **Frame titles** (`frame-title`) — not top-line in WebAIM, but a cheap,
   safe, single-attribute fix (`title="..."`) frequent in real React apps
   (embedded maps, video, payment iframes). Same low-risk shape as alt
   text — Claude just needs nearby context (caption, heading, `src`) to
   write something reasonable.
5. **Skip/bypass links** (`bypass`) — 15.3% of homepages have a skip link,
   but 1 in 10 of those is broken, and most pages have none at all. Scope
   narrowly to _repairing broken skip-link targets_ (wrong `href`/missing
   `id` on the target — a legitimate single- or two-element fix), not
   _adding missing skip links_ (requires inserting a new element, which
   the current architecture can't do).

**Flagged as high-frequency but not recommended next — architecture
mismatch, not effort:**

- **`html-has-lang` / `document-title`** (15.8% of pages missing lang) —
  the only new entry in WebAIM's top 6, but `detect/` renders a single
  component into a fresh JSDOM document via `@testing-library/react`; the
  `<html>`/`<title>` a fix would need to touch belongs to the target app's
  root document, not the component under test, and JSDOM supplies its own
  shell. Structurally can't fire under component-level scanning as built.
  Not worth chasing until/unless a whole-app-root scan mode exists.
- **Table markup** (`th-has-data-cells`, `td-headers-attr`,
  `scope-attr-valid`) — WebAIM found only 16.6% of tables have valid
  data-table markup (~83% fail). Very high frequency, but a correct fix
  requires reasoning about the whole table's header/data-cell
  relationships across many elements at once, not one flagged node. Same
  category of problem as headings below — high value, needs an
  architecture change first.
- **Heading structure** (`page-has-heading-one`, `heading-order`,
  `empty-heading`) — also high frequency (39% skipped heading levels,
  16.3% multiple `<h1>`s, 9.8% no headings at all) but correctness depends
  on the whole page's heading sequence, and "no `<h1>` present" means
  inserting an element, which the current architecture can't do (the same
  sibling-insertion gap already flagged for `label` above). Defer until
  that structural limitation is addressed generally.
- **Re-flagging `color-contrast` itself**: it's nominally one of the
  current 5, but `detect/` disables it outright (see the prompt-quality
  review above — JSDOM has no real paint/layout). So contrast isn't
  actually being caught today despite being the single highest-frequency
  category (79.1%). Worth fixing (canvas polyfill, or a real-browser
  render via Playwright) before counting it as delivered, independent of
  this next-5 list.
