/**
 * The organisation-number lookup.
 *
 * Kept apart from the AI section because it is a different kind of thing: a
 * registry query keyed off a checksum-verified number, not a model guess. It
 * also has its own key, its own quota, and works when no model is configured
 * at all.
 */

import { actionRow, listGroup, row, sliderRow, switchRow } from '../../components/ui.js';
import { el } from '../../core/dom.js';
import { getSettings, updateSettings } from '../../core/settings.js';
import { toast } from '../../core/toast.js';
import { APIVERKET_BASE_URL, testApiverketConnection } from '../../api/apiverket.js';
import { clearCompanyMisses, searchBudgetUsed } from '../../company/lookup.js';
import { listCompanies } from '../../db/companies.js';
import { connectionTestRow, GLYPH } from './shared.js';

export async function renderCompanySection(): Promise<HTMLElement> {
  const { company } = getSettings();
  const [stored, searchesUsed] = await Promise.all([listCompanies(), searchBudgetUsed()]);

  const rows: HTMLElement[] = [
    switchRow({
      label: 'Slå upp företag automatiskt',
      checked: company.autoLookup,
      icon: 'building',
      iconColor: GLYPH.company,
      onChange: (checked) => void updateSettings({ company: { autoLookup: checked } }),
    }),
    row({
      label: 'API-nyckel',
      trailing: el('input', {
        type: 'password',
        value: company.apiKey,
        autocomplete: 'off',
        placeholder: 'sk_live_…',
        on: {
          change: (event) => {
            void updateSettings({ company: { apiKey: (event.target as HTMLInputElement).value.trim() } });
          },
        },
      }),
    }),
    row({
      label: 'Adress',
      trailing: el('input', {
        type: 'url',
        value: company.baseUrl,
        placeholder: APIVERKET_BASE_URL,
        autocapitalize: 'none',
        autocorrect: 'off',
        spellcheck: false,
        on: {
          change: (event) => {
            const value = (event.target as HTMLInputElement).value.trim();
            void updateSettings({ company: { baseUrl: value || APIVERKET_BASE_URL } });
          },
        },
      }),
    }),
    connectionTestRow('Testa Apiverket', async () => {
      const current = getSettings().company;
      return testApiverketConnection({ apiKey: current.apiKey, baseUrl: current.baseUrl });
    }),
    switchRow({
      label: 'Sök på namn om nummer saknas',
      checked: company.nameSearch,
      icon: 'search',
      iconColor: GLYPH.company,
      onChange: (checked) => void updateSettings({ company: { nameSearch: checked } }),
    }),
  ];

  if (company.nameSearch) {
    rows.push(
      sliderRow({
        label: 'Namnsökningar per dag',
        value: company.searchBudget,
        valueLabel: `${searchesUsed} av ${company.searchBudget} idag`,
        min: 0,
        max: 20,
        step: 1,
        onChange: (value) => void updateSettings({ company: { searchBudget: value } }),
      }),
    );
  }

  rows.push(row({ label: 'Sparade företag', value: String(stored.length) }));

  if (stored.length > 0) {
    rows.push(
      actionRow({
        label: 'Glöm misslyckade uppslag',
        onClick: async () => {
          await clearCompanyMisses();
          toast('Nekade organisationsnummer slås upp igen vid nästa avläsning.', { kind: 'success' });
        },
      }),
    );
  }

  return listGroup(
    {
      title: 'Företagsuppslag',
      footer:
        'Organisationsnumret läses av kvittot på enheten och slås upp mot Bolagsverket via ' +
        'Apiverket. Ett företag som redan är sparat slås aldrig upp igen, så ett kvitto från ' +
        'samma butik kostar inget. Går numret inte att läsa söks butikens namn istället — ' +
        'den sökningen har en egen, mycket mindre kvot hos Apiverket (20 per dygn på en ' +
        'gratisnyckel), därför dagsgränsen. Nyckeln synkroniseras mellan parkopplade enheter.',
    },
    ...rows,
  );
}
