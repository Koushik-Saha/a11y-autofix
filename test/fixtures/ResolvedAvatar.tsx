import * as React from 'react';

// src is a constant built from another constant: context/ resolves it to
// "/img/team/ceo-portrait.jpg" for the fix prompt.
const TEAM_IMAGES = '/img/team';
const avatarUrl = `${TEAM_IMAGES}/ceo-portrait.jpg`;

export default function ResolvedAvatar() {
  return (
    <div>
      <h2>Our team</h2>
      <img src={avatarUrl} />
    </div>
  );
}
