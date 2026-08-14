import * as React from 'react';

export default function InvalidAriaAttributeValue() {
  return (
    <div>
      <h2>Notification preferences</h2>
      <div
        role="checkbox"
        aria-checked="maybe"
        aria-label="Email me about product updates"
        tabIndex={0}
      />
    </div>
  );
}
