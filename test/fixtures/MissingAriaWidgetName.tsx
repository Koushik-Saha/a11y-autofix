import * as React from 'react';

export default function MissingAriaWidgetName() {
  return (
    <div>
      <h2>Leave a comment</h2>
      <div role="textbox" contentEditable="true" />
    </div>
  );
}
