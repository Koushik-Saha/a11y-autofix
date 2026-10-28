import * as React from 'react';

/**
 * Intentionally low-contrast text (light gray on white, ~1.6:1 — WCAG AA
 * requires 4.5:1 for normal text). Detected only in browser mode
 * (`scan --browser`): the default jsdom mode disables axe-core's
 * `color-contrast` rule because jsdom has no layout/paint to measure
 * against (see PLAN.md). test/pipeline-e2e.test.ts pins the jsdom
 * behavior; test/browser-detect.test.ts covers detection and a verified
 * fix in browser mode.
 */
export default function LowContrastText() {
  return (
    <p style={{ color: '#cccccc', backgroundColor: '#ffffff' }}>
      This text has very low contrast against its background.
    </p>
  );
}
