import * as React from 'react';

/**
 * Identical <img>s inside identical parents: only the parent's position
 * ("section:nth-child(2) > img") tells them apart.
 */
export default function DuplicateMissingAltInCards() {
  return (
    <div>
      <section>
        <img src="https://example.com/photo.jpg" />
      </section>
      <section>
        <img src="https://example.com/photo.jpg" />
      </section>
    </div>
  );
}
