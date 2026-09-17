import type { ReceiptFilter } from '../../data/repository';

export interface ReceiptFilterStore {
  getFilter(): ReceiptFilter;
  /** Merges a patch; an explicit `undefined` clears that field. */
  setFilter(patch: Partial<ReceiptFilter>): void;
  replaceFilter(next: ReceiptFilter): void;
  clear(): void;
  /** Number of fields currently constraining the list, for a badge. */
  activeCount(): number;
  subscribe(listener: (filter: ReceiptFilter) => void): () => void;
}

/** Fields the filters modal owns. `query` belongs to the search field instead. */
const FILTER_FIELDS = ['from', 'to', 'categoryIds', 'statuses', 'minTotal', 'maxTotal', 'needsReview'] as const;

function isActive(filter: ReceiptFilter, field: (typeof FILTER_FIELDS)[number]): boolean {
  const value = filter[field];
  if (value === undefined || value === null) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'string') return value.length > 0;
  if (typeof value === 'boolean') return value;
  return true;
}

export function countActiveFilters(filter: ReceiptFilter): number {
  return FILTER_FIELDS.filter((field) => isActive(filter, field)).length;
}

function sameFilter(a: ReceiptFilter, b: ReceiptFilter): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Holds the receipt list's filter outside any one screen.
 *
 * The filters modal is a separate route from the list, so neither can own this:
 * a modal cannot reach into the list screen's controller, and a controller
 * created per screen would lose the filter every time the list unmounts. The
 * store is created once at boot and both sides talk to it.
 */
export function createReceiptFilterStore(initial: ReceiptFilter = {}): ReceiptFilterStore {
  let filter: ReceiptFilter = { ...initial };
  const listeners = new Set<(filter: ReceiptFilter) => void>();

  function publish(next: ReceiptFilter): void {
    if (sameFilter(filter, next)) return;
    filter = next;
    for (const listener of [...listeners]) listener({ ...filter });
  }

  return {
    getFilter: () => ({ ...filter }),

    setFilter(patch): void {
      const next: ReceiptFilter = { ...filter, ...patch };
      // An explicit `undefined` means "stop constraining on this", so the key is
      // dropped rather than left present and undefined.
      for (const key of Object.keys(patch) as (keyof ReceiptFilter)[]) {
        if (patch[key] === undefined) delete next[key];
      }
      publish(next);
    },

    replaceFilter(next): void {
      publish({ ...next });
    },

    clear(): void {
      publish({});
    },

    activeCount: () => countActiveFilters(filter),

    subscribe(listener): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
