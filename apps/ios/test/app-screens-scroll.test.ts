import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, test } from '@jest/globals';

const SRC = join(__dirname, '..', 'src');

/**
 * Screens that are deliberately short and fixed: a spinner, an error card, a
 * layout shell. Each one is a handful of lines and cannot grow with the user's
 * data, so scrolling would be noise.
 */
const FIXED_HEIGHT_SCREENS = new Set([
  'src/app/root-layout.tsx',
  'src/app/boot.tsx',
  'src/app/route-skeleton.tsx',
  'src/ui/controls.tsx',
]);

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walk(full));
    } else if (entry.endsWith('.tsx')) {
      out.push(full);
    }
  }
  return out;
}

describe('every screen that can grow can be scrolled', () => {
  /*
   * This project has shipped the same defect three times: a screen taller than
   * the phone, with no scroll view, so the controls at the bottom could not be
   * reached at all. The filters sheet shipped with Apply off-screen. Settings
   * put Credentials past the fold. The scan screen put the shutter below the
   * camera preview, which meant you could see the viewfinder and not take a
   * photo.
   *
   * None of those were visible to a test that renders a screen - react-test-
   * renderer has no viewport - and the simulator smoke check only asserts that
   * a route does not crash. All three were found by looking at a screenshot.
   * This is the cheap check that keeps the fourth from happening.
   */
  test('no screen renders a scaffold without a way to scroll', () => {
    const offenders: string[] = [];

    for (const file of walk(SRC)) {
      const relative = file.slice(file.indexOf('src/'));
      if (FIXED_HEIGHT_SCREENS.has(relative)) continue;

      const source = readFileSync(file, 'utf8');
      if (!source.includes('<ScreenScaffold')) continue;
      if (/<(ScrollView|FlashList|FlatList|SectionList)/.test(source)) continue;

      offenders.push(relative);
    }

    expect(offenders).toEqual([]);
  });

  test('the exemption list names only files that really are fixed height', () => {
    // Otherwise the list becomes a place to hide a growing screen.
    for (const relative of FIXED_HEIGHT_SCREENS) {
      const source = readFileSync(join(__dirname, '..', relative), 'utf8');
      expect(source).not.toContain('<ScrollView');
    }
  });
});
