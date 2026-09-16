/** The closing "what this app does with your data" note. */

import { el } from '../../core/dom.js';
import { icon } from '../../core/icons.js';

export function renderAbout(): HTMLElement {
  return el(
    'div',
    { class: 'empty-state settings-about' },
    icon('receipt', { size: 34, className: 'empty-state__icon', weight: 1.3 }),
    el('p', {
      text:
        'KvittoApp fungerar helt offline. Kvitton, bilder och inställningar ligger bara på den ' +
        'här enheten tills du väljer att synka dem till din egen server.',
    }),
  );
}
