import path from 'node:path';

const ROOT = path.resolve(__dirname, '..', '..');

export const FIXTURES_DIR = path.join(ROOT, 'test', 'fixtures');
/** Reports land here; gitignored except baseline.md. */
export const EVALS_DIR = path.join(ROOT, 'evals');
export const BASELINE_PATH = path.join(EVALS_DIR, 'baseline.md');
