# generate/ eval baseline: not yet recorded

No real-model run has been recorded. The harness was committed on 2026-10-30 from an environment with no ANTHROPIC_API_KEY, so no results exist yet — none were fabricated.

To record one: `ANTHROPIC_API_KEY=… npm run eval:real -- --update-baseline`, then commit `evals/baseline.md`. Until then, `npm run eval:compare` exits 2 ("no baseline"), not 0, so a missing baseline is never mistaken for a pass.

## Raw data

<details><summary>Read by <code>npm run eval:compare</code>. Do not edit by hand, except to doctor a report when testing the gate.</summary>

<!-- eval-data:start -->

```json
{
  "format": "a11y-autofix-eval",
  "version": 1,
  "status": "empty",
  "createdAt": "2026-10-30T12:00:00.000Z",
  "reason": "The harness was committed on 2026-10-30 from an environment with no ANTHROPIC_API_KEY, so no results exist yet — none were fabricated."
}
```

<!-- eval-data:end -->

</details>
