import * as React from 'react';

export default function MissingFrameTitle() {
  return (
    <div>
      <h2>Our location</h2>
      <iframe src="https://maps.example.com/embed?q=headquarters" width="600" height="400" />
    </div>
  );
}
