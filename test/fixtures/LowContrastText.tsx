import * as React from 'react';

/**
 * Intentionally low-contrast text (light gray on white, ~1.6:1 — WCAG AA
 * requires 4.5:1 for normal text). NOT currently detectable through this
 * pipeline: detect/ disables axe-core's `color-contrast` rule because it
 * needs a real canvas/paint implementation that jsdom can't provide (see
 * PLAN.md). This fixture exists to make that limitation concrete and
 * testable rather than implicit — see test/pipeline-e2e.test.ts.
 */
export default function LowContrastText() {
  return (
    <p style={{ color: '#cccccc', backgroundColor: '#ffffff' }}>
      This text has very low contrast against its background.
    </p>
  );
}
