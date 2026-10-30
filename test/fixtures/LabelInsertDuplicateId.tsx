import * as React from 'react';

/**
 * The naive label fix here — id="email" on the input plus
 * <label htmlFor="email"> — reuses the hint paragraph's id, so the label's
 * target is ambiguous. axe-core flags that only as "needs review"
 * (duplicate-id-aria); verify/ must still reject it.
 */
export default function LabelInsertDuplicateId() {
  return (
    <form>
      <p id="email">We never share your email address.</p>
      <input type="email" name="email" />
      <button type="submit">Subscribe</button>
    </form>
  );
}
