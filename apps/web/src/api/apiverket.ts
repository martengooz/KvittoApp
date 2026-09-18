/**
 * The Apiverket company-registry client moved to `@kvitto/shared` when the iOS
 * app needed it too: it touches no DOM, and a second copy would have drifted
 * from this one the first time the API changed.
 *
 * This re-export keeps `../api/apiverket.js` working for the modules that
 * import it, so the move did not become a rename across the web app.
 */
export {
  APIVERKET_BASE_URL,
  CompanyLookupError,
  lookupCompany,
  searchCompanies,
  testApiverketConnection,
  type CompanyRecord,
  type CompanySearchHit,
  type ConnectionTestResult,
  type LookupFailure,
  type LookupOptions,
} from '@kvitto/shared';
