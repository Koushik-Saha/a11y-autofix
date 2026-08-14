'use strict';

/**
 * check-unresolved.js — the optional gate `fail-on-unresolved: true` wires
 * up. Runs after post-results.js, so anything worth failing the job over
 * has already been posted to the PR as either a suggestion or a summary
 * item; this step only decides whether the job itself should go red.
 *
 * "Unresolved" here means `status !== 'verified'` — an unverified or
 * errored violation a11y-autofix could not confidently fix on its own.
 * A verified fix does NOT count as unresolved, even though nothing wrote
 * it to disk: it's sitting on the PR as a one-click-acceptable suggestion
 * (see post-results.js), which is the intended way to resolve it in this
 * workflow. Gating CI red on "a fix exists but nobody clicked accept yet"
 * would be needless friction for exactly the fixes this Action is most
 * confident in.
 */

const { readFileSync } = require('node:fs');

function main() {
  const resultFile = process.env.RESULT_FILE;
  if (!resultFile) {
    throw new Error('Missing required environment variable "RESULT_FILE"');
  }

  const scanResult = JSON.parse(readFileSync(resultFile, 'utf8'));
  const unresolved = scanResult.violations.filter((entry) => entry.status !== 'verified');

  if (unresolved.length === 0) {
    console.log('No unresolved violations (unverified/errored) — nothing to fail on.');
    return;
  }

  console.error(
    `${unresolved.length} unresolved violation(s) found (unverified or errored) — failing per fail-on-unresolved. See the PR summary comment for details.`,
  );
  process.exitCode = 1;
}

module.exports = { main };

/* c8 ignore start -- exercised via the actual composite action step, not unit tests */
if (require.main === module) {
  main();
}
/* c8 ignore stop */
