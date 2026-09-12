/** Presentation helpers shared by the app and by server-side exports. */

const LOCALE = 'sv-SE';

const currencyFormatters = new Map<string, Intl.NumberFormat>();

/** `1234.5` → `1 234,50 kr` */
export function formatMoney(value: number | null | undefined, currency = 'SEK'): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '–';
  let formatter = currencyFormatters.get(currency);
  if (!formatter) {
    formatter = new Intl.NumberFormat(LOCALE, {
      style: 'currency',
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    currencyFormatters.set(currency, formatter);
  }
  return formatter.format(value);
}

/** Like {@link formatMoney} but without the currency suffix, for dense tables. */
export function formatAmount(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '–';
  return value.toLocaleString(LOCALE, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Trims trailing zeros: `1` → `1`, `0.412` → `0,412`. */
export function formatQuantity(value: number): string {
  return value.toLocaleString(LOCALE, { maximumFractionDigits: 3 });
}

/**
 * Formats a naive local ISO string (see `parseLocalDateTime`) for display.
 * Deliberately string-based so no timezone conversion can creep in.
 */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '–';
  return iso.slice(0, 10);
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '–';
  const [date, time] = iso.split('T');
  if (!time) return date ?? '–';
  return `${date} ${time.slice(0, 5)}`;
}

/** `2024-03-15` → `mars 2024`, for month grouping headers. */
export function formatMonth(iso: string | null | undefined): string {
  if (!iso) return 'Utan datum';
  const [yearText, monthText] = iso.slice(0, 7).split('-');
  const year = Number(yearText);
  const month = Number(monthText);
  if (!year || !month) return 'Utan datum';
  const label = new Date(Date.UTC(year, month - 1, 1)).toLocaleDateString(LOCALE, {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
  return label.charAt(0).toUpperCase() + label.slice(1);
}

/** `st` → `st`, `other` → `` — units are appended after a quantity. */
export function formatUnit(unit: string): string {
  return unit === 'other' ? '' : unit;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Coarse "for han sedan" style relative time, used for sync status. */
export function formatRelativeTime(timestamp: number | null): string {
  if (!timestamp) return 'aldrig';
  const seconds = Math.round((Date.now() - timestamp) / 1000);
  if (seconds < 45) return 'nyss';
  if (seconds < 90) return 'för en minut sedan';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `för ${minutes} min sedan`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `för ${hours} tim sedan`;
  const days = Math.round(hours / 24);
  if (days < 30) return `för ${days} dagar sedan`;
  return new Date(timestamp).toLocaleDateString(LOCALE);
}
