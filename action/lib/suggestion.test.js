import { describe, expect, it } from 'vitest';

import { applyPatch, buildSuggestionBody } from './suggestion';

describe('applyPatch', () => {
  it('replaces the one occurrence of oldSnippet with newSnippet', () => {
    const source = 'const x = 1;\nconst y = 2;\n';
    const result = applyPatch(source, { oldSnippet: 'const y = 2;', newSnippet: 'const y = 3;' });

    expect(result).toBe('const x = 1;\nconst y = 3;\n');
  });

  it('throws when oldSnippet appears zero or multiple times', () => {
    expect(() => applyPatch('abc', { oldSnippet: 'zzz', newSnippet: 'y' })).toThrow();
    expect(() => applyPatch('abcabc', { oldSnippet: 'abc', newSnippet: 'x' })).toThrow();
  });
});

describe('buildSuggestionBody', () => {
  it('reproduces a single-line fix exactly', () => {
    const fileContent = [
      'import React from "react";',
      '',
      'export default function Gallery() {',
      '  return (',
      '    <img src="x.jpg" />',
      '  );',
      '}',
      '',
    ].join('\n');
    const patch = {
      oldSnippet: '<img src="x.jpg" />',
      newSnippet: '<img src="x.jpg" alt="A gallery photo" />',
    };

    const body = buildSuggestionBody(fileContent, patch, 5, 5);

    expect(body).toBe('    <img src="x.jpg" alt="A gallery photo" />');
  });

  it('preserves surrounding content on the same line when oldSnippet is only part of it', () => {
    // The violation is on an <img> that shares a line with other JSX, not the whole line.
    const fileContent = '<div><h1>Gallery</h1><img src="x.jpg" /></div>\n';
    const patch = {
      oldSnippet: '<img src="x.jpg" />',
      newSnippet: '<img src="x.jpg" alt="A gallery photo" />',
    };

    const body = buildSuggestionBody(fileContent, patch, 1, 1);

    expect(body).toBe('<div><h1>Gallery</h1><img src="x.jpg" alt="A gallery photo" /></div>');
  });

  it('reproduces a multi-line element fix across its full range', () => {
    const fileContent = [
      '<div>',
      '  <button onClick={x}>',
      '    <svg />',
      '  </button>',
      '</div>',
      '',
    ].join('\n');
    const patch = {
      oldSnippet: ['<button onClick={x}>', '    <svg />', '  </button>'].join('\n'),
      newSnippet: ['<button onClick={x} aria-label="Close">', '    <svg />', '  </button>'].join(
        '\n',
      ),
    };

    const body = buildSuggestionBody(fileContent, patch, 2, 4);

    expect(body).toBe(
      ['  <button onClick={x} aria-label="Close">', '    <svg />', '  </button>'].join('\n'),
    );
  });
});
