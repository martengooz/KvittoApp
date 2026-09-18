export type RouteControllerKey = 'receipts' | 'scan' | 'settings';

export type RouteSkeletonContract = {
  route: string;
  presentation: 'card' | 'modal' | 'formSheet';
  title: string;
  controller: RouteControllerKey;
  /**
   * Whether the native navigation bar is shown. A screen that draws its own
   * heading turns this off, otherwise the title appears twice - once in the
   * bar and once in the content underneath it.
   */
  headerShown?: boolean;
  /** Only meaningful when `presentation` is `formSheet`. */
  sheet?: {
    /** Fractions of the screen height the sheet may rest at. */
    detents: number[];
    /** Index into `detents` the sheet opens at. */
    initialDetentIndex: number;
  };
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
    // A sheet, not a full modal: filters are adjusted against the list behind
    // them, and a half-height detent keeps that context visible.
    route: 'filters',
    presentation: 'formSheet',
    title: 'Filters',
    controller: 'receipts',
    // The screen draws its own "Filters" heading, and a sheet has a grabber to
    // dismiss with, so the native bar would only duplicate both.
    headerShown: false,
    sheet: { detents: [0.5, 1], initialDetentIndex: 0 },
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
    title: 'Debug',
    controller: 'settings',
  },
  {
    route: 'archive/export',
    presentation: 'card',
    title: 'Export archive',
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
