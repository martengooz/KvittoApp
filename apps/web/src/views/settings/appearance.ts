/** Theme picker and the auxiliary-lines toggle. */

import { listGroup, stackedRow, switchRow } from '../../components/ui.js';
import { el } from '../../core/dom.js';
import { getSettings, updateSettings } from '../../core/settings.js';

export function renderAppearanceSection(): HTMLElement {
  const { ui } = getSettings();
  const themes = [
    { value: 'rabarber', label: 'Rabarber', color: '#b33049' },
    { value: 'lingon', label: 'Lingon', color: '#8e2f3f' },
    { value: 'pantgron', label: 'Pantgrön', color: '#1f4d3a' },
    { value: 'blabar', label: 'Blåbär', color: '#2e3a64' },
    { value: 'hjortron', label: 'Hjortron', color: '#8f5a07' },
    { value: 'svartvinbar', label: 'Svartvinbär', color: '#57265f' },
    { value: 'krusbar', label: 'Krusbär', color: '#4c621a' },
  ] as const;
  const selected = ui.theme === 'system' || ui.theme === 'light' || ui.theme === 'dark'
    ? 'rabarber'
    : ui.theme;

  return listGroup(
    { title: 'Utseende' },
    stackedRow({
      label: 'Tema',
      control: el(
        'div',
        { class: 'theme-picker', role: 'radiogroup', 'aria-label': 'Tema' },
        ...themes.map((theme) =>
          el(
            'button',
            {
              class: 'theme-picker__option',
              type: 'button',
              role: 'radio',
              'aria-checked': String(selected === theme.value),
              on: { click: () => void updateSettings({ ui: { theme: theme.value } }) },
            },
            el('span', { class: 'theme-picker__swatch', style: `background:${theme.color}` }),
            el('span', { text: theme.label }),
          ),
        ),
      ),
    }),
    switchRow({
      label: 'Visa rabatt- och pantrader',
      checked: ui.showAuxiliaryLines,
      onChange: (checked) => void updateSettings({ ui: { showAuxiliaryLines: checked } }),
    }),
  );
}
