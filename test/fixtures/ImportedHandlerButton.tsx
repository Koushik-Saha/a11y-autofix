import * as React from 'react';

import { archiveProject } from './lib/projectActions';

// An icon-only button whose handler is imported from a local file:
// context/ follows the import and includes archiveProject's body.
export default function ImportedHandlerButton() {
  return (
    <div>
      <h2>Website redesign</h2>
      <button onClick={archiveProject}>
        <svg width="16" height="16" aria-hidden="true" focusable="false">
          <rect x="1" y="3" width="14" height="10" stroke="currentColor" />
        </svg>
      </button>
    </div>
  );
}
