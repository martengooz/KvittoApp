import { TAB_SPECS } from '../src/app/tabs';

describe('tab shell', () => {
  it('defines five primary tabs', () => {
    expect(TAB_SPECS).toHaveLength(5);
    expect(TAB_SPECS.map((tab) => tab.routeName)).toEqual([
      'index',
      'purchases',
      'scan',
      'collections',
      'settings',
    ]);
  });

  it('keeps stable title and symbol fallbacks for accessibility', () => {
    for (const tab of TAB_SPECS) {
      expect(tab.title.length).toBeGreaterThan(0);
      expect(tab.symbolName.length).toBeGreaterThan(0);
      expect(tab.symbolFallback.length).toBeGreaterThan(0);
    }
  });
});
