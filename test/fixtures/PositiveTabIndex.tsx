import * as React from 'react';

export default function PositiveTabIndex() {
  return (
    <div>
      <h2>Quick actions</h2>
      <button tabIndex={3}>Save draft</button>
    </div>
  );
}
