/** Blob and quota bookkeeping, plus the two destructive actions. */

import { formatBytes } from '@kvitto/shared';

import { confirmDialog } from '../../components/dialog.js';
import { actionRow, listGroup, row, stackedRow } from '../../components/ui.js';
import { el } from '../../core/dom.js';
import { router } from '../../core/router.js';
import { toast } from '../../core/toast.js';
import { blobStoreSize, collectGarbage, discardOriginals } from '../../db/blobs.js';
import {
  ARCHIVE_EXPORT_WARNING,
  exportArchiveToDownload,
  getArchiveExportCapability,
} from '../../migration/archive-export-browser.js';
import { requestPersistentStorage, storageEstimate } from '../../core/platform.js';
import { eraseAllData, purgeTombstones } from '../../db/repo.js';

export async function renderStorageSection(refresh: () => Promise<void>): Promise<HTMLElement> {
  const [estimate, blobs] = await Promise.all([storageEstimate(), blobStoreSize()]);
  const persisted = (await navigator.storage?.persisted?.()) ?? false;
  const archiveExport = getArchiveExportCapability();

  const rows: HTMLElement[] = [
    row({ label: 'Bilder', value: `${blobs.count} · ${formatBytes(blobs.bytes)}` }),
  ];

  if (estimate) {
    rows.push(
      stackedRow({
        label: 'Använt utrymme',
        value: `${formatBytes(estimate.usage)} / ${formatBytes(estimate.quota)}`,
        control: el(
          'span',
          { class: 'progress' },
          el('span', {
            class: 'progress__bar',
            style: `width:${Math.min(100, (estimate.usage / estimate.quota) * 100)}%`,
          }),
        ),
      }),
    );
  }

  if (!persisted) {
    rows.push(
      actionRow({
        label: 'Be om permanent lagring',
        onClick: async () => {
          const granted = await requestPersistentStorage();
          toast(granted ? 'Lagringen är nu permanent.' : 'Webbläsaren nekade permanent lagring.', {
            kind: granted ? 'success' : 'error',
          });
          await refresh();
        },
      }),
    );
  }

  rows.push(
    stackedRow({
      label: 'Exportera migration (.kvitto)',
      control: el('p', { class: 'small', text: ARCHIVE_EXPORT_WARNING }),
    }),
    actionRow({
      label: archiveExport.supported ? 'Ladda ner .kvitto-arkiv' : 'Ladda ner .kvitto-arkiv (otillgangligt)',
      disabled: !archiveExport.supported,
      onClick: async () => {
        const confirmed = await confirmDialog({
          title: 'Exportera arkiv?',
          message:
            `${ARCHIVE_EXPORT_WARNING} Kontrollera var du sparar filen och dela den bara med en enhet du litar pa.`,
          confirmLabel: 'Exportera',
        });
        if (!confirmed) return;

        const result = await exportArchiveToDownload();
        toast(result.message, { kind: result.ok ? 'success' : 'error' });
      },
    }),
    archiveExport.supported
      ? row({ label: 'ZIP-adapter', value: archiveExport.mode === 'compression-stream' ? 'Browser CompressionStream' : 'Injicerad adapter' })
      : row({ label: 'ZIP-adapter', value: archiveExport.reason ?? 'Saknas' }),
    actionRow({
      label: 'Frigör utrymme',
      onClick: async () => {
        const originals = await discardOriginals();
        const orphans = await collectGarbage();
        const tombstones = await purgeTombstones();
        toast(
          `Frigjorde ${formatBytes(originals.bytes + orphans.bytes)} · ${tombstones} poster rensade.`,
          { kind: 'success' },
        );
        await refresh();
      },
    }),
    actionRow({
      label: 'Radera all data',
      tone: 'danger',
      onClick: async () => {
        const confirmed = await confirmDialog({
          title: 'Radera allt?',
          message:
            'Alla kvitton, varor, etiketter och bilder på den här enheten tas bort. Det går inte att ångra.',
          confirmLabel: 'Radera',
          destructive: true,
        });
        if (!confirmed) return;
        await eraseAllData();
        toast('All data raderades.');
        router.navigate('/receipts');
      },
    }),
  );

  return listGroup(
    {
      title: 'Lagring',
      footer: persisted
        ? 'Lagringen är permanent — webbläsaren rensar den inte automatiskt. "Frigör utrymme" tar bort ' +
          'originalbilder för redan tolkade kvitton. Exportarkiv är avsedda för migration mellan enheter.'
        : 'Webbläsaren kan rensa data vid platsbrist. Be om permanent lagring för att förhindra det. ' +
          'Exportarkiv är avsedda för migration mellan enheter.',
    },
    ...rows,
  );
}
