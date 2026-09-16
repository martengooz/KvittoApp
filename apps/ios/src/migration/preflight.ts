import { preflightArchive, type PreflightOptions, type PreflightReport } from '@kvitto/archive';

import type { ArchiveSourceFactory } from './types';

export class ArchivePreflightFailedError extends Error {
  readonly report: PreflightReport;

  constructor(report: PreflightReport) {
    super('Archive preflight failed.');
    this.name = 'ArchivePreflightFailedError';
    this.report = report;
  }
}

export async function runArchivePreflight(
  sourceFactory: ArchiveSourceFactory,
  options: PreflightOptions = {},
): Promise<PreflightReport> {
  const source = await sourceFactory.create();
  return preflightArchive(source, options);
}

export function assertPreflightOk(report: PreflightReport): void {
  if (!report.ok) throw new ArchivePreflightFailedError(report);
  if (report.issues.some((issue) => issue.severity === 'error')) {
    throw new ArchivePreflightFailedError({ ...report, ok: false });
  }
}
