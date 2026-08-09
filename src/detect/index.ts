/**
 * detect/ — runs axe-core against rendered React components and reports
 * WCAG violations. This is the entry point of the pipeline: its output
 * feeds context/, and its verdict format is reused by verify/ to confirm
 * a fix actually resolved the violation.
 */

export interface AxeNodeResult {
  target: string[];
  html: string;
  failureSummary?: string;
}

export interface AxeViolation {
  id: string;
  impact: 'minor' | 'moderate' | 'serious' | 'critical' | null;
  description: string;
  help: string;
  helpUrl: string;
  nodes: AxeNodeResult[];
}

export interface DetectOptions {
  componentPath: string;
}

export interface DetectResult {
  componentPath: string;
  violations: AxeViolation[];
}

export async function detectViolations(_options: DetectOptions): Promise<DetectResult> {
  throw new Error('Not implemented');
}
