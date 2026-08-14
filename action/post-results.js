'use strict';

/**
 * post-results.js — the Action's second half. Takes the JSON a11y-autofix
 * scan --json wrote to RESULT_FILE and turns it into PR feedback:
 *
 *  - Every VERIFIED fix whose location falls inside this PR's diff becomes
 *    an inline review comment carrying a GitHub ```suggestion block, so a
 *    reviewer can accept it with one click (see
 *    https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/reviewing-changes-in-a-pull-request/incorporating-feedback-in-your-pull-request).
 *    These are posted together as one pull request review — see
 *    https://docs.github.com/en/rest/pulls/reviews#create-a-review-for-a-pull-request.
 *  - Everything else — unverified, errored, or a verified fix outside the
 *    diff (GitHub's API rejects a comment anchored outside it, see
 *    lib/diff.js) — goes into a single sticky summary comment instead,
 *    updated in place on re-runs rather than reposted on every push.
 *
 * Deliberately not using @octokit/rest: this only needs a handful of REST
 * calls, and Node 18+'s built-in `fetch` (this package's own `engines`
 * floor) covers that without adding a dependency.
 */

const { readFileSync, realpathSync } = require('node:fs');
const path = require('node:path');

const { parseCommentableLines } = require('./lib/diff');
const { bucketViolations } = require('./lib/bucket');
const { buildSuggestionBody } = require('./lib/suggestion');
const {
  SUMMARY_MARKER,
  renderSuggestionCommentBody,
  renderSummaryCommentBody,
} = require('./lib/render');
const { createClient } = require('./lib/github');

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable "${name}"`);
  }
  return value;
}

function loadPullRequestEvent() {
  const eventPath = requireEnv('GITHUB_EVENT_PATH');
  const event = JSON.parse(readFileSync(eventPath, 'utf8'));
  if (!event.pull_request) {
    return null;
  }
  return { number: event.pull_request.number, headSha: event.pull_request.head.sha };
}

function loadScanResult(resultFile) {
  let raw;
  try {
    raw = readFileSync(resultFile, 'utf8');
  } catch (error) {
    throw new Error(`Could not read scan result file "${resultFile}": ${error.message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Scan result file "${resultFile}" is not valid JSON (did the scan step crash before finishing?): ${error.message}`,
    );
  }
}

async function buildCommentableLinesByFile(client, owner, repo, pullNumber) {
  const files = await client.listPullRequestFiles(owner, repo, pullNumber);
  const map = new Map();
  for (const file of files) {
    map.set(file.filename, parseCommentableLines(file.patch));
  }
  return map;
}

function buildReviewComment(entry) {
  const fileContent = readFileSync(entry.filePath, 'utf8');
  const { startLine, endLine } = entry.context.element.location;
  const suggestionBody = buildSuggestionBody(fileContent, entry.patch, startLine, endLine);

  const comment = {
    path: entry.relativePath,
    body: renderSuggestionCommentBody(entry, suggestionBody),
    line: endLine,
    side: 'RIGHT',
  };
  if (startLine !== endLine) {
    comment.start_line = startLine;
    comment.start_side = 'RIGHT';
  }
  return comment;
}

async function upsertSummaryComment(client, owner, repo, pullNumber, body) {
  const existing = await client.listIssueComments(owner, repo, pullNumber);
  const previous = existing.find((comment) => comment.body?.startsWith(SUMMARY_MARKER));

  if (previous) {
    await client.updateIssueComment(owner, repo, previous.id, body);
  } else {
    await client.createIssueComment(owner, repo, pullNumber, body);
  }
}

async function main() {
  const token = requireEnv('GITHUB_TOKEN');
  const resultFile = requireEnv('RESULT_FILE');
  const reviewEvent = process.env.REVIEW_EVENT || 'COMMENT';
  const [owner, repo] = requireEnv('GITHUB_REPOSITORY').split('/');

  const pullRequest = loadPullRequestEvent();
  if (!pullRequest) {
    console.log('Not a pull_request event — nothing to post. Skipping.');
    return;
  }

  const scanResult = loadScanResult(resultFile);
  const client = createClient(token);

  const commentableLinesByFile = await buildCommentableLinesByFile(
    client,
    owner,
    repo,
    pullRequest.number,
  );
  // realpath both sides before comparing: `entry.filePath` comes from
  // detect/context's plain `path.resolve()` (never follows symlinks),
  // while `process.cwd()` can return an already-symlink-resolved path
  // (e.g. a macOS temp dir under `/tmp` resolving to `/private/tmp`) —
  // without normalizing both the same way, a textually-correct-looking
  // path.relative() call can produce `../../../actual/path` instead of a
  // clean relative path, silently routing every fix to the summary bucket.
  const workspaceRoot = realpathSync(process.cwd());
  const toRelativePath = (absolutePath) => path.relative(workspaceRoot, realpathSync(absolutePath));
  const { inline, summary } = bucketViolations(scanResult, commentableLinesByFile, toRelativePath);

  let reviewPostFailure = null;
  if (inline.length > 0) {
    const comments = inline.map(buildReviewComment);
    try {
      await client.createReview(owner, repo, pullRequest.number, {
        commit_id: pullRequest.headSha,
        event: reviewEvent,
        body: `a11y-autofix found ${comments.length} verified accessibility fix${comments.length === 1 ? '' : 'es'} — see the inline suggestion${comments.length === 1 ? '' : 's'} below.`,
        comments,
      });
    } catch (error) {
      reviewPostFailure = error.message;
      console.error(`Failed to post inline suggestions: ${error.message}`);
    }
  }

  let summaryBody = renderSummaryCommentBody(inline, summary);
  if (reviewPostFailure) {
    summaryBody += `\n\n---\n⚠️ Posting ${inline.length} inline suggestion(s) failed: ${reviewPostFailure}`;
  }
  await upsertSummaryComment(client, owner, repo, pullRequest.number, summaryBody);

  const postedCount = reviewPostFailure ? 0 : inline.length;
  console.log(
    `Posted ${postedCount} inline suggestion(s) and a summary covering ${summary.length} item(s).`,
  );
}

module.exports = { main };

/* c8 ignore start -- exercised via the actual composite action step, not unit tests */
if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}
/* c8 ignore stop */
