export type TabSpec = {
  routeName: 'index' | 'purchases' | 'scan' | 'collections' | 'settings';
  title: string;
  symbolName: string;
  symbolFallback: string;
};

export const TAB_SPECS: TabSpec[] = [
  {
    routeName: 'index',
    title: 'Receipts',
    symbolName: 'doc.text',
    symbolFallback: 'R',
  },
  {
    routeName: 'purchases',
    title: 'Purchases',
    symbolName: 'cart',
    symbolFallback: 'P',
  },
  {
    routeName: 'scan',
    title: 'Scan',
    symbolName: 'camera.viewfinder',
    symbolFallback: 'S',
  },
  {
    routeName: 'collections',
    title: 'Collections',
    symbolName: 'tray.full',
    symbolFallback: 'C',
  },
  {
    routeName: 'settings',
    title: 'Settings',
    symbolName: 'gearshape',
    symbolFallback: 'G',
  },
];
