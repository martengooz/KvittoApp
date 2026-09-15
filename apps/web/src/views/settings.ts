/**
 * Settings, laid out as iOS Settings is: inset grouped lists, switches for
 * booleans, and an explanatory footer under each group rather than hint text
 * squeezed between controls.
 *
 * Each section is its own module under `views/settings/` — install hint, AI,
 * image, company lookup, sync, storage, appearance, developer, about — and
 * this file only assembles them behind one `liveView`. The AI section is the
 * one most likely to be misconfigured, so it has a "test connection" action
 * that reports exactly what failed instead of leaving the user to discover it
 * on their next scan.
 */

import { liveView } from '../core/live-view.js';
import { renderAbout } from './settings/about.js';
import { renderAiSection } from './settings/ai.js';
import { renderAppearanceSection } from './settings/appearance.js';
import { renderCompanySection } from './settings/company.js';
import { renderDeveloperSection } from './settings/developer.js';
import { renderImageSection } from './settings/image.js';
import { renderInstallHint } from './settings/install-hint.js';
import { renderStorageSection } from './settings/storage.js';
import { renderSyncSection } from './settings/sync.js';

export function settingsView(): Promise<HTMLElement> {
  // Both events matter here: `settings:changed` covers a value edited on this
  // screen, `data:changed` the saved-company count and storage figures that
  // move only when a scan or sync writes data, not settings.
  return liveView({
    on: ['settings:changed', 'data:changed'],
    load: async () => {},
    render: async (_data, refresh) => [
      renderInstallHint(),
      await renderAiSection(refresh),
      renderImageSection(),
      await renderCompanySection(),
      await renderSyncSection(refresh),
      await renderStorageSection(refresh),
      renderAppearanceSection(),
      renderDeveloperSection(),
      renderAbout(),
    ],
  });
}
