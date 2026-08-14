/**
 * interactive.ts — the `--interactive` prompt: for each verified fix, asks
 * (y)es / (n)o / (e)dit / (q)uit and returns a `VerifiedFixDecision` scan/
 * can act on. Purely a terminal UI concern — it never decides whether an
 * edit is safe to apply (scan.ts re-verifies every edit itself) and never
 * writes anything to disk or to a log; corrections logging is wired up
 * separately in cli/index.ts via `onFixResolved`, so this module has
 * exactly one job.
 */

import path from 'node:path';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';

import type { VerifiedFixDecision, VerifiedFixPromptContext } from '../scan';

export interface InteractiveHandlerOptions {
  /** Defaults to `process.stdin` — overridable so tests can feed scripted answers. */
  input?: Readable;
  /** Defaults to `process.stdout` — overridable so tests can capture prompt text. */
  output?: Writable;
  /** Used to print relative paths; defaults to `process.cwd()`. */
  projectRoot?: string;
}

export interface InteractiveHandler {
  onVerifiedFix: (context: VerifiedFixPromptContext) => Promise<VerifiedFixDecision>;
  /** Releases the underlying readline interface. Call once after the scan finishes. */
  close: () => void;
}

function displayPath(filePath: string, projectRoot: string): string {
  return path.relative(projectRoot, filePath) || filePath;
}

function printDiff(
  output: Writable,
  relativePath: string,
  patch: { oldSnippet: string; newSnippet: string },
): void {
  output.write(`  --- ${relativePath}\n`);
  output.write(`  +++ ${relativePath}\n`);
  for (const line of patch.oldSnippet.split('\n')) output.write(`  -${line}\n`);
  for (const line of patch.newSnippet.split('\n')) output.write(`  +${line}\n`);
}

function printPrompt(
  output: Writable,
  context: VerifiedFixPromptContext,
  projectRoot: string,
): void {
  const relativePath = displayPath(context.filePath, projectRoot);
  const { violation, patch, editRejected } = context;

  output.write(`\n${relativePath}:${context.startLine}\n`);
  output.write(
    `  [violation] ${violation.id} (${violation.impact ?? 'unknown'}): ${violation.help}\n`,
  );

  if (editRejected) {
    output.write('  Your edit did not resolve it.\n');
    if (editRejected.remainingViolations.length > 0) {
      output.write(
        `    still flagged: ${editRejected.remainingViolations.map((v) => v.id).join(', ')}\n`,
      );
    }
    if (editRejected.newViolations.length > 0) {
      output.write(
        `    new violations introduced: ${editRejected.newViolations.map((v) => v.id).join(', ')}\n`,
      );
    }
    output.write('  Your attempted edit:\n');
  } else {
    output.write('  Suggested fix:\n');
  }

  printDiff(output, relativePath, patch);
}

/**
 * Reads a multi-line replacement from `input`, one line at a time, ending
 * on a line containing only `.` (a plain readline-only prompt, not an
 * `$EDITOR` spawn — keeps this dependency-free and hermetically testable
 * with a scripted input stream; see PLAN.md for that tradeoff).
 */
async function promptForEdit(
  ask: (question: string) => Promise<string>,
  output: Writable,
  currentSnippet: string,
): Promise<string> {
  output.write(
    `  Current text:\n${currentSnippet
      .split('\n')
      .map((line) => `    ${line}`)
      .join('\n')}\n`,
  );
  output.write(
    '  Enter your replacement, one line at a time. Finish with a line containing only ".":\n',
  );

  const lines: string[] = [];
  for (;;) {
    const line = await ask('  > ');
    if (line === '.') break;
    lines.push(line);
  }
  return lines.join('\n');
}

export function createInteractiveHandler(
  options: InteractiveHandlerOptions = {},
): InteractiveHandler {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const projectRoot = options.projectRoot ?? process.cwd();

  const rl = createInterface({ input, output, terminal: false });
  const ask = (question: string): Promise<string> =>
    new Promise((resolve) => rl.question(question, resolve));

  let quitting = false;

  async function onVerifiedFix(context: VerifiedFixPromptContext): Promise<VerifiedFixDecision> {
    if (quitting) {
      return { action: 'reject' };
    }

    printPrompt(output, context, projectRoot);

    for (;;) {
      const raw = await ask('Apply this fix? [y]es / [n]o / [e]dit / [q]uit remaining: ');
      const answer = raw.trim().toLowerCase();

      if (answer === 'y' || answer === 'yes') return { action: 'accept' };
      if (answer === 'n' || answer === 'no') return { action: 'reject' };
      if (answer === 'q' || answer === 'quit') {
        quitting = true;
        return { action: 'reject' };
      }
      if (answer === 'e' || answer === 'edit') {
        const newSnippet = await promptForEdit(ask, output, context.patch.newSnippet);
        return { action: 'edit', newSnippet };
      }

      output.write('Please answer y, n, e, or q.\n');
    }
  }

  return {
    onVerifiedFix,
    close: () => rl.close(),
  };
}
