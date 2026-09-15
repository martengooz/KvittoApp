/**
 * Turns a finished {@link ImportOutcome} into the toasts the scan screen shows
 * afterwards.
 *
 * Pulled out of the view because pluralising "1 kvitto" vs "N kvitton" three
 * different ways is pure text logic, not UI — and kept dependency-free (only
 * type imports, erased at build time) so it can be unit-tested without pulling
 * in the camera, IndexedDB or the CV pipeline.
 */

import type { ToastKind } from '../core/toast.js';
import type { ImportOutcome } from './import.js';

export interface ImportToast {
  message: string;
  kind: ToastKind;
}

/**
 * Composes the toasts for a finished import.
 *
 * A batch that saved nothing gets exactly one error toast built from the
 * first failure. Otherwise: a success toast for what was saved (mentioning
 * whether AI parsing started), then an optional failure count and an optional
 * "saved uncropped" note.
 */
export function describeImportOutcome(outcome: ImportOutcome): ImportToast[] {
  const saved = outcome.receiptIds.length;

  if (saved === 0) {
    const first = outcome.failures[0];
    return [
      {
        message: first ? `Bilden kunde inte läsas: ${first.message}` : 'Inga kvitton kunde sparas.',
        kind: 'error',
      },
    ];
  }

  const toasts: ImportToast[] = [];

  const notes = [
    saved === 1 ? 'Ett kvitto tillagt' : `${saved} kvitton tillagda`,
    outcome.parsing ? 'tolkas nu med AI' : null,
  ].filter((note): note is string => note !== null);
  toasts.push({ message: `${notes.join(' — ')}.`, kind: 'success' });

  if (outcome.failures.length > 0) {
    toasts.push({
      message:
        outcome.failures.length === 1
          ? `${outcome.failures[0]?.name} kunde inte läsas.`
          : `${outcome.failures.length} bilder kunde inte läsas.`,
      kind: 'error',
    });
  }

  if (outcome.uncropped > 0) {
    toasts.push({
      message:
        outcome.uncropped === 1
          ? 'Ett kvitto sparades obeskuret — kanterna gick inte att hitta.'
          : `${outcome.uncropped} kvitton sparades obeskurna — kanterna gick inte att hitta.`,
      kind: 'info',
    });
  }

  return toasts;
}
