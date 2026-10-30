import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

// action.yml is YAML, but these checks only need its text: no YAML
// parser dependency for a handful of assertions.
const actionYml = readFileSync(path.join(__dirname, '..', 'action.yml'), 'utf8');

/** The step block (from its "- name:" line to the next step) with this name. */
function step(name) {
  const start = actionYml.indexOf(`- name: ${name}`);
  if (start === -1) throw new Error(`no step named "${name}"`);
  const next = actionYml.indexOf('\n    - name:', start + 1);
  return actionYml.slice(start, next === -1 ? undefined : next);
}

describe('action.yml: upload-sarif', () => {
  it('declares the input, off by default', () => {
    expect(actionYml).toMatch(/\n {2}upload-sarif:\n(?: {4}.*\n)*? {4}default: 'false'\n/);
  });

  it('converts the saved scan result instead of scanning again', () => {
    const convert = step('Convert the results to SARIF');
    expect(convert).toContain("if: inputs.upload-sarif == 'true'");
    expect(convert).toContain(
      'npx a11y-autofix report "${{ runner.temp }}/a11y-autofix-result.json" --format sarif --output "${{ runner.temp }}/a11y-autofix.sarif"',
    );
    // The scan itself runs exactly once.
    expect(actionYml.match(/npx a11y-autofix scan /g)).toHaveLength(1);
  });

  it('uploads with github/codeql-action/upload-sarif, only when asked', () => {
    const upload = step('Upload SARIF to code scanning');
    expect(upload).toContain("if: inputs.upload-sarif == 'true'");
    expect(upload).toMatch(/uses: github\/codeql-action\/upload-sarif@v\d+/);
    expect(upload).toContain('sarif_file: ${{ runner.temp }}/a11y-autofix.sarif');
    expect(upload).toContain('category: a11y-autofix');
  });

  it('runs the conversion after the scan and before the unresolved gate', () => {
    const order = [
      '- name: Run a11y-autofix scan',
      '- name: Convert the results to SARIF',
      '- name: Upload SARIF to code scanning',
      '- name: Fail if unresolved violations remain',
    ].map((line) => actionYml.indexOf(line));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
});
