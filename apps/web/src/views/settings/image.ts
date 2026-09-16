/** Capture post-processing: enhancement mode, edge detection, output size. */

import { actionRow, listGroup, segmented, sliderRow, stackedRow, switchRow } from '../../components/ui.js';
import { getSettings, updateSettings } from '../../core/settings.js';
import { toast } from '../../core/toast.js';
import { cvClient } from '../../cv/client.js';
import { GLYPH } from './shared.js';

export function renderImageSection(): HTMLElement {
  const { image } = getSettings();
  const cv = cvClient.status;

  const rows: HTMLElement[] = [
    stackedRow({
      label: 'Efterbehandling',
      control: segmented({
        label: 'Efterbehandling',
        value: image.enhance,
        options: [
          { value: 'grayscale', label: 'Grå' },
          { value: 'color', label: 'Färg' },
          { value: 'binarize', label: 'S/V' },
          { value: 'none', label: 'Av' },
        ],
        onChange: (value) => void updateSettings({ image: { enhance: value } }),
      }),
    }),
    switchRow({
      label: 'Hitta kanter automatiskt',
      checked: image.detectEdges,
      icon: 'crop',
      iconColor: GLYPH.image,
      onChange: (checked) => void updateSettings({ image: { detectEdges: checked } }),
    }),
    sliderRow({
      label: 'Maxstorlek',
      value: image.maxDimension,
      valueLabel: `${image.maxDimension} px`,
      min: 800,
      max: 3000,
      step: 128,
      onChange: (value) => void updateSettings({ image: { maxDimension: value } }),
    }),
    switchRow({
      label: 'Spara originalbilden',
      checked: image.keepOriginal,
      icon: 'photo',
      iconColor: GLYPH.image,
      onChange: (checked) => void updateSettings({ image: { keepOriginal: checked } }),
    }),
  ];

  if (!cv.ready) {
    rows.push(
      actionRow({
        label: 'Ladda ner för offline-bruk',
        busyLabel: 'Laddar ner…',
        onClick: async () => {
          const ok = await cvClient.warmup();
          toast(ok ? 'Bildbehandling är nu tillgänglig offline.' : 'Nedladdningen misslyckades.', {
            kind: ok ? 'success' : 'error',
          });
        },
      }),
    );
  }

  return listGroup(
    {
      title: 'Bildbehandling',
      footer: cv.ready
        ? 'Gråskala jämnar ut skuggor och höjer kontrasten utan att kasta bort svag termoutskrift — ' +
          'det är oftast vad AI-modellen läser bäst. Bildbehandlingen fungerar offline.'
        : 'Gråskala läser oftast bäst. Bildbehandlingen (≈11 MB) laddas ner vid första skanningen ' +
          'och fungerar därefter offline.',
    },
    ...rows,
  );
}
