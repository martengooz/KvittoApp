/** Server pairing and the sync status row. */

import { describeError, formatRelativeTime } from '@kvitto/shared';

import { confirmDialog } from '../../components/dialog.js';
import { actionRow, listGroup, row, switchRow } from '../../components/ui.js';
import { el } from '../../core/dom.js';
import { router } from '../../core/router.js';
import { getSettings, updateSettings } from '../../core/settings.js';
import { toast } from '../../core/toast.js';
import { serverHealth, whoAmI } from '../../sync/client.js';
import {
  countPending,
  getSyncState,
  resetSyncBackoff,
  statusLabel,
  summarise,
  syncNow,
} from '../../sync/engine.js';
import { getAccountId, getDeviceName, isPaired, setDeviceName, unpair } from '../../sync/identity.js';
import { pairAndSync } from '../../sync/pairing.js';
import { connectionTestRow, GLYPH } from './shared.js';

export async function renderSyncSection(refresh: () => Promise<void>): Promise<HTMLElement> {
  const { sync: syncSettings } = getSettings();
  const paired = await isPaired();
  const state = await getSyncState();
  const deviceName = await getDeviceName();
  const accountId = await getAccountId();

  const rows: HTMLElement[] = [
    row({
      label: 'Server',
      icon: 'cloud',
      iconColor: GLYPH.sync,
      trailing: el('input', {
        type: 'url',
        value: syncSettings.serverUrl,
        placeholder: 'https://…',
        inputmode: 'url',
        autocapitalize: 'none',
        autocorrect: 'off',
        spellcheck: false,
        on: {
          change: (event) => {
            void updateSettings({
              sync: { serverUrl: (event.target as HTMLInputElement).value.trim().replace(/\/+$/, '') },
            });
            // A new address is a new server; whatever the old one was failing
            // at says nothing about this one.
            resetSyncBackoff();
          },
        },
      }),
    }),
    row({
      label: 'Enhetsnamn',
      trailing: el('input', {
        type: 'text',
        value: deviceName,
        on: { change: (event) => void setDeviceName((event.target as HTMLInputElement).value) },
      }),
    }),
    connectionTestRow('Testa serveranslutningen', async () => {
      const serverUrl = getSettings().sync.serverUrl;
      if (!serverUrl) return { ok: false, message: 'Fyll i serveradressen först.' };
      try {
        if (paired) {
          await whoAmI(serverUrl);
        } else {
          await serverHealth(serverUrl);
        }
        return { ok: true, message: 'Anslutningen till servern fungerar.' };
      } catch (error) {
        return { ok: false, message: describeError(error) };
      }
    }),
  ];

  if (!paired) {
    const codeInput = el('input', {
      type: 'text',
      placeholder: 'ABC-DEF-GHJ',
      autocapitalize: 'characters',
      autocorrect: 'off',
      spellcheck: false,
      'aria-label': 'Parkopplingskod',
    });

    rows.push(
      actionRow({ label: 'Skanna QR-kod', onClick: () => router.navigate('/pair-scan') }),
      row({ label: 'Kod', trailing: codeInput }),
      actionRow({
        label: 'Parkoppla enheten',
        busyLabel: 'Parkopplar…',
        onClick: async () => {
          const url = getSettings().sync.serverUrl;
          if (!url) {
            toast('Fyll i serveradressen först.', { kind: 'error' });
            return;
          }
          try {
            await pairAndSync(url, codeInput.value);
            await refresh();
          } catch (error) {
            toast(describeError(error), { kind: 'error' });
          }
        },
      }),
    );

    return listGroup(
      {
        title: 'Synkronisering',
        footer: 'Skanna QR-koden från serverdashboarden eller ange koden manuellt. Den gäller i 15 minuter.',
      },
      ...rows,
    );
  }

  const pending = await countPending();
  rows.push(
    row({
      label: 'Status',
      value: `${statusLabel(state.status)}${pending > 0 ? ` · ${pending} väntar` : ''}`,
    }),
    row({ label: 'Senast synkad', value: formatRelativeTime(state.lastSuccess) }),
    switchRow({
      label: 'Synka automatiskt',
      checked: syncSettings.autoSync,
      onChange: (checked) => void updateSettings({ sync: { autoSync: checked } }),
    }),
    switchRow({
      label: 'Synka även bilder',
      checked: syncSettings.syncImages,
      onChange: (checked) => void updateSettings({ sync: { syncImages: checked } }),
    }),
    actionRow({
      label: 'Synka nu',
      busyLabel: 'Synkar…',
      onClick: async () => {
        // The explicit button bypasses the breaker and the change probe:
        // someone watching a spinner wants the round trip actually made.
        const report = await syncNow();
        toast(
          report.ok
            ? summarise(report)
            : (report.error ?? 'Synkroniseringen misslyckades.'),
          { kind: report.ok ? 'success' : 'error' },
        );
        await refresh();
      },
    }),
    actionRow({
      label: 'Koppla från servern',
      tone: 'danger',
      onClick: async () => {
        const confirmed = await confirmDialog({
          title: 'Koppla från?',
          message:
            'Dina kvitton ligger kvar på enheten. Nästa gång du parkopplar laddas hela arkivet upp igen.',
          confirmLabel: 'Koppla från',
          destructive: true,
        });
        if (!confirmed) return;
        await unpair();
        toast('Enheten är frånkopplad.');
        await refresh();
      },
    }),
  );

  return listGroup(
    {
      title: 'Synkronisering',
      footer: accountId
        ? `Konto ${accountId.slice(0, 8)}… · Stäng av bildsynk för att spara mobildata; texten synkas ändå.`
        : 'Stäng av bildsynk för att spara mobildata; texten synkas ändå.',
    },
    ...rows,
  );
}
