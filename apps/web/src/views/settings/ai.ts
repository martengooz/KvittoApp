/**
 * The AI section: provider configuration plus, when paired with a server that
 * runs a local model, the controls for it. Most of the markup lives in
 * `createAiSettingsView` (shared with the server dashboard); this wires it to
 * the app's own settings store and sync client.
 */

import { createAiSettingsView, type AiSettingsViewOptions } from '@kvitto/shared';

import { getSettings, updateSettings } from '../../core/settings.js';
import { toast } from '../../core/toast.js';
import { testConnection } from '../../ai/index.js';
import { llmPull, llmRequeue, llmScan, llmStart, llmStatus } from '../../sync/client.js';
import { syncNow } from '../../sync/engine.js';
import { isPaired } from '../../sync/identity.js';

export async function renderAiSection(refresh: () => Promise<void>): Promise<HTMLElement> {
  const settings = getSettings();
  let localModel: AiSettingsViewOptions['localModel'] = null;
  if (settings.sync.serverUrl && (await isPaired())) {
    try {
      const status = await llmStatus(settings.sync.serverUrl);
      if (status.enabled) localModel = status;
    } catch {
      // The sync section reports unavailable or older servers.
    }
  }

  return createAiSettingsView({
    ai: settings.ai,
    localModel,
    onChange: async (patch) => {
      await updateSettings({ ai: patch });
    },
    onTest: testConnection,
    onLocalAction: async (action) => {
      const serverUrl = settings.sync.serverUrl;
      if (action === 'start') await llmStart(serverUrl);
      if (action === 'pull') {
        await llmPull(serverUrl);
        toast('Nedladdningen startade. Den tar några minuter.', { kind: 'success' });
      }
      if (action === 'scan') {
        const report = await llmScan(serverUrl);
        toast(
          report.blocked ?? `${report.extracted} tolkade, ${report.skipped} överhoppade, ${report.failed} misslyckade.`,
          { kind: report.blocked ? 'error' : 'success' },
        );
        void syncNow();
      }
      if (action === 'requeue') {
        const { requeued } = await llmRequeue(serverUrl);
        toast(`${requeued} kvitton lades tillbaka i kön.`, { kind: 'success' });
      }
      await refresh();
    },
  });
}
