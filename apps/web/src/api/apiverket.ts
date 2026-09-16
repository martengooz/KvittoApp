/**
 * Apiverket company-registry client.
 *
 * Two endpoints, and the difference between them matters:
 *
 * - `GET /v1/companies/{orgNumber}` looks up one organisation number via
 *   Bolagsverket with SCB Företagsregister enrichment. It spends the regular
 *   API quota, which is generous.
 * - `GET /v1/companies/search` finds companies by name. It has its **own, far
 *   smaller** daily quota — twenty calls a day on a free key — because it goes
 *   through Apiverket's shared SCB client certificate. It is a last resort, not
 *   a convenience.
 *
 * Authentication is a bearer API key: `sk_test_*` returns curated sandbox
 * companies, `sk_live_*` the real registry.
 *
 * Contract taken from https://apiverket.se/openapi.json (version 2026-02-15).
 */

import { checkOrgNumber, normalizeBaseUrl, type Company } from '@kvitto/shared';

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

interface SearchBody {
  meta?: Record<string, unknown>;
  data?: {
    total?: number;
    query?: string;
    companies?: CompanyData[];
  };
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
  | 'offline'
  /** Nothing on the receipt was usable as a search term. */
  | 'no-query'
  /** The local daily budget for name searches is spent. */
  | 'budget-spent';

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

export interface ConnectionTestResult {
  ok: boolean;
  message: string;
}

/** Verifies the key with an ordinary company lookup, without spending name-search quota. */
export async function testApiverketConnection(options: LookupOptions): Promise<ConnectionTestResult> {
  try {
    await lookupCompany('556703-7485', options);
    return { ok: true, message: 'Anslutningen till Apiverket fungerar.' };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : 'Kunde inte testa anslutningen till Apiverket.',
    };
  }
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

  const body = await request<SuccessBody>(`/v1/companies/${check.digits}`, options);
  const data = body.data;
  if (!data?.name) {
    throw new CompanyLookupError('unavailable', 'Registret svarade utan företagsuppgifter.', true);
  }

  return toRecord(data, check.formatted ?? check.digits, check.legalForm);
}

/** One hit from a name search, before it has been matched against a receipt. */
export interface CompanySearchHit extends CompanyRecord {
  /** Ten digits, unformatted. */
  digits: string;
}

/** Hits per search. Small: the fuzzy match only needs the plausible few. */
const SEARCH_LIMIT = 10;

/**
 * Searches the registry by company name.
 *
 * Every caller must treat this as expensive. The endpoint has a separate daily
 * quota an order of magnitude smaller than the rest of the API, so a hit's
 * organisation number should be cached and reused rather than searched for
 * again — which is exactly what `db/companies.ts` does with it.
 */
export async function searchCompanies(
  query: string,
  options: LookupOptions,
): Promise<CompanySearchHit[]> {
  const key = options.apiKey.trim();
  if (!key) {
    throw new CompanyLookupError('not-configured', 'Ingen API-nyckel för företagsuppslag angiven.');
  }

  const term = query.trim();
  // The API requires two characters; anything that short would match half the
  // register anyway and is not worth a call.
  if (term.length < 3) {
    throw new CompanyLookupError('no-query', 'Söktermen är för kort för ett företagsuppslag.');
  }

  const path = `/v1/companies/search?q=${encodeURIComponent(term)}&limit=${SEARCH_LIMIT}`;
  const body = await request<SearchBody>(path, options);

  const hits: CompanySearchHit[] = [];
  for (const data of body.data?.companies ?? []) {
    if (!data.name || !data.org_number) continue;
    const check = checkOrgNumber(data.org_number);
    // A hit whose own organisation number does not validate is not usable as a
    // key, and the whole point of the search is to recover a usable key.
    if (!check.valid || !check.digits) continue;
    hits.push({
      ...toRecord(data, check.formatted ?? check.digits, check.legalForm),
      digits: check.digits,
    });
  }
  return hits;
}

/** Flattens one registry payload, keeping the original alongside. */
function toRecord(data: CompanyData, orgNumber: string, fallbackLegalForm: string | null): CompanyRecord {
  return {
    orgNumber,
    name: data.name ?? '',
    legalForm: data.legal_form ?? fallbackLegalForm,
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

/** Performs one authenticated GET and turns any failure into a typed error. */
async function request<T>(path: string, options: LookupOptions): Promise<T> {
  const baseUrl = normalizeBaseUrl(options.baseUrl || APIVERKET_BASE_URL);

  let response: Response;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      headers: { authorization: `Bearer ${options.apiKey.trim()}`, accept: 'application/json' },
      signal: options.signal ?? null,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new CompanyLookupError('offline', 'Uppslaget avbröts.');
    }
    throw new CompanyLookupError('offline', 'Kunde inte nå företagsregistret.', true);
  }

  if (!response.ok) throw await toLookupError(response);
  return (await response.json()) as T;
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
