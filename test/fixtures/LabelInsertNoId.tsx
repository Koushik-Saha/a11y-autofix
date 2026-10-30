import * as React from 'react';

/**
 * A bare <input> with no id and no label. The idiomatic fix is two parts:
 * give the input an id and insert a real <label htmlFor> before it — an
 * insertion patch (see test/insertion.test.ts).
 */
export default function LabelInsertNoId() {
  return (
    <form>
      <h2>Newsletter</h2>
      <input type="email" name="email" />
      <button type="submit">Subscribe</button>
    </form>
  );
}
