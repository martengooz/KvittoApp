# Native iOS Rewrite Status

Last updated: 2026-09-17

This document records the implementation checkpoint against `IOS-HANDOFF.md`.
It is deliberately stricter than a feature checklist: code and adapter contracts
are not described as complete when the real native integration or device gate is
still missing.

## Current Summary

The repository now contains a buildable native iOS application, shared client
contracts, archive rules, production-facing SQLite/SecureStore adapters, native
Vision/storage source, feature controllers, and an integrated five-tab shell.

The app builds and launches as a standalone Release application on an iOS 26.5
simulator, completes its boot sequence, and all five tabs render and load their
data.

Repository reads and writes now execute as direct SQL against SQLite; the
in-memory state mirror and full-table rewrite are gone. Sync runs automatically
from app lifecycle, connectivity, and local edits, and pulls receipt images.

The rewrite is not release-complete. The main remaining work is the live
VisionCamera frame processor for auto-capture, native ZIP bridge wiring,
background execution, physical-device tests, and release-level
E2E/performance/accessibility work.

The native iOS rewrite is committed on `main`.

## Progress Log

### 2026-09-17: The app loads its data - runaway render loop fixed

The "Loading receipts..." hang from the previous entry was not a SQLite problem.
Instrumenting the adapter on device showed **11,337 receipt queries issued and
only 218 completed**: one runaway loop was saturating the single SQLite
connection, so every other screen's queries queued behind it and nothing in the
app could load. That is why Settings appeared broken too.

The loop, found by logging a stack from the fourth `refresh()` call:

- `useReceiptsFeatureController` returned `actions` as a fresh object literal on
  every render.
- The receipts screen held `useEffect(() => actions.setNeedsReviewOnly(...),
  [actions, needsReviewOnly])`.
- So the effect re-ran on every render, each run called `setFilter`, which
  called `refresh()`, which emitted, which re-rendered - unbounded.

Fixes:

- `actions` in the receipts and purchases hooks, and `refresh` in the
  collections hook, are memoized on the controller. Callers can now list them in
  an effect's dependencies, which is what the lint rules ask for, without
  driving a loop.
- Added `test/feature-hook-stability.test.tsx`, which renders the same effect
  shape the screen used and asserts the identity holds and the effect settles
  after one run. With the memoization removed the test does not merely fail, it
  reproduces the original runaway loop and aborts the process.
- Pinned React resolution in the iOS jest config. The workspace hoists React
  19.3.0 to the repo root while the app pins 19.2.3, so without a
  `moduleNameMapper` any test that renders a hook sees two dispatchers and every
  hook call fails.

Device verification, on a Release build installed on iPhone 17 Pro / iOS 26.5:

- **Receipts** shows "No receipts yet." instead of hanging.
- **Settings** renders fully, including all eight startup diagnostic steps
  (`keychain-key-ready` through `durable-jobs-restored`), image processing, and
  sync toggles.
- **Collections** renders its four summary sections.
- **Purchases** and **Scan** render; Scan correctly reports "No camera is
  available on this device" with the photo-library fallback, which is the right
  answer on a simulator.
- Zero JavaScript exceptions in the system log across navigating every tab.

- Verification evidence:
  - `npm run typecheck:ios`: passed.
  - `npm run test:ios -- --runInBand`: 43 suites, 158 tests passed.
  - `npm run ios:bundle`, `npm run typecheck`, `npm test`, `npm run build`: passed.
  - `npm run lint`: 10 errors, all pre-existing.

Note on running it: `npm run ios` works, but it must be invoked through the
workspace script. Running `npx expo run:ios` from the repository root does not
find the native project and starts scaffolding a fresh one, editing the root
`package.json` on the way.

### 2026-09-17: The app actually runs - four startup bugs found by running it

Running the Release build on a simulator showed the app had never started
successfully. Earlier checkpoints in this document claimed a launch with all
five tabs rendering; that claim was wrong. Every launch failed in the data
foundation, and the first screen would have hung even if it had not.

Four defects, each fixed with a regression test that fails without the fix:

1. **SecureStore rejected the database key name.** `ios:data:sqlcipher-key`
   contains colons; SecureStore only accepts alphanumerics, `.`, `-` and `_`.
   Startup failed before the database could be opened. Renamed to
   `ios.data.sqlcipher-key`, and `test/data-sql-persistence.test.ts` now asserts
   every SecureStore key the app owns matches the accepted pattern.
2. **Transactions ran on an unkeyed second connection.** expo-sqlite's
   `withExclusiveTransactionAsync` creates a new native connection
   (`useNewConnection: true`). `PRAGMA key` had only been applied to the
   original, so on a SQLCipher database every statement issued through it
   failed. The adapter now uses explicit `BEGIN IMMEDIATE`/`COMMIT`/`ROLLBACK`
   on the one keyed connection, and a test asserts no second connection is ever
   opened.
3. **No Web Crypto on Hermes.** `@kvitto/shared` reads `globalThis.crypto` at
   module load to generate ids, which Hermes does not provide. Added
   `expo-crypto` and a polyfill installed from a new app entry point
   (`apps/ios/index.js`) that loads before anything imports shared code. Only
   the CSPRNG is polyfilled; `sha256Hex` already falls back to a pure-JS SHA-256
   and a hand-rolled `subtle` would have risked corrupting blob ids.
4. **Every tab controller re-rendered forever.** `getSnapshot()` built a fresh
   object on each call in the receipts, purchases, and collections controllers.
   `useSyncExternalStore` compares snapshots with `Object.is` on every render,
   so mounting any tab produced "Maximum update depth exceeded". Snapshots are
   now built once per change and invalidated by `emit()`.

Two more real bugs fixed while in there:

- **The SQLCipher key was drawn from `Math.random()`**, which is not a CSPRNG.
  A predictable key makes encrypting the database at rest close to pointless.
  It now comes from `crypto.getRandomValues` and refuses to generate a key at
  all when no cryptographic source is present.
- **Concurrent transactions could interleave.** `BEGIN IMMEDIATE` is awaited, so
  two concurrent callers could both pass the depth check and issue a second
  `BEGIN`, whose failed `ROLLBACK` would discard the other's work. Top-level
  transactions are now queued; a mutation test confirms the queue is what
  prevents it.

Also learned: the app must be built **with code signing** even for the
simulator. `CODE_SIGNING_ALLOWED=NO`, which this document's resume commands
used, produces a binary with no entitlements at all, and SecureStore then fails
with "A required entitlement isn't present". The resume commands below are
updated.

- Verification evidence:
  - `npm run typecheck:ios`: passed.
  - `npm run test:ios -- --runInBand`: 43 suites, 158 tests passed.
  - `npm run ios:bundle`, `npm run typecheck`, `npm test`, `npm run build`: passed.
  - `xcodebuild build` (Debug and Release) and `xcodebuild test` on
    iPhone 17 Pro / iOS 26.5: BUILD/TEST SUCCEEDED, 14 native tests, 0 failures.
  - Release app installed and launched on a clean iPhone 17 simulator: the boot
    sequence completes, the five-tab shell renders, and the Receipts screen
    shows its header, search field, and filter toggle. No JS exceptions in the
    system log.
  - `npm run lint`: 10 errors, all pre-existing.

**Resolved by the next entry above.** The Receipts list hang turned out to be a
render loop in the receipts hook, not a SQLite problem. The guess recorded here
that the query promise "never settles" was wrong: the queries were being issued
far faster than they could complete.

### 2026-09-17: VisionCamera integration, live preview, and capture

- Added `react-native-vision-camera` 5.2.3 with its Nitro dependencies
  (`react-native-nitro-modules`, `react-native-nitro-image`) and
  `expo-image-picker`. All four autolink and the app builds and its native tests
  pass with them integrated.
- Added `src/features/scan/camera-bridge.ts`: an imperative `ScanCameraPort` the
  scan controller drives, deliberately split from the React component that owns
  the native session. The controller and its tests never touch native code, and
  the screen can mount and unmount without the controller holding a stale camera.
- The bridge refuses to capture with a specific reason for each cause: no
  preview on screen, permission not granted, or preview paused. Pausing or
  detaching the preview releases the torch rather than reporting it still on, and
  a stale detach from a replaced preview cannot disconnect the live one.
- Added `src/app/camera-preview.tsx`: the VisionCamera preview, photo output,
  torch, and zoom, registering capture with the bridge. It renders explicit
  states for a device with no camera and for ungranted or denied permission
  instead of a blank frame.
- Rebuilt the scan screen around the preview with torch and zoom controls, a
  pause/start toggle, camera error reporting, and preview teardown on unmount so
  an unmounted screen cannot keep holding the camera and torch.
- Replaced the `pickImages` stub with a real `expo-image-picker` flow, including
  the library permission prompt and multi-select, hashing each picked file so it
  is content-addressable from the start.
- Added native `makeScratchFileUri`/`deleteScratchFile`. This fixes a real bug:
  scan temporary files were being written to `file:///tmp/...`, which is not
  writable inside the iOS sandbox. Scratch files now live in the app's caches
  directory, and deletion is confined to that directory.
- VisionCamera imports Nitro's TurboModule at module scope, which does not exist
  off-device, so the permissions adapter moved to `src/app/camera-platform.ts`
  and loads it on first use. Without that, importing the service composition
  broke three host test suites.
- Tests added: `test/scan-camera-bridge.test.ts` (13 tests) covering every
  capture refusal, permission flow, torch release on pause and detach, stale
  detach, zoom clamping, subscriber de-duplication, and frame-analysis
  reporting. Added `test/support/scan-fakes.ts` so integration tests compose a
  real bridge over fake permissions.
- Verification evidence:
  - `npm run typecheck:ios`: passed.
  - `npm run test:ios -- --runInBand`: 43 suites, 158 tests passed.
  - `npm run ios:bundle`: passed.
  - `npm run typecheck`, `npm test`, `npm run build`: passed.
  - `pod install`: VisionCamera 5.2.3, NitroModules 0.37.1, NitroImage 0.15.2,
    ExpoImagePicker 57.0.18 integrated.
  - Debug simulator `xcodebuild build` and `xcodebuild test` on
    iPhone 17 Pro / iOS 26.5: BUILD SUCCEEDED, 14 native tests, 0 failures.
  - `npm run lint`: 10 errors, all pre-existing.
- **Not verified, and important:** no camera behavior has been exercised against
  real hardware. A simulator has no camera, so preview, capture, torch, zoom,
  and the photo-library flow are covered only by host tests over the bridge and
  by the fact that the app compiles and links. The Release build, install, and
  launch check that earlier checkpoints ran could not be repeated: the build
  machine ran out of disk (123 MB free of 460 GB) part-way through the Release
  configuration. Debug build and native tests had already succeeded.
- Residual gaps for this roadmap area:
  - The live frame processor plugin is still not implemented, so auto-capture
    has no document detection. `analyzeFrameCompact` reports `unsupported` with
    `pluginLinked: false` rather than pretending otherwise, and the bridge
    already passes a real reading straight through once a plugin supplies one.
    VisionCamera 5 routes frame processors through Nitro hybrid objects and
    `react-native-vision-camera-worklets`, which means adding nitrogen codegen
    to the `kvitto-native` module - a separate step.
  - Torch, zoom, capture quality, and the 5-8 fps analysis cadence are untuned
    and unmeasured without a device.
  - Tap-to-focus and pinch-to-zoom gestures are not wired; zoom is stepped
    buttons for now.

### 2026-09-17: Automatic sync triggers, real connectivity, and blob downloads

- Added `src/sync/network.ts`: a connectivity monitor over `expo-network` that
  caches state so `NetworkPort.isOnline()` can stay synchronous, distinguishes
  metered from unmetered connections for the Wi-Fi-only setting, publishes
  transitions, and keeps the last known state when a reading fails.
- Added `src/sync/triggers.ts`: automatic sync driven by app lifecycle,
  connectivity, and local edits. Returning to the foreground re-reads
  connectivity and then syncs; regaining a connection syncs; bursts of local
  edits debounce into one run; a periodic sweep runs only while foregrounded.
- Every candidate passes one policy gate that reads live settings, so a run is
  suppressed with a named reason when automatic sync is off
  (`auto-sync-off`), there is no server or pairing (`not-configured`), the
  device is offline (`offline`), the connection is metered under Wi-Fi-only
  (`wifi-only`), or the minimum interval has not elapsed (`throttled`). A
  foreground return deliberately bypasses the throttle.
- Replaced the placeholder `network: { isOnline: () => true }` in app
  composition with the real monitor, and wired the triggers into the engine.
- Implemented blob download persistence. `writeDownloadedBlob` no longer throws:
  it hands bytes to a new native `storeDownloadedBlob`, which verifies they hash
  to the id the server indexed them under, stores them content-addressed, reads
  the real pixel dimensions, and records them as already uploaded so the next
  pass does not push them straight back. A tampered or corrupted download fails
  loudly instead of becoming a wrong receipt image.
- Raised the app's `blobDownloadLimit` from 0 to 24 and wired a receipt image
  planner that walks live receipts newest-first, skips blobs already held, and
  records whether each id is a thumbnail, processed, or original image so the
  stored metadata matches what the receipt points at.
- Closed the unpair gap noted in the 2026-09-16 sync entry: a new native
  `resetBlobUploadState` clears the uploaded flag on locally stored blobs, so
  they upload to the next account instead of being suppressed forever.
- Added `encodeBase64` for the native bridge, since Hermes has neither `Buffer`
  nor a dependable `btoa`.
- Tests added:
  - `test/sync-triggers.test.ts` (10 tests): each trigger source, each
    suppression reason, throttling and the foreground exemption, the
    foreground-only interval, debounce coalescing, full detach, and monitor
    caching/transition/failure behavior, all on injected clocks and timers.
  - `test/sync-blob-download.test.ts` (9 tests): base64 output checked against
    Node for every length remainder, role-correct download storage, integrity
    failures propagating, upload descriptor lookup, and planner ordering,
    dedupe, deleted-receipt, and zero-budget behavior.
  - `test/app-sync-service-composition.test.ts`: an attached trigger drives a
    real run and detaches on dispose; unpair calls the blob upload reset.
  - `ios/KvittoAppiOSTests/KvittoNativeBlobStoreTests.swift` (4 tests): digest
    mismatch rejection, dedupe on matching digest, and upload-state reset
    including idempotence.
- Both central wirings were mutation-checked: removing the trigger pass-through
  and removing the Wi-Fi-only gate each fail their tests.
- Verification evidence:
  - `npm run typecheck:ios`: passed.
  - `npm run test:ios -- --runInBand`: 43 suites, 158 tests passed.
  - `npm run ios:bundle`: passed.
  - `npm run typecheck`, `npm test`, `npm run build`: passed.
  - `pod install`: passed with `ExpoNetwork` integrated.
  - Debug simulator `xcodebuild build` on iPhone 17 Pro / iOS 26.5: BUILD SUCCEEDED.
  - `xcodebuild test` on the same destination: 14 tests, 0 failures (was 9).
  - `npm run lint`: 10 errors, all pre-existing; one earlier error in
    `services.tsx` disappeared with the unused sync-engine import.
- Residual gaps for this roadmap area:
  - Background sync is still foreground-only. `BGTask` registration and bounded
    background sync remain unimplemented, so the periodic sweep stops when the
    app leaves the foreground.
  - Triggers have not been exercised against a real companion server or on a
    physical device; connectivity transitions are covered only by a fake backend.
  - Download planning walks live receipts each pass with a 5000-receipt bound
    rather than tracking outstanding blobs in a table, so it is untested at scale.
  - Downloads are pulled one blob at a time with whole payloads in memory; large
    originals are not streamed.

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
- `npm run test:ios -- --runInBand`: 43 suites, 158 tests passed
- Focused Expo SQLite adapter contract: 2 tests passed after atomicity changes
- `npm run test:ios -- --runInBand data-sql-persistence`: 7 tests passed
- `npm run ios:bundle`: Expo/Metro iOS export passed
- `npm run lint`: 10 pre-existing errors remain; no new ones were introduced
- `npm run typecheck`: passed
- `npm test`: shared 112, server 31, web 55, and then-current iOS tests passed
- `npm run build`: shared, web production bundle, and server passed
- `pod install`: passed with `kvitto-native`, Expo SQLite/SQLCipher, and
  SecureStore autolinked
- Debug simulator `xcodebuild build`: passed
- Release simulator `xcodebuild build`: passed with embedded `main.jsbundle`
- Standalone Release app installed and launched on iPhone 17, iOS 26.5
- Simulator screenshots confirmed all five tabs render and load their data, with
  no JavaScript exceptions in the system log
- Hosted app XCTest passed
- Native XCTest: 14 passed, 0 failed, 0 skipped
- Final native build after Expo SQLite/SQLCipher additions exited successfully

## Packet Status

| Packet | Status | Notes |
|---|---|---|
| 1. Project scaffold | Mostly complete | Native builds, launch, CI, hosted XCTest, and nine native module tests pass. |
| 2. Shared contracts | Complete foundation | Domain export, ports, fakes, and invariant tests implemented. |
| 3. Database repositories | Implemented | Direct SQL reads/writes, FTS5 search, keyset pagination, and relaunch persistence tests. SQLCipher-key recovery and large-data profiling remain. |
| 4. Blob storage | Mostly complete | Content-addressed store, verified downloads, and upload-state reset are covered by native tests. Reference-safe cleanup remains. |
| 5. Sync transport/identity | Implemented and tested | Manual and automatic sync, pair/unpair with blob upload reset. A real-server app run remains. |
| 6. Native Vision module | Partial | Still processing/OCR compile and native fixture tests execute; the live VisionCamera frame plugin remains. |
| 7. App shell/UI | Implemented | Needs accessibility and appearance screenshot matrix. |
| 8. Archive/PWA export | Mostly complete | PWA streaming ZIP exists; cross-platform interoperability still needs end-to-end validation. |
| 9. Sync engine | Implemented and composed | Automatic triggers, real connectivity, and blob download persistence are wired and tested. Background execution and a real-server app run remain. |
| 10. Durable jobs | Partial | Repository-backed durable queue/store, strict multi-kind foreground handlers, and lifecycle service are composed; native background bridge behavior (BGTask) remains. |
| 11. Receipt/purchase/collection | Implemented foundation | Needs full UI E2E, large-data profiling, and final interaction polish. |
| 12. Scan feature | Partial | Workflow, camera adapter, VisionCamera preview, capture, torch, and zoom are implemented and build. The frame processor plugin, device auto-capture, and any hardware verification remain. |
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

Connectivity, automatic sync triggers, blob-download persistence, and blob
upload-state reset are now production adapters with injectable fakes for tests.
Still placeholders in `src/app/services`:

- background sync triggers (foreground triggers are implemented; background
  execution needs `BGTask`, see section 6)
- native archive adapter exposure

A local receipt save must stay offline-first and must not wait for OCR, AI, or
sync.

### 3. Camera and live Vision

VisionCamera is installed and the preview, permissions, capture, torch, zoom,
manual shutter, and photo-library fallback are wired to the scan controller
through the camera bridge. What remains:

- The native frame processor plugin that analyzes native buffers and emits only
  compact geometry/evidence/timing metadata. VisionCamera 5 routes these through
  Nitro hybrid objects plus `react-native-vision-camera-worklets`, so this needs
  nitrogen codegen added to the `kvitto-native` module.
- Auto-capture, which stays disabled until that plugin exists.
- Tap-to-focus and pinch-to-zoom gestures.
- Measuring and tuning the 5-8 fps analysis cadence and auto-capture behavior on
  a physical device using `fixtures/receipts`. Nothing camera-related has run on
  real hardware yet.

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

1. Add a device-level smoke check to CI. The whole suite passed while the app
  was unusable; nothing but running it would have caught that.
2. Implement the VisionCamera frame processor plugin (Nitro + nitrogen) and
  enable auto-capture.
3. Expose native ZIP and run web/native archive interoperability.
4. Implement `BGTask` registration and bounded background sync.
5. Add Maestro flows and real-server integration.
6. Perform physical-device camera/background/security/performance gates,
  including SQLCipher-key recovery and large-data query profiling.
7. Run the complete CI matrix and begin release hardening.

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
# Code signing must stay ON, even for the simulator: without it the app has no
# entitlements and SecureStore fails with "A required entitlement isn't present".
SIGNING="CODE_SIGNING_ALLOWED=YES CODE_SIGNING_REQUIRED=NO CODE_SIGN_IDENTITY=-"
xcodebuild build \
  -workspace apps/ios/ios/KvittoAppiOS.xcworkspace \
  -scheme KvittoAppiOS \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro,OS=26.5' \
  $SIGNING
xcodebuild test \
  -workspace apps/ios/ios/KvittoAppiOS.xcworkspace \
  -scheme KvittoAppiOS \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro,OS=26.5' \
  $SIGNING
```

Before resuming, run `git status` and preserve any uncommitted changes.