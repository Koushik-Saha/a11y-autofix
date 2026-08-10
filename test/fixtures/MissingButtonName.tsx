import * as React from 'react';

export default function MissingButtonName() {
  return (
    <div>
      <h2>Payment successful</h2>
      <p>Your order has been confirmed.</p>
      <button onClick={() => {}}>
        <svg width="16" height="16" aria-hidden="true" focusable="false">
          <line x1="1" y1="1" x2="15" y2="15" stroke="currentColor" />
          <line x1="15" y1="1" x2="1" y2="15" stroke="currentColor" />
        </svg>
      </button>
    </div>
  );
}
