'use strict';

const API_ROOT = 'https://api.github.com';
const API_VERSION = '2022-11-28';

/**
 * Minimal GitHub REST API client using Node's built-in `fetch` (stable
 * since Node 18, matching this package's own `engines` floor) — no
 * @octokit dependency needed for the handful of calls this action makes.
 * See https://docs.github.com/en/rest/quickstart for the auth/header
 * format this follows.
 */
function createClient(token) {
  async function request(method, path, body) {
    const response = await fetch(`${API_ROOT}${path}`, {
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': API_VERSION,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`GitHub API ${method} ${path} failed: ${response.status} ${text}`);
    }

    if (response.status === 204) return null;
    return response.json();
  }

  /** Follows GitHub's Link-header pagination until a page comes back short of `perPage`. */
  async function requestAllPages(path, perPage = 100) {
    const results = [];
    let page = 1;
    for (;;) {
      const separator = path.includes('?') ? '&' : '?';
      // Pages must be fetched in order to know whether the next one exists.
      const items = await request('GET', `${path}${separator}per_page=${perPage}&page=${page}`);
      results.push(...items);
      if (items.length < perPage) break;
      page += 1;
    }
    return results;
  }

  return {
    listPullRequestFiles: (owner, repo, pullNumber) =>
      requestAllPages(`/repos/${owner}/${repo}/pulls/${pullNumber}/files`),

    createReview: (owner, repo, pullNumber, review) =>
      request('POST', `/repos/${owner}/${repo}/pulls/${pullNumber}/reviews`, review),

    listIssueComments: (owner, repo, issueNumber) =>
      requestAllPages(`/repos/${owner}/${repo}/issues/${issueNumber}/comments`),

    createIssueComment: (owner, repo, issueNumber, body) =>
      request('POST', `/repos/${owner}/${repo}/issues/${issueNumber}/comments`, { body }),

    updateIssueComment: (owner, repo, commentId, body) =>
      request('PATCH', `/repos/${owner}/${repo}/issues/comments/${commentId}`, { body }),
  };
}

module.exports = { createClient };
