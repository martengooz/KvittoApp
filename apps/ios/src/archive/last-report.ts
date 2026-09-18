import type { PreflightReport } from '@kvitto/archive';

export interface RememberedPreflight {
  report: PreflightReport;
  /** The file the report describes, needed to apply it. */
  fileUri: string;
}

/**
 * The most recent preflight, handed from the preflight route to the result
 * route.
 *
 * A module-level value rather than a route parameter because a report contains
 * every issue found in the archive, including file paths; serialising that
 * through a URL would put it in navigation state and history.
 */
let remembered: RememberedPreflight | null = null;

export function rememberPreflightReport(report: PreflightReport, fileUri: string): void {
  remembered = { report, fileUri };
}

export function readPreflightReport(): RememberedPreflight | null {
  return remembered;
}

export function clearPreflightReport(): void {
  remembered = null;
}
