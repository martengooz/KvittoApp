/** Diagnostics: the debug log and the manual update check. */

import { listGroup, row } from '../../components/ui.js';
import { checkForAppUpdate } from '../../core/app-update.js';
import { router } from '../../core/router.js';
import { toast } from '../../core/toast.js';
import { GLYPH } from './shared.js';

export function renderDeveloperSection(): HTMLElement {
  return listGroup(
    {
      title: 'Utvecklarinställningar',
      footer: 'Diagnostik med HTTP-data. Koder, tokens och API-nycklar maskeras.',
    },
    row({
      label: 'Debugglogg',
      value: 'Klient och server',
      icon: 'gear',
      iconColor: GLYPH.developer,
      onClick: () => router.navigate('/debug-log'),
    }),
    row({
      label: 'Sök efter uppdatering',
      value: 'Ny klientversion',
      icon: 'rotate',
      iconColor: GLYPH.developer,
      onClick: () => {
        void checkForAppUpdate()
          .then((result) => {
            if (result === 'current') toast('Du har den senaste versionen.', { kind: 'success' });
            if (result === 'unsupported') {
              toast('Uppdateringar hanteras inte av den här webbläsaren.', { kind: 'error' });
            }
          })
          .catch((error) => {
            toast(error instanceof Error ? error.message : String(error), { kind: 'error' });
          });
      },
    }),
  );
}
