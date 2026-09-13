/**
 * Apiverket company-registry client.
 *
 * `GET /v1/companies/{orgNumber}` looks up one Swedish organisation number via
 * Bolagsverket with SCB Företagsregister enrichment. Authentication is a bearer
 * API key: `sk_test_*` returns curated sandbox companies, `sk_live_*` the real
 * registry.
 *
 * Contract taken from https://apiverket.se/openapi.json (version 2026-02-15).
 */

import { checkOrgNumber, type Company } from '@kvitto/shared';

/** Apiverket's public origin. Overridable so a proxy can stand in front. */
export const APIVERKET_BASE_URL = 'https://apiverket.se';

/** Fields the app surfaces. The rest of the payload is stored, not shown. */
interface CompanyData {
  org_number?: string;
  name?: string;
  legal_form?: string | null;
  status?: string | null;
  active?: boolean | null;
  address?: string | null;
  postal_code?: string | null;
  city?: string | null;
  sni_codes?: { code?: string; description?: string }[] | null;
  [key: string]: unknown;
}

interface SuccessBody {
  meta?: Record<string, unknown>;
  data?: CompanyData;
}

interface ErrorBody {
  error?: {
    type?: string;
    code?: string;
    message?: string;
    param?: string;
  };
}

export type LookupFailure =
  /** No API key configured. */
  | 'not-configured'
  /** The number failed the local structural/checksum check. */
  | 'invalid-org-number'
  /** The registry has no such company. */
  | 'not-found'
  /** Key rejected. */
  | 'unauthorised'
  /** Daily or per-minute quota exhausted. */
  | 'rate-limited'
  /** Upstream registry problem, or any other server-side failure. */
  | 'unavailable'
  /** Could not reach the API at all. */
  | 'offline';

export class CompanyLookupError extends Error {
  readonly failure: LookupFailure;
  /** True when trying again later could plausibly succeed. */
  readonly retryable: boolean;

  constructor(failure: LookupFailure, message: string, retryable = false) {
    super(message);
    this.name = 'CompanyLookupError';
    this.failure = failure;
    this.retryable = retryable;
  }
}

export interface LookupOptions {
  apiKey: string;
  baseUrl?: string;
  signal?: AbortSignal;
}

/** The company fields plus the untouched payload, ready to store. */
export type CompanyRecord = Pick<
  Company,
  | 'orgNumber'
  | 'name'
  | 'legalForm'
  | 'status'
  | 'active'
  | 'address'
  | 'postalCode'
  | 'city'
  | 'industry'
  | 'raw'
  | 'source'
  | 'fetchedAt'
>;

/**
 * Looks up one organisation number.
 *
 * The number is validated locally first. That is not belt-and-braces: the API
 * rejects malformed numbers with a 400 that still consumes quota, and OCR
 * produces malformed numbers regularly.
 */
export async function lookupCompany(
  orgNumber: string,
  options: LookupOptions,
): Promise<CompanyRecord> {
  const key = options.apiKey.trim();
  if (!key) {
    throw new CompanyLookupError('not-configured', 'Ingen API-nyckel för företagsuppslag angiven.');
  }

  const check = checkOrgNumber(orgNumber);
  if (!check.valid || !check.digits) {
    throw new CompanyLookupError(
      'invalid-org-number',
      `"${orgNumber}" är inte ett giltigt organisationsnummer.`,
    );
  }

  const baseUrl = (options.baseUrl?.trim() || APIVERKET_BASE_URL).replace(/\/+$/, '');

  let response: Response;
  try {
    response = await fetch(`${baseUrl}/v1/companies/${check.digits}`, {
      headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
      signal: options.signal ?? null,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new CompanyLookupError('offline', 'Uppslaget avbröts.');
    }
    throw new CompanyLookupError('offline', 'Kunde inte nå företagsregistret.', true);
  }

  if (!response.ok) throw await toLookupError(response);

  const body = (await response.json()) as SuccessBody;
  const data = body.data;
  if (!data?.name) {
    throw new CompanyLookupError('unavailable', 'Registret svarade utan företagsuppgifter.', true);
  }

  return {
    orgNumber: check.formatted ?? check.digits,
    name: data.name,
    legalForm: data.legal_form ?? check.legalForm,
    status: data.status ?? null,
    active: data.active ?? null,
    address: data.address ?? null,
    postalCode: data.postal_code ?? null,
    city: data.city ?? null,
    industry: data.sni_codes?.[0]?.description ?? null,
    // The whole payload, so a later feature never needs a second lookup.
    raw: data as Record<string, unknown>,
    source: 'apiverket',
    fetchedAt: Date.now(),
  };
}

async function toLookupError(response: Response): Promise<CompanyLookupError> {
  let detail = `${response.status} ${response.statusText}`;
  let code = '';
  try {
    const body = (await response.json()) as ErrorBody;
    if (body.error?.message) detail = body.error.message;
    code = body.error?.code ?? '';
  } catch {
    // A non-JSON body is possible from a proxy; the status line will do.
  }

  switch (response.status) {
    case 400:
      // The API returns 400 for a malformed number, which the local check
      // should already have caught — treat it the same way.
      return new CompanyLookupError('invalid-org-number', detail);
    case 401:
    case 403:
      return new CompanyLookupError('unauthorised', 'API-nyckeln för företagsuppslag avvisades.');
    case 404:
      return new CompanyLookupError('not-found', 'Företaget finns inte i registret.');
    case 429:
      return new CompanyLookupError(
        'rate-limited',
        'Kvoten för företagsuppslag är slut. Försök igen senare.',
        true,
      );
    default:
      return new CompanyLookupError(
        'unavailable',
        code ? `${detail} (${code})` : detail,
        response.status >= 500,
      );
  }
}
