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

  it('with a position, replaces that occurrence even when the snippet repeats', () => {
    const source = '<img />\n<img />\n';
    const patch = {
      oldSnippet: '<img />',
      newSnippet: '<img alt="b" />',
      position: { start: 8, end: 15 },
    };

    expect(applyPatch(source, patch)).toBe('<img />\n<img alt="b" />\n');
  });

  it('with a position, throws when the file changed since the scan', () => {
    const patch = {
      oldSnippet: '<img />',
      newSnippet: '<img alt="b" />',
      position: { start: 8, end: 15 },
    };

    expect(() => applyPatch('// edited\n<img />\n<img />\n', patch)).toThrow(
      /File changed since scan/,
    );
    expect(() => applyPatch('<img />', patch)).toThrow(/File changed since scan/);
  });

  it('inserts newSnippet literally, even with "$&"-style sequences', () => {
    const patch = { oldSnippet: '<img />', newSnippet: '<img alt="$&" />' };

    expect(applyPatch('a <img /> b', patch)).toBe('a <img alt="$&" /> b');
  });
});

describe('buildSuggestionBody', () => {
  it("builds each of two identical elements' suggestions from its own position", () => {
    const fileContent = [
      '<div>',
      '  <img src="x.jpg" />',
      '  <img src="x.jpg" />',
      '</div>',
      '',
    ].join('\n');
    const oldSnippet = '<img src="x.jpg" />';
    const newSnippet = '<img src="x.jpg" alt="A photo" />';
    const first = fileContent.indexOf(oldSnippet);
    const second = fileContent.indexOf(oldSnippet, first + 1);

    const at = (start) => ({
      oldSnippet,
      newSnippet,
      position: { start, end: start + oldSnippet.length },
    });

    expect(buildSuggestionBody(fileContent, at(first), 2, 2)).toBe(`  ${newSnippet}`);
    expect(buildSuggestionBody(fileContent, at(second), 3, 3)).toBe(`  ${newSnippet}`);
    expect(applyPatch(fileContent, at(second)).split('\n')[1]).toBe(`  ${oldSnippet}`);
  });

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
