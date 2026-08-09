#!/usr/bin/env node

/**
 * cli/ — the bin entry point. Wires detect/ -> context/ -> generate/ -> verify/
 * into a single scan command and renders verified fix diffs for the user.
 */

import { Command } from 'commander';

import { version } from '../../package.json';

const program = new Command();

program
  .name('a11y-autofix')
  .description(
    'Scan React components with axe-core, generate verified WCAG fix diffs via the Claude API.',
  )
  .version(version);

program
  .command('scan')
  .description(
    'Scan a React component (or directory) for WCAG violations and propose verified fixes',
  )
  .argument('<path>', 'path to a component file or directory')
  .action((_path: string) => {
    throw new Error('Not implemented');
  });

program.parse(process.argv);
