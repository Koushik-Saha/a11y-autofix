import * as React from 'react';

export default function AccessibleCard() {
  return (
    <section aria-label="Profile card">
      <img src="https://example.com/avatar.jpg" alt="User avatar" />
      <label htmlFor="username">Username</label>
      <input id="username" type="text" name="username" />
    </section>
  );
}
