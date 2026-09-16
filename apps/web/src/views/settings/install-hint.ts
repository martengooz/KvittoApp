/**
 * iOS has no `beforeinstallprompt`, so a Home Screen install cannot be
 * triggered from script — the only thing that helps is telling the user where
 * the button is. Shown only on iOS, and only while not already installed.
 */

import { banner } from '../../components/ui.js';
import { isIos, isStandalone } from '../../core/platform.js';

export function renderInstallHint(): HTMLElement | null {
  if (!isIos() || isStandalone()) return null;
  return banner({
    tone: 'info',
    title: 'Lägg till på hemskärmen',
    body: 'Tryck på Dela-knappen i Safari och välj "Lägg till på hemskärmen" för helskärm, ikon och snabbare start.',
  });
}
