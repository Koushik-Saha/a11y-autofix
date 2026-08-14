import { describe, expect, it } from 'vitest';

import { SUMMARY_MARKER, renderSuggestionCommentBody, renderSummaryCommentBody } from './render';

describe('renderSuggestionCommentBody', () => {
  it('includes the rule id, impact, help text, and a suggestion block', () => {
    const entry = {
      violation: {
        id: 'image-alt',
        impact: 'critical',
        help: 'Images must have alternative text',
        helpUrl: 'https://dequeuniversity.com/rules/axe/image-alt',
      },
    };

    const body = renderSuggestionCommentBody(entry, '<img src="x.jpg" alt="A photo" />');

    expect(body).toContain('`image-alt`');
    expect(body).toContain('(critical, high confidence)');
    expect(body).toContain('Images must have alternative text');
    expect(body).toContain('[Learn more](https://dequeuniversity.com/rules/axe/image-alt)');
    expect(body).toContain('```suggestion\n<img src="x.jpg" alt="A photo" />\n```');
  });

  it('omits the learn-more link when helpUrl is missing', () => {
    const entry = {
      violation: { id: 'label', impact: null, help: 'Form elements must have labels' },
    };

    const body = renderSuggestionCommentBody(entry, '<input aria-label="Email" />');

    expect(body).not.toContain('Learn more');
    expect(body).toContain('(unknown, high confidence)');
  });
});

describe('renderSummaryCommentBody', () => {
  it('always starts with the sticky marker so re-runs can find and update it', () => {
    const body = renderSummaryCommentBody([], []);
    expect(body.startsWith(SUMMARY_MARKER)).toBe(true);
  });

  it('reports an all-clear message when there is nothing to show', () => {
    const body = renderSummaryCommentBody([], []);
    expect(body).toContain('No accessibility violations found');
  });

  it('counts inline suggestions and lists summary-only items with why they are not inline', () => {
    const inline = [{}, {}];
    const summary = [
      {
        violation: { id: 'label', help: 'x' },
        relativePath: 'src/Form.tsx',
        reason: 'unverified',
        context: { element: { location: { startLine: 4 } } },
        verification: { remainingViolations: [{ id: 'label' }], newViolations: [] },
      },
      {
        violation: { id: 'button-name', help: 'y' },
        relativePath: 'src/Toolbar.tsx',
        reason: 'errored',
        error: 'Claude API error: rate limited',
      },
      {
        violation: { id: 'image-alt', help: 'z' },
        relativePath: 'src/Old.tsx',
        reason: 'verified-outside-diff',
        context: { element: { location: { startLine: 9 } } },
      },
    ];

    const body = renderSummaryCommentBody(inline, summary);

    expect(body).toContain('2 verified fixes');
    expect(body).toContain('3 issues need manual review');
    expect(body).toContain('src/Form.tsx:4');
    expect(body).toContain("fix didn't resolve the violation");
    expect(body).toContain('src/Toolbar.tsx:?');
    expect(body).toContain('a11y-autofix could not generate a fix');
    expect(body).toContain('Claude API error: rate limited');
    expect(body).toContain('src/Old.tsx:9');
    expect(body).toContain("outside this PR's diff");
    expect(body).toContain('still flagged: label');
  });

  it('shows a diff and explains why a medium-confidence verified fix is not auto-suggested', () => {
    const summary = [
      {
        violation: { id: 'image-alt', help: 'Images must have alternative text' },
        relativePath: 'src/Avatar.tsx',
        reason: 'verified-not-high-confidence',
        context: { element: { location: { startLine: 8 } } },
        patch: {
          oldSnippet: '<img src={avatarUrl} />',
          newSnippet: '<img src={avatarUrl} alt="User avatar" />',
        },
      },
    ];

    const body = renderSummaryCommentBody([], summary);

    expect(body).toContain('src/Avatar.tsx:8');
    expect(body).toContain('needed a retry');
    expect(body).toContain('took a retry to get there');
    expect(body).toContain('```diff');
    expect(body).toContain('-<img src={avatarUrl} />');
    expect(body).toContain('+<img src={avatarUrl} alt="User avatar" />');
  });

  it('uses singular wording for exactly one item in each bucket', () => {
    const inline = [{}];
    const summary = [
      {
        violation: { id: 'label', help: 'x' },
        relativePath: 'src/Form.tsx',
        reason: 'unverified',
        context: { element: { location: { startLine: 4 } } },
        verification: { remainingViolations: [], newViolations: [] },
      },
    ];

    const body = renderSummaryCommentBody(inline, summary);

    expect(body).toContain('1 verified fix**');
    expect(body).toContain('1 issue needs manual review');
  });
});
