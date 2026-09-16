export type RouteControllerKey = 'receipts' | 'scan' | 'settings';

export type RouteSkeletonContract = {
  route: string;
  presentation: 'card' | 'modal';
  title: string;
  controller: RouteControllerKey;
};

export const PUSHED_MODAL_ROUTE_CONTRACTS: ReadonlyArray<RouteSkeletonContract> = [
  {
    route: 'receipt/[receiptId]',
    presentation: 'card',
    title: 'Receipt details',
    controller: 'receipts',
  },
  {
    route: 'receipt/[receiptId]/edit',
    presentation: 'modal',
    title: 'Edit receipt',
    controller: 'receipts',
  },
  {
    route: 'receipt/[receiptId]/ocr',
    presentation: 'card',
    title: 'OCR details',
    controller: 'receipts',
  },
  {
    route: 'receipt/[receiptId]/extraction',
    presentation: 'card',
    title: 'Extraction details',
    controller: 'receipts',
  },
  {
    route: 'filters',
    presentation: 'modal',
    title: 'Filters',
    controller: 'receipts',
  },
  {
    route: 'categories',
    presentation: 'card',
    title: 'Categories',
    controller: 'receipts',
  },
  {
    route: 'tags',
    presentation: 'card',
    title: 'Tags',
    controller: 'receipts',
  },
  {
    route: 'pairing/scanner',
    presentation: 'modal',
    title: 'Pairing scanner',
    controller: 'settings',
  },
  {
    route: 'debug/log',
    presentation: 'card',
    title: 'Debug log',
    controller: 'settings',
  },
  {
    route: 'archive/preflight',
    presentation: 'card',
    title: 'Archive preflight',
    controller: 'settings',
  },
  {
    route: 'archive/result',
    presentation: 'card',
    title: 'Archive result',
    controller: 'settings',
  },
];
