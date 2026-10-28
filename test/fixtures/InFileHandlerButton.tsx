import * as React from 'react';

// An icon-only button whose handler is defined in this file: context/
// includes handleDelete's body so the label can say what it does.
export default function InFileHandlerButton() {
  const handleDelete = () => {
    removeTeamMember('jane-doe');
  };

  return (
    <div>
      <h2>Jane Doe</h2>
      <button onClick={handleDelete}>
        <svg width="16" height="16" aria-hidden="true" focusable="false">
          <path d="M2 4h12M5 4V2h6v2M4 4l1 10h6l1-10" stroke="currentColor" />
        </svg>
      </button>
    </div>
  );
}

function removeTeamMember(id: string): void {
  console.info(`removing ${id}`);
}
