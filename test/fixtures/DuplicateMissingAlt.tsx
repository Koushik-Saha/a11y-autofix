import * as React from 'react';

/**
 * Two byte-for-byte identical offending <img> elements. axe-core reports
 * them as one image-alt violation with two nodes; each must get its own
 * patch, applied at its own position (see test/patch-position.test.ts).
 */
export default function DuplicateMissingAlt() {
  return (
    <div>
      <img src="https://example.com/photo.jpg" />
      <img src="https://example.com/photo.jpg" />
    </div>
  );
}
