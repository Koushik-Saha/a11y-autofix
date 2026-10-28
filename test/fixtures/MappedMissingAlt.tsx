import * as React from 'react';

const photos = ['a.jpg', 'b.jpg', 'c.jpg'];

/**
 * One JSX <img> rendered three times by .map(): three axe-core nodes, but
 * a single source element — so a single patch.
 */
export default function MappedMissingAlt() {
  return (
    <div>
      {photos.map((src) => (
        <img key={src} src={src} />
      ))}
    </div>
  );
}
