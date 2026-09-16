import { EMPTY_SYNC_META, emptyMerchant, type EntityKind, type EntityMap, type Receipt } from '@kvitto/shared/domain';

const seedByKind: Record<EntityKind, number> = {
  companies: 0,
  receipts: 0,
  items: 0,
  categories: 0,
  tags: 0,
  receiptTags: 0,
  secrets: 0,
};

export function buildEntity<K extends EntityKind>(kind: K, overrides: Partial<EntityMap[K]> = {}): EntityMap[K] {
  seedByKind[kind] += 1;
  const n = seedByKind[kind];
  const now = 1_000 + n;

  switch (kind) {
    case 'companies':
      return {
        ...EMPTY_SYNC_META,
        id: `company-${n}`,
        orgNumber: '556012-5790',
        name: `Company ${n}`,
        legalForm: null,
        status: null,
        active: true,
        address: null,
        postalCode: null,
        city: null,
        industry: null,
        raw: null,
        source: null,
        fetchedAt: null,
        nameMatchScore: null,
        nameConfirmed: false,
        updatedAt: now,
        ...(overrides as Partial<EntityMap[K]>),
      } as unknown as EntityMap[K];
    case 'receipts':
      return {
        ...EMPTY_SYNC_META,
        id: `receipt-${n}`,
        merchant: emptyMerchant(),
        purchasedAt: null,
        currency: 'SEK',
        total: null,
        subtotal: null,
        discountTotal: null,
        roundingAmount: null,
        depositTotal: null,
        vatLines: [],
        paymentMethod: null,
        cardLast4: null,
        receiptNumber: null,
        terminalId: null,
        cashier: null,
        categoryId: null,
        companyId: null,
        notes: null,
        source: 'camera',
        imageId: null,
        originalImageId: null,
        thumbId: null,
        status: 'draft',
        extraction: null,
        ocr: null,
        itemCount: 0,
        updatedAt: now,
        ...(overrides as Partial<EntityMap[K]>),
      } as unknown as EntityMap[K];
    case 'items':
      return {
        ...EMPTY_SYNC_META,
        id: `item-${n}`,
        receiptId: 'receipt-1',
        lineNo: n,
        name: `Item ${n}`,
        rawName: null,
        searchName: `item ${n}`,
        quantity: 1,
        unit: 'st',
        unitPrice: null,
        totalPrice: 10,
        discount: null,
        vatRate: null,
        categoryId: null,
        ean: null,
        deposit: null,
        isDeposit: false,
        isDiscount: false,
        notes: null,
        updatedAt: now,
        ...(overrides as Partial<EntityMap[K]>),
      } as unknown as EntityMap[K];
    case 'categories':
      return {
        ...EMPTY_SYNC_META,
        id: `category-${n}`,
        name: `Category ${n}`,
        color: '#123456',
        icon: null,
        parentId: null,
        scope: 'both',
        sortOrder: n,
        updatedAt: now,
        ...(overrides as Partial<EntityMap[K]>),
      } as unknown as EntityMap[K];
    case 'tags':
      return {
        ...EMPTY_SYNC_META,
        id: `tag-${n}`,
        name: `Tag ${n}`,
        color: '#654321',
        updatedAt: now,
        ...(overrides as Partial<EntityMap[K]>),
      } as unknown as EntityMap[K];
    case 'receiptTags':
      return {
        ...EMPTY_SYNC_META,
        id: `receipt-tag-${n}`,
        receiptId: 'receipt-1',
        tagId: 'tag-1',
        updatedAt: now,
        ...(overrides as Partial<EntityMap[K]>),
      } as unknown as EntityMap[K];
    case 'secrets':
      return {
        ...EMPTY_SYNC_META,
        id: 'aiApiKey',
        value: `secret-${n}`,
        updatedAt: now,
        ...(overrides as Partial<EntityMap[K]>),
      } as unknown as EntityMap[K];
    default:
      throw new Error('Unknown entity kind.');
  }
}

export function cloneReceipt(overrides: Partial<Receipt> = {}): Receipt {
  return buildEntity('receipts', overrides) as Receipt;
}
