import * as React from 'react';

export default function MissingInputButtonName() {
  return (
    <form>
      <label htmlFor="search">Search</label>
      <input id="search" type="text" name="search" />
      <input type="button" onClick={() => {}} />
    </form>
  );
}
