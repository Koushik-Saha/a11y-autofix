import * as React from 'react';

interface TypedMissingAltProps {
  imageUrl: string;
  caption: string;
}

export default function TypedMissingAlt({ imageUrl, caption }: TypedMissingAltProps) {
  return (
    <figure>
      <img src={imageUrl} />
      <figcaption>{caption}</figcaption>
    </figure>
  );
}
