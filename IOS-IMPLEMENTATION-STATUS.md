# Native iOS Rewrite Status

Last updated: 2026-09-16

This document records the implementation checkpoint against `IOS-HANDOFF.md`.
It is deliberately stricter than a feature checklist: code and adapter contracts
are not described as complete when the real native integration or device gate is
still missing.

## Current Summary

The repository now contains a buildable native iOS application, shared client
contracts, archive rules, production-facing SQLite/SecureStore adapters, native
Vision/storage source, feature controllers, and an integrated five-tab shell.

The app has been built and launched as a standalone Release application on an
iOS 26.5 simulator. The Receipts, Purchases, Scan, Collections, and Settings
tabs rendered successfully.

Repository reads and writes now execute as direct SQL against SQLite; the
in-memory state mirror and full-table rewrite are gone.

The rewrite is not release-complete. The main remaining work is real camera and
VisionCamera integration, native ZIP bridge wiring, physical-device
background/camera tests, and release-level E2E/performance/accessibility work.

The native iOS rewrite is committed on `main`.

## Progress Log

### 2026-09-16: Direct SQL persistence replaces the in-memory state mirror

- Removed the hydrated in-memory state mirror (`SqliteLikeState`) and the
  full-table `persistState()` rewrite. `IosDataRepository` now issues SQL for
  every read and write.
- Replaced the adapter contract with a plain SQL surface
  (`execute`/`run`/`selectFirst`/`selectAll`/`transaction`/`tableExists`) plus a
  `getDiagnostics()` view of key/WAL/foreign-key/migration startup state.
- Converted every repository operation to SQL: get/upsert/tombstone/list,
  `listDirty`, `markCleanIfUpdatedAtMatches`, `dirtyAllAndResetRev`,
  `applyIncoming`, `countByKind`, `countDirty`, key-value and sync-cursor state,
  receipt/item mutations, cascade delete/restore, `getSpendSummary`, and both
  keyset-paginated queries.
- `queryReceipts` now filters and paginates in SQL with a real keyset predicate
  (`purchasedAt DESC, id ASC`, nulls last) instead of materializing every
  projection row and scanning for the cursor. Search runs through FTS5 `MATCH`:
  all terms must hit the receipt's own text, or any term may hit one of its
  items.
- `queryPurchases` joins `item_projections` to `receipt_projections` and filters
  on projected columns; item search keeps substring semantics via `LIKE`.
- Widened the projections so the filters that previously needed the canonical
  payload are now columns: `receipt_projections.currency/searchText/needsReview`
  and `item_projections.isDiscount/isDeposit`.
- Fixed the FTS triggers, which indexed `merchantName || status` and so made
  status words such as `parsed` searchable while ignoring notes and receipt
  numbers. They now index the dedicated `searchText` column, which the
  repository fills from merchant name, notes, and receipt number.
- `getSpendSummary()` and `rebuildFts()` became async; aggregates are `GROUP BY`
  queries rather than a recomputed in-memory snapshot, so they no longer walk
  every row on each mutation.
- Migration bookkeeping reads and writes the `kv` ledger through SQL and
  tolerates a database with no schema yet.
- Test adapter moved out of production code into
  `apps/ios/test/support/sqlite-test-adapter.ts` (`SqliteTestAdapter`), backed by
  a real better-sqlite3 database rather than Maps, so tests exercise the same
  SQL, triggers, FTS index, and rollback behavior the device runs. It accepts a
  file path so a test can model an app relaunch.
- Added `apps/ios/test/data-sql-persistence.test.ts` covering persistence across
  relaunch (entities, key-value state, sync cursor, item counts), migrations
  applied exactly once, FTS resolving after a relaunch rebuild, status words
  being unsearchable while notes/receipt numbers are, real database rollback of
  a failed transaction verified after reopening the file, keyset pagination
  across ties and null dates, purchase filtering on the new projected columns,
  and `needsReview` projection/filtering.
- Verification evidence:
  - `npm run typecheck:ios`: passed.
  - `npm run test:ios -- --runInBand`: 38 suites, 111 tests passed.
  - `npm run ios:bundle`: Expo/Metro iOS export passed.
  - `npm run typecheck`, `npm test`, `npm run build`: passed
    (shared 13/17/112, iOS 111, server 31, web 55).
  - Debug simulator `xcodebuild build` on iPhone 17 Pro / iOS 26.5: BUILD SUCCEEDED.
  - `npm run lint`: 11 errors remain, all pre-existing and all in files this
    change did not touch (`src/app/services.tsx`, `src/data/blobs/types.ts`,
    `src/features/settings/redaction.ts`, and three older test files). Earlier
    entries in this document described lint as passing; that was inaccurate.
- Residual gaps for this roadmap area:
  - SQLCipher-key failure and recovery still has no automated coverage; the
    test adapter models the key as diagnostics only, because better-sqlite3 has
    no SQLCipher support.
  - Migration rollback is only exercised through the transactional wrapper, not
    through a deliberately failing migration on device.
  - No large-data query profiling yet, so the new indexes are unproven at scale.
  - `receiptTags` still has no projection table, so cascade delete/restore
    filters those links on their payloads in JS.

### 2026-09-16: Foreground durable scan handlers wired to strict multi-kind execution

- Extended `@kvitto/client-core` durable runner with a backward-compatible
  multi-handler strict dispatch API so one global claim can be routed by
  `job.kind` without cross-kind unsupported retries.
- Preserved existing single-kind strict runner behavior for compatibility while
  reusing the same claim/lease/cancellation/retry/stale-source/stale-result
  logic internally.
- Added client-core tests for kind dispatch ordering and unsupported-kind
  terminal cancellation (no retry inflation).
- Implemented production iOS foreground handlers for `scan:ocr` and
  `scan:image-processing` in a boot-owned run-one callback and wired it into
  `createScanDurableJobService` during app bootstrap.
- OCR handler now resolves the receipt and original/source blob metadata by
  `receiptId`, executes `recognizeText` against that source descriptor,
  propagates claim token as cancellation ID, keeps blank-only/stale-safe
  enrichment semantics via `runSourceFirstOcrEnrichment`, and returns the latest
  post-run receipt source version for strict post-checks.
- Image-processing handler now performs idempotent completion checks (existing
  valid processed+thumb metadata), resolves original metadata, processes with
  deterministic temporary output URIs, stores outputs content-addressed through
  `IosNativeBlobStore`, and updates `imageId`/`thumbId` only when receipt source
  version still matches the claim.
- Foreground drain outcome mapping now reports `processed` when at least one job
  ran, even if the runner ends that window on an idle sentinel.
- Added focused deterministic iOS tests for OCR source-first descriptor usage,
  blank-only merge behavior, cancellation-triggered native cancel signaling,
  missing metadata retry behavior, idempotent image processing,
  stale-source suppression, and successful foreground drain transitions.
- Verification evidence:
  - `npm run test --workspace @kvitto/client-core`: 17 tests passed.
  - `npm run test:ios -- --runInBand jobs-scan-runner jobs-scan-service`: 2 suites passed, 11 tests passed.
  - `npm run typecheck:ios`: passed.
- Residual gaps for this roadmap area:
  - Native BGTask registration/execution remains out of scope.
  - Native facade currently exposes no temp-file cleanup API for durable
    processing outputs, so explicit cleanup cannot be performed from JS yet.

### 2026-09-16: Durable scan queue persistence and foreground lifecycle composition

- Replaced the app-level no-op scan job queue in service composition with a
  repository-backed durable `JobStorePort` using one versioned KV snapshot key
  (`jobs:queue:v1`) and defensive snapshot normalization.
- Serialized every queue mutation through `repository.runInTransaction(...)` so
  enqueue/claim/progress/retry/cancel transitions are atomic with the existing
  SQLCipher persistence boundary.
- Added an in-process mutation queue so concurrent read-modify-write operations
  cannot overwrite each other's persisted snapshots.
- Implemented full job-store semantics in iOS production code:
  enqueue/get/claimNext/markDone/markProgress/markRetry/markCancelled/
  requestCancel/list, including priority sorting, readiness checks, lease
  recovery for interrupted running jobs, and duplicate ID deduplication.
- Added a boot-owned scan durable job service with enqueue/list/cancel and
  foreground drain lifecycle APIs. Because production OCR/image handlers are
  not yet wired into strict durable execution, foreground drain truthfully
  reports `unsupported` (or `deferred` when stopped) rather than claiming or
  completing jobs.
- Mapped `ScanJobQueuePort` entries (`image-processing`/`ocr`, `receiptId`,
  `sourceVersion`, `sourceImageId`) into durable `JobRecord`s with deterministic
  receipt source fields and explicit priority/retry budgets.
- Updated scan confirm flow so it no longer launches inline OCR enrichment;
  local save remains offline-first and enqueue-only for backgroundable work.
- Added focused tests for:
  persistence across store recreation, lease recovery, retry/cancel
  transitions, duplicate ID behavior, concurrent enqueue serialization, scan
  queue mapping, unsupported/deferred foreground behavior, and service
  lifecycle stop semantics.
- Verification evidence:
  - `npm run test:ios -- --runInBand jobs-store.repository jobs-scan-service scan-feature.workflow integration-boot-recovery`: 4 suites passed, 14 tests passed.
  - `npm run test:ios -- --runInBand jobs-scan-service`: 1 suite passed, 5 tests passed.
  - Full iOS Jest suite: 36 suites, 98 tests passed.
  - `npm run typecheck:ios`: passed.
- Residual gap for this roadmap area: strict durable runner handlers for
  production `scan:image-processing` and `scan:ocr` are still not implemented,
  and native BGTask registration/execution remains out of scope for this step.

### 2026-09-16: App-level sync service composition

- Added SQLite KV-backed persistence for server URL, automatic-sync preference,
  Wi-Fi-only preference, device ID/name, and account ID. Secrets remain only in
  SecureStore.
- Composed a boot-owned sync service from repository, shared pairing-token
  vault, identity adapter, protocol-v2 transport, blob adapters, and iOS sync
  engine.
- Added manual run, pair, unpair, configuration update, state subscription, and
  idempotent disposal APIs. App provider cleanup disposes superseded and
  unmounted service compositions.
- Settings initializes from persisted sync/pairing state and persists later
  configuration changes through the sync service.
- Corrected unpair behavior during audit so pending blobs remain pending instead
  of being falsely marked uploaded. Native reset of previously uploaded blob
  state remains future work.
- Focused composition suite: 5 tests passed, covering persistence recreation,
  shared token use, concurrent-run coalescing, unpair reset, and disposal.
- Full iOS Jest suite: 34 suites, 88 tests passed.
- iOS TypeScript compilation passed.
- Remaining sync integration: automatic foreground/network/background triggers,
  full blob downloads, and an app-level run against a real companion server.

### 2026-09-16: Settings credential persistence and token-vault composition

- Replaced the in-memory Settings credential closure in app service composition
  with an injected Expo SecureStore-backed adapter.
- Persisted `pairingToken`, `aiApiKey`, and `companyApiKey` using
  `WHEN_UNLOCKED_THIS_DEVICE_ONLY` and explicit delete-on-clear behavior.
- Introduced a shared secure-credential store with two ports over the same
  backing keys: Settings secure credentials and sync pairing-token vault.
- Added focused tests for persistence across adapter instances, partial
  `SettingsFeatureController` updates, clear/delete behavior, and token-vault
  interoperability through `createCredentialsAdapter`.
- Verification evidence:
  - `npm run test:ios -- --runInBand secure-credentials sync-identity`: 2
    suites passed, 7 tests passed.
  - `npm run typecheck:ios`: passed.
- Remaining composition gap for this area: full sync engine/app lifecycle
  wiring is still pending, but it can now consume the same persisted pairing
  token via the existing token-vault boundary.

### 2026-09-16: Native module XCTest linkage

- Linked the `KvittoAppiOSTests` target to the local `kvitto-native` pod through
  the Podfile and regenerated CocoaPods integration.
- Replaced module-availability skip guards with direct testable imports.
- Corrected the stale SHA-256 fixture expectation exposed when the tests began
  running for real.
- Independently ran the four native test classes on iPhone 17 Pro / iOS 26.5.
- Xcode result bundle: 9 total, 9 passed, 0 failed, 0 skipped.
- iOS TypeScript compilation also passes after the linkage change.

### 2026-09-16: Atomic SQLite flush

- Changed the production Expo SQLite adapter to open one exclusive native
  transaction for each outer repository transaction.
- Nested repository transactions now reuse the active transaction connection.
- Canonical payload, receipt/item projections, FTS rows, and KV cursor state are
  flushed through that same connection and roll back together on failure.
- Focused adapter tests pass and assert that canonical/projection writes occur
  inside one exclusive transaction.
- iOS TypeScript compilation passes after the change.
- Direct SQL-backed repository queries and simulator relaunch coverage remain
  open; this step fixes atomicity but does not claim those later improvements.

## Implemented

### Project and native scaffold

- Added `apps/ios` using Expo SDK 57, React Native New Architecture, Hermes,
  Expo Router, and a committed Xcode workspace/project.
- Set the app deployment target to iOS 26.0.
- Added camera/photo permissions, `.kvitto` document registration, privacy
  manifest configuration, schemes, CocoaPods, and local Expo-module discovery.
- Added root iOS development, typecheck, test, bundle, prebuild, and run scripts.
- Added `.github/workflows/ios-ci.yml` for macOS typecheck, Jest, bundle, pod,
  Xcode build, and XCTest validation.
- Added a hosted XCTest target and shared scheme.
- Added the five-tab native shell and pushed/modal route files.
- Kept `apps/ios/app` as the Expo Router root while `apps/ios/src/app` owns boot
  and service composition.

### Shared and client-core contracts

- Added Metro-safe `@kvitto/shared/domain` exports without DOM dependencies.
- Split AI settings domain types from their browser UI helpers.
- Added `packages/client-core` ports for repositories, blobs, OCR, jobs, sync,
  credentials, network state, scheduling, archives, and logging.
- Added in-memory adapters and deterministic tests for mutation, sync, and job
  invariants.
- Implemented push-before-pull orchestration, global revision paging, epoch and
  divergence reset, dirty snapshot guards, shared in-flight runs, ordered dirty
  batches, and bounded blob work.
- Implemented durable-job claiming, leases, retries, cancellation, crash
  recovery, progress, and stale source/result suppression.

### Persistence and blob foundations

- Added ordered schema/migration definitions, canonical JSON rows, receipt/item
  projections, FTS5 tables, keyset queries, aggregates, subscriptions,
  tombstones/undo, and dirty snapshot guards.
- Added Expo SQLite, SQLCipher configuration, WAL/foreign-key startup, and
  SecureStore-backed random database-key handling.
- Added a production Expo SQLite adapter and boot diagnostics.
- Made production state flushes share the repository's exclusive SQLite
  transaction so canonical rows, projections, FTS, and KV state commit or roll
  back together.
- Added the local `kvitto-native` Expo module with CryptoKit hashing, sharded
  content-addressed paths, atomic writes, metadata, Core Image processing,
  orientation normalization, thumbnails, Vision rectangle detection, and
  Vision OCR contracts.
- Fixed and verified the native module against the real Swift compiler and
  simulator linker.

### Sync

- Added protocol-v2 HTTP transport, pairing identity boundary, retry policy,
  Retry-After support, cancellation, circuit breaker behavior, blob transfer,
  and redacted logging.
- Added real ephemeral-server tests for pairing/re-pairing, who-am-I, stale
  pushes, global pull pagination, secrets arriving after other entity kinds,
  blob upload/download, Retry-After, cancellation, and unpair reset behavior.
- Added the iOS sync-engine adapter, trigger interface, external-store state,
  and thumbnail-first download planning.
- Added production app composition for persisted non-secret configuration,
  SecureStore-backed pairing identity, protocol transport, manual sync,
  pair/unpair, observable state, and lifecycle disposal.

### Archive and migration

- Added `packages/archive` with v1 manifest/schema, path and duplicate checks,
  entry/size limits, NDJSON validation, Web Crypto SHA-256 checks, redaction,
  merge planning, conflict handling, and idempotence tests.
- Added a streaming PWA ZIP exporter and Settings/Storage export action.
- Added native import/export orchestration contracts, preflight reporting,
  staged merge/finalization, rollback cleanup, share/file adapter boundaries,
  and settings redaction tests.

### App features

- Added boot loading, diagnostics/recovery, error boundary, system-color tokens,
  Dynamic Type primitives, Reduce Motion handling, accessible controls, safe
  areas, and SF Symbol fallback behavior.
- Added receipt, purchase, and collection controllers/views with paginated
  queries, search, filtering, edit models, tags/categories, delete/undo,
  provenance, price history, and summaries.
- Added the scan state machine and workflow controller for permissions,
  throttled compact frame readings, auto/manual capture, interruption,
  staging, processing fallback, crop/rotation review, offline save, source-first
  OCR jobs, blank-only enrichment, and partial batch import failures.
- Added AI provider capability policy, current remote-provider adapter behavior,
  correction/stale suppression, and a non-inferencing Foundation Models stub.
- Added Apiverket cache, budget, credential boundary, and fuzzy matching.
- Added Settings controllers for pairing, image, OCR, AI, sync, migration,
  storage, diagnostics, and about information.
- Wired the primary routes to typed feature services and added integration tests
  for boot recovery, tab composition, and route/controller contracts.

## Verification Completed

The following checks have passed during implementation:

- `npm run typecheck:ios`
- `npm run test:ios -- --runInBand jobs-store.repository jobs-scan-service scan-feature.workflow integration-boot-recovery`: 4 suites, 14 tests passed
- `npm run test:ios -- --runInBand jobs-scan-service`: 1 suite, 5 tests passed
- `npm run test:ios -- --runInBand`: 38 suites, 111 tests passed
- Focused Expo SQLite adapter contract: 2 tests passed after atomicity changes
- `npm run test:ios -- --runInBand data-sql-persistence`: 7 tests passed
- `npm run ios:bundle`: Expo/Metro iOS export passed
- `npm run lint`: 41 warnings and 11 errors, all pre-existing and none in files
  touched by the direct-SQL change
- `npm run typecheck`: passed
- `npm test`: shared 112, server 31, web 55, and then-current iOS tests passed
- `npm run build`: shared, web production bundle, and server passed
- `pod install`: passed with `kvitto-native`, Expo SQLite/SQLCipher, and
  SecureStore autolinked
- Debug simulator `xcodebuild build`: passed
- Release simulator `xcodebuild build`: passed with embedded `main.jsbundle`
- Standalone Release app installed and launched on iPhone 17e, iOS 26.5
- Simulator screenshot confirmed all five tabs and the Receipts screen render
- Hosted app XCTest passed
- Native module fixture/utility XCTest: 9 passed, 0 failed, 0 skipped
- Final native build after Expo SQLite/SQLCipher additions exited successfully

## Packet Status

| Packet | Status | Notes |
|---|---|---|
| 1. Project scaffold | Mostly complete | Native builds, launch, CI, hosted XCTest, and nine native module tests pass. |
| 2. Shared contracts | Complete foundation | Domain export, ports, fakes, and invariant tests implemented. |
| 3. Database repositories | Implemented | Direct SQL reads/writes, FTS5 search, keyset pagination, and relaunch persistence tests. SQLCipher-key recovery and large-data profiling remain. |
| 4. Blob storage | Partial | Native implementation compiles; reference-safe cleanup and native XCTest execution remain. |
| 5. Sync transport/identity | Implemented and tested | Production manual sync/pair/unpair composition exists; automatic triggers and a real-server app run remain. |
| 6. Native Vision module | Partial | Still processing/OCR compile and native fixture tests execute; live VisionCamera frame plugin remains. |
| 7. App shell/UI | Implemented | Needs accessibility and appearance screenshot matrix. |
| 8. Archive/PWA export | Mostly complete | PWA streaming ZIP exists; cross-platform interoperability still needs end-to-end validation. |
| 9. Sync engine | Implemented and composed | Manual app service is wired and tested; automatic triggers, full blob downloads, and a real-server app run remain. |
| 10. Durable jobs | Partial | Repository-backed durable queue/store, strict multi-kind foreground handlers, and lifecycle service are composed; native background bridge behavior (BGTask) remains. |
| 11. Receipt/purchase/collection | Implemented foundation | Needs full UI E2E, large-data profiling, and final interaction polish. |
| 12. Scan feature | Partial | Workflow is implemented; camera adapter, VisionCamera UI, torch/zoom, and device auto-capture remain. |
| 13. AI/company | Implemented foundation | Needs production credential/job wiring and optional provider smoke tests. |
| 14. Native migration/settings | Partial | Orchestration exists; native ZIP bridge and complete Files/share UX remain. |
| 15. Integration/release | In progress | Routes/docs/CI exist; full E2E, privacy, performance, accessibility, and release work remain. |

## Important Remaining Work

### 1. Persistence correctness

Direct SQL execution, FTS5 search, keyset pagination, and persistence across
relaunch are implemented and covered by tests running against a real SQLite
database. What remains:

- SQLCipher-key failure and recovery tests, which need a Simulator run because
  the host test driver has no SQLCipher.
- A deliberately failing migration to prove migration rollback on device.
- Query profiling against a large seeded database to validate the indexes.
- A `receiptTags` projection so cascade delete/restore stops filtering link
  payloads in JS.

### 2. Production service composition

Several adapters are intentionally still placeholders in `src/app/services`:

- camera permission/preview/capture
- automatic foreground/network/background sync triggers
- full sync blob-download persistence and upload-state reset
- native archive adapter exposure

Replace these with production adapters while retaining injectable fakes for
tests. A local receipt save must stay offline-first and must not wait for OCR,
AI, or sync.

### 3. Camera and live Vision

- Install and configure the compatible VisionCamera dependency.
- Implement the native frame processor/plugin that analyzes native buffers and
  emits only compact geometry/evidence/timing metadata.
- Wire camera preview, permissions, torch, zoom, interruption, manual shutter,
  photo-library fallback, and the existing scan controller.
- Measure and tune the 5-8 fps analysis cadence and auto-capture behavior on a
  physical device using `fixtures/receipts`.

### 4. Native tests

- Expand the now-running native suite with measured OCR/crop quality baselines,
  cancellation during real Vision work, and memory assertions.
- Run the native module suite on the physical-device matrix in addition to the
  verified iOS 26.5 simulator run.

### 5. Archive interoperability

- Expose the Swift ZIP reader/writer through the Expo module.
- Import a real web-produced `.kvitto` archive in the native app.
- Re-export it and validate it with `packages/archive` and web tests.
- Verify tampering, rollback, repeated import, conflicts, and staged-file cleanup
  against real files and the real SQLite/blob stores.

### 6. Background work

- Implement and register `BGContinuedProcessingTask` and bounded background sync
  adapters.
- Persist claims/progress against the real jobs table.
- Test expiration, cancellation, app termination, stale results, and swipe-away
  behavior on a physical device.

### 7. End-to-end and release gates

- Add Maestro flows and deterministic seeded data for all primary workflows.
- Run real companion-server convergence tests from the native app.
- Add light/dark, Dynamic Type, VoiceOver, and Reduce Motion checks.
- Measure the handoff performance budgets with Instruments and signposts.
- Complete privacy review, local-network behavior, lock/unlock Keychain tests,
  TestFlight install/upgrade, and the named physical-device matrix.
- Run the new iOS GitHub Actions workflow and fix any runner/runtime drift.

## Recommended Resume Order

1. Implement automatic sync triggers (foreground/network/background) and full
  blob-download persistence.
2. Implement VisionCamera preview/frame processing and complete the scan UI.
3. Expose native ZIP and run web/native archive interoperability.
4. Add Maestro flows and real-server integration.
5. Perform physical-device camera/background/security/performance gates,
  including SQLCipher-key recovery and large-data query profiling.
6. Run the complete CI matrix and begin release hardening.

## Resume Commands

```bash
npm install
npm run lint
npm run typecheck
npm test
npm run build
npm run typecheck:ios
npm run test:ios -- --runInBand
npm run ios:bundle

export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
cd apps/ios/ios && pod install && cd ../../..
xcodebuild build \
  -workspace apps/ios/ios/KvittoAppiOS.xcworkspace \
  -scheme KvittoAppiOS \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro,OS=26.5' \
  CODE_SIGNING_ALLOWED=NO
xcodebuild test \
  -workspace apps/ios/ios/KvittoAppiOS.xcworkspace \
  -scheme KvittoAppiOS \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro,OS=26.5' \
  CODE_SIGNING_ALLOWED=NO
```

Before resuming, run `git status` and preserve any uncommitted changes.