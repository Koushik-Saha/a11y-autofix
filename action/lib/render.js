'use strict';

/** The marker used to find-and-update the same summary comment across re-runs, instead of spamming a new one on every push. */
const SUMMARY_MARKER = '<!-- a11y-autofix-summary -->';

/**
 * Body for one inline review comment: violation context plus a
 * ```suggestion block reviewers can accept with a single click. See
 * https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/reviewing-changes-in-a-pull-request/incorporating-feedback-in-your-pull-request
 * for the suggestion syntax this depends on.
 */
function renderSuggestionCommentBody(entry, suggestionBody) {
  const { violation } = entry;
  const impact = violation.impact ?? 'unknown';
  const lines = [
    `**a11y-autofix**: \`${violation.id}\` (${impact}, high confidence) — ${violation.help}`,
    violation.helpUrl ? `[Learn more](${violation.helpUrl})` : null,
    '',
    '```suggestion',
    suggestionBody,
    '```',
  ].filter((line) => line !== null);
  return lines.join('\n');
}

function reasonLabel(reason) {
  switch (reason) {
    case 'unverified':
      return "fix didn't resolve the violation";
    case 'errored':
      return 'a11y-autofix could not generate a fix';
    case 'verified-not-high-confidence':
      return 'verified, but only medium confidence (needed a retry)';
    case 'verified-outside-diff':
      return "verified, but outside this PR's diff";
    default:
      return reason;
  }
}

function summaryTableRow(entry) {
  const { violation, relativePath, reason } = entry;
  const line = entry.context ? entry.context.element.location.startLine : '?';
  return `| \`${relativePath}:${line}\` | \`${violation.id}\` | ${reasonLabel(reason)} |`;
}

function summaryDetailFor(entry) {
  const { violation, relativePath, reason } = entry;
  const line = entry.context ? entry.context.element.location.startLine : '?';
  const header = `**\`${relativePath}:${line}\`** — \`${violation.id}\`: ${violation.help}`;

  if (reason === 'errored') {
    return `${header}\n\n\`\`\`\n${entry.error}\n\`\`\``;
  }

  if (reason === 'unverified') {
    const { remainingViolations, newViolations } = entry.verification;
    const notes = [];
    if (remainingViolations.length > 0) {
      notes.push(`still flagged: ${remainingViolations.map((v) => v.id).join(', ')}`);
    }
    if (newViolations.length > 0) {
      notes.push(`new violations introduced: ${newViolations.map((v) => v.id).join(', ')}`);
    }
    return notes.length > 0 ? `${header}\n\n${notes.join('; ')}` : header;
  }

  if (reason === 'verified-not-high-confidence') {
    const removed = entry.patch.oldSnippet.split('\n').map((line) => `-${line}`);
    const added = entry.patch.newSnippet.split('\n').map((line) => `+${line}`);
    const diff = ['```diff', ...removed, ...added, '```'].join('\n');
    return `${header}\n\nThis fix is verified — axe-core confirms it resolves the violation with no regressions — but it took a retry to get there (the model's first attempt was rejected). That's enough uncertainty to hold it out of the auto-suggested batch; review the diff below and apply it yourself with \`a11y-autofix scan --write\` if it looks right.\n\n${diff}`;
  }

  // verified-outside-diff
  return `${header}\n\nThis fix is verified but this PR doesn't touch that line, so GitHub won't let a suggestion anchor there. Run \`a11y-autofix scan --write\` locally to apply it.`;
}

/**
 * The single sticky PR comment: an overview line, then a table of
 * everything that did NOT become an inline suggestion (with why), plus
 * expandable per-item detail. Returns null when there's nothing to say
 * (no violations at all) other than the all-clear message.
 */
function renderSummaryCommentBody(inline, summary) {
  const parts = [SUMMARY_MARKER, '## a11y-autofix results', ''];

  if (inline.length === 0 && summary.length === 0) {
    parts.push('✅ No accessibility violations found.');
    return parts.join('\n');
  }

  if (inline.length > 0) {
    parts.push(
      `✅ **${inline.length} verified fix${inline.length === 1 ? '' : 'es'}** posted as inline suggested changes on this PR — open the "Files changed" tab and click **Add suggestion to batch** to accept one.`,
      '',
    );
  }

  if (summary.length > 0) {
    parts.push(
      `⚠️ **${summary.length} issue${summary.length === 1 ? '' : 's'} need${summary.length === 1 ? 's' : ''} manual review** (not auto-suggested — see why below):`,
      '',
      '| Location | Rule | Why not inline |',
      '|---|---|---|',
      ...summary.map(summaryTableRow),
      '',
      '<details><summary>Details</summary>',
      '',
      summary.map(summaryDetailFor).join('\n\n'),
      '',
      '</details>',
    );
  }

  return parts.join('\n');
}

module.exports = {
  SUMMARY_MARKER,
  renderSuggestionCommentBody,
  renderSummaryCommentBody,
};
