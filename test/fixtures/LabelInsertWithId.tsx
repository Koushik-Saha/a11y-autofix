import * as React from 'react';

/**
 * An unlabeled <input> that already has an id: a real <label htmlFor>
 * inserted before it fixes it without touching the input at all.
 */
export default function LabelInsertWithId() {
  return (
    <form>
      <h2>Newsletter</h2>
      <input id="newsletter-email" type="email" name="email" />
      <button type="submit">Subscribe</button>
    </form>
  );
}
