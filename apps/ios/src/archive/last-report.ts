import type { PreflightReport } from '@kvitto/archive';

/**
 * The most recent preflight, handed from the preflight route to the result
 * route.
 *
 * A module-level value rather than a route parameter because a report contains
 * every issue found in the archive, including file paths; serialising that
 * through a URL would put it in navigation state and history. It is cleared
 * when read so a stale report cannot be shown as if it were fresh.
 */
let lastReport: PreflightReport | null = null;

export function rememberPreflightReport(report: PreflightReport): void {
  lastReport = report;
}

export function readPreflightReport(): PreflightReport | null {
  return lastReport;
}

export function clearPreflightReport(): void {
  lastReport = null;
}
