/**
 * report/ — renders a ScanResult as SARIF 2.1.0 (for GitHub code scanning
 * and other SARIF tools) or as a standalone HTML report. Pure functions of
 * the result: nothing here scans, calls the model, or writes files.
 */

export { FIX_STATUS_LABELS, reportItems, wcagInfo } from './items';
export type { FixStatus, ReportItem, WcagInfo } from './items';
export { IMPACT_TO_LEVEL, SARIF_SCHEMA_URI, toSarif } from './sarif';
export type { SarifLog, SarifOptions, SarifResult, SarifRule } from './sarif';
export { escapeHtml, toHtmlReport } from './html';
export type { HtmlReportOptions } from './html';

export type ReportFormat = 'sarif' | 'html';
