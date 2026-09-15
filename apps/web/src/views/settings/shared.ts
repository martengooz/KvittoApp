/**
 * Bits more than one settings section reaches for: the tint colours iOS
 * Settings uses for a row's leading glyph, and the "test connection" action
 * row shared by the company-lookup and sync sections.
 */

import { actionRow } from '../../components/ui.js';
import { toast } from '../../core/toast.js';

/** Tint colours for the leading glyphs, matching how iOS Settings uses them. */
export const GLYPH = {
  ai: 'var(--ios-indigo)',
  image: 'var(--ios-teal)',
  company: 'var(--ios-green)',
  sync: 'var(--ios-blue)',
  storage: 'var(--ios-orange)',
  appearance: 'var(--ios-purple)',
  developer: 'var(--label-secondary)',
  danger: 'var(--ios-red)',
} as const;

export function connectionTestRow(
  label: string,
  action: () => Promise<{ ok: boolean; message: string }>,
): HTMLElement {
  return actionRow({
    label,
    busyLabel: 'Testar…',
    onClick: async () => {
      const result = await action();
      toast(result.message, { kind: result.ok ? 'success' : 'error' });
    },
  });
}
