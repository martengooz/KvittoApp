# KvittoApp Native iOS Rewrite Handoff

> Intended repository location: `/IOS_REWRITE_HANDOFF.md`
>
> Status: Approved implementation plan. The native project and new packages described below do not exist yet.
>
> Audience: implementation agents working independently in small, reviewable packets.

## 1. Goal

Create a new native iOS application for KvittoApp while retaining the existing PWA and companion server.

The rewrite prioritizes:

- Faster and more reliable receipt capture.
- Apple Vision OCR that runs entirely on device.
- Responsive native lists, forms, gestures, and navigation.
- Offline-first SQLite persistence.
- Background-safe image processing and synchronization.
- A stable adapter boundary for future Apple Foundation Models support.
- Migration of unsynced PWA data through a versioned archive.

This is functional workflow parity, not a line-by-line or pixel-perfect port of the PWA.

## 2. Fixed Decisions

These decisions are approved. Agents must not reopen them without explicit direction.

| Area | Decision |
|---|---|
| Platform | iOS only |
| Minimum OS | iOS 26 |
| App location | `apps/ios` |
| Runtime | React Native New Architecture with Hermes |
| Tooling | Expo development builds with a committed native Xcode project |
| Navigation | Expo Router using native stacks and tabs |
| Scanner | Custom VisionCamera interface |
| Live detection | Apple Vision through a native frame processor |
| Image processing | Core Image, Vision, Accelerate, and CryptoKit |
| OCR | Apple Vision `VNRecognizeTextRequest` |
| Generative AI in v1 | Existing remote/server providers only |
| Future on-device AI | Apple Foundation Models adapter contract, no v1 inference |
| Local database | SQLCipher-backed `expo-sqlite`, WAL, FTS5, Drizzle migrations |
| Image storage | Content-addressed files plus SQLite metadata |
| Credentials | Keychain through SecureStore |
| Sync backend | Existing companion server and protocol v2 |
| PWA migration | Versioned `.kvitto` ZIP export/import |
| Android | Explicitly out of scope |

OpenCV, Tesseract, ML Kit, PowerSync, an Android project, and a production analytics SDK are excluded from v1 unless the native feasibility gate proves an Apple API unusable.

## 3. Existing System To Preserve

The repository currently contains:

- `packages/shared`: domain types, synchronization contracts, Swedish parsers, extraction normalization, validation, prompts, merge rules, and provider utilities.
- `apps/web`: offline-first vanilla TypeScript PWA using Dexie, OpenCV.js, Tesseract.js, service workers, and browser camera APIs.
- `apps/server`: Fastify companion server using SQLite, pairing tokens, global synchronization revisions, content-addressed blobs, and optional background extraction.
- `fixtures/receipts`: real photographs used to tune and verify scanning behavior.

The native app is an additional client. Do not remove or regress the PWA or server during this work.

## 4. Non-Negotiable Domain Invariants

Agents touching persistence, import, synchronization, or jobs must preserve these rules.

1. Every synced entity contains `updatedAt`, `deletedAt`, `rev`, and `dirty`.
2. Every local entity mutation refreshes `updatedAt` and sets `dirty = 1`.
3. Deletes are tombstones. They are not physical deletes until acknowledged cleanup is safe.
4. The server revision cursor is account-global across every entity kind. Pull pages must never be processed table by table.
5. Push occurs before pull.
6. A record may be marked clean only if it was not edited after its serialized push snapshot.
7. An epoch change or diverged cursor resets the pull cursor to zero and reconciles; it must not erase local rows.
8. Incoming server extraction fills missing information conservatively and must not overwrite newer human edits. Use `mergeIncomingReceipt`.
9. Metadata synchronizes before images. Missing images are expected and retryable.
10. Blob IDs are lowercase SHA-256 digests of exact bytes and must match the server implementation.
11. Local writes must remain available while offline and must never wait for a network round trip.
12. Durable job results must be discarded if their source receipt or image changed while the job ran.

Canonical references:

- `packages/shared/src/types.ts`
- `packages/shared/src/sync.ts`
- `packages/shared/src/merge.ts`
- `apps/web/src/db/repo.ts`
- `apps/web/src/sync/engine.ts`
- `apps/server/src/db/sync.ts`

## 5. Target Repository Structure

The planned repository additions are:

- `apps/ios/`
  - `app/`: Expo Router route files only.
  - `ios/`: committed Xcode project, schemes, entitlements, privacy manifests, and XCTest targets.
  - `modules/kvitto-native/`: local Expo module containing Swift adapters.
  - `src/app/`: boot composition, service providers, lifecycle, and error recovery.
  - `src/data/`: SQLite initialization, Drizzle migrations, repositories, projections, FTS, and blob metadata.
  - `src/features/scan/`: capture, processing, review, crop editing, and batch import.
  - `src/features/receipts/`: list, details, editing, tags, categories, and review queue.
  - `src/features/purchases/`: global item search and price history.
  - `src/features/collections/`: month, category, merchant, and tag summaries.
  - `src/features/settings/`: image, OCR, AI, sync, migration, storage, debug, and about screens.
  - `src/sync/`: transport, identity, retry, engine adapter, and React bindings.
  - `src/jobs/`: durable job handlers and background adapters.
  - `src/ai/`: provider registry, capability policy, remote adapters, and future Foundation Models stub.
  - `src/company/`: Apiverket cache, lookup budget, and fuzzy matching.
  - `src/migration/`: native archive import/export orchestration.
  - `src/ui/`: native design tokens and reusable controls.
  - `test/`: TypeScript unit and integration tests.
  - `e2e/`: Maestro flows and deterministic fixture data.
- `packages/client-core/`
  - Platform-neutral repository ports, synchronization orchestration, durable-job contracts, and archive merge semantics.
- `packages/archive/`
  - `.kvitto` manifest/schema, validation, canonical fixtures, and browser/native-independent archive rules.
- `.github/workflows/ios-ci.yml`
  - macOS native build, XCTest, Simulator, and E2E workflow.
- `IOS_REWRITE_HANDOFF.md`
  - This document.

Do not create `apps/ios/android`. Do not place native Swift behavior directly in feature components.

## 6. Root And Workspace Changes

The implementation requires these root-level changes:

1. Add `apps/ios`, `packages/client-core`, and `packages/archive` to the existing npm workspace through the current `apps/*` and `packages/*` globs. No workspace-glob change should be necessary.
2. Update `package-lock.json` only through normal npm installation.
3. Add root scripts for iOS development, typechecking, tests, and builds without making Linux CI invoke Xcode.
4. Update `eslint.config.js` for React Native globals, generated native directories, and test configuration while keeping current web restrictions intact.
5. Extend `.gitignore` for DerivedData, local Xcode user state, CocoaPods build output, Expo caches, Maestro artifacts, and local signing files. Do not ignore the committed `apps/ios/ios` project.
6. Add `.github/workflows/ios-ci.yml`; preserve `.github/workflows/ci.yml` and Pages deployment behavior.
7. Update `README.md` with the new app’s status, architecture entry, prerequisites, and commands while retaining PWA/server documentation.

## 7. Technology Replacement Matrix

| Current web technology | Native replacement | Notes |
|---|---|---|
| Vanilla DOM view functions | React Native components | Preserve workflows, not DOM shape |
| Hash router | Expo Router/native stack and tabs | Filters become app state rather than URL state |
| CSS/BEM | React Native styles and native system colors | Dynamic Type and accessibility are mandatory |
| Dexie/IndexedDB | SQLCipher-backed Expo SQLite | Use async APIs, WAL, migrations, and FTS5 |
| IndexedDB image blobs | Application Support files | SQLite stores metadata and references only |
| `getUserMedia` | VisionCamera | Custom camera UI remains foreground-only |
| Canvas frame probes | Native VisionCamera frame processor | Never copy full frames into JavaScript |
| OpenCV.js worker | Apple Vision and Core Image | Full-frame fallback and manual crop remain |
| Tesseract.js worker | Vision text recognition | Accurate, Swedish-first, on-device OCR |
| Service Worker | Native lifecycle and background tasks | Scheduling is opportunistic, never guaranteed |
| `localStorage`/IndexedDB settings | SQLite plus SecureStore | Credentials stay in Keychain |
| Browser QR library | VisionCamera barcode scanning | Pairing payload remains unchanged |
| Browser file picker/share API | ImagePicker, document picker, native share sheet | Use file URIs |
| Event bus/live view | Repository subscriptions and external-store hooks | Avoid broad global rerenders |
| Browser provider image base64 | File-backed provider adapter | Encode off the UI thread only when API requires it |

## 8. Native Module Boundary

The local Expo module `kvitto-native` owns work that benefits from Apple frameworks or must not run on the JavaScript thread.

### Swift-owned responsibilities

- VisionCamera frame plugin and throttled document analysis.
- Still-image orientation normalization.
- Document segmentation or rectangle fallback.
- Perspective correction and safe crop expansion.
- Core Image enhancement, resizing, and JPEG output.
- Vision OCR and observation geometry.
- Streaming CryptoKit SHA-256.
- Atomic content-addressed file operations.
- Native thumbnail generation.
- Streaming ZIP archive import/export.
- iOS 26 continued-processing task bridge.
- Native performance signposts.

### JavaScript-owned responsibilities

- Scan state machine and user workflow.
- Auto-capture decision logic using compact frame readings.
- Receipt creation and repository operations.
- OCR fact extraction through `scanReceiptText`.
- Sync orchestration and conflict decisions.
- Job scheduling policy.
- Screen state, navigation, and rendering.
- AI provider selection and extraction policy.

### Boundary rule

Live image frames remain native/GPU-backed. JavaScript receives only compact metadata such as normalized corners, evidence scores, status, and timing. Still images are passed as file-backed descriptors:

- URI
- MIME type
- width and height
- byte size
- SHA-256 ID when known
- image role

Do not use browser `Blob`, data URLs, or base64 as the core internal image representation.

## 9. Persistence Design

Use SQLCipher-backed `expo-sqlite` with Drizzle-generated migrations.

### Database startup

1. Load or create the random database key from Keychain.
2. Open the database and apply the SQLCipher key.
3. Enable WAL and foreign keys.
4. Apply ordered migrations.
5. Verify or rebuild FTS structures if needed.
6. Seed default categories idempotently.
7. Restore interrupted durable jobs.
8. Render application content.

A database or Keychain failure must render a diagnostics/recovery screen, not a blank application.

### Entity storage

Store canonical entity JSON for exact wire-format fidelity and project fields needed for native queries.

Receipts project at least:

- ID and sync metadata
- purchased date
- total
- normalized merchant text
- category ID
- status
- item count

Items project at least:

- ID and sync metadata
- receipt ID
- line number
- normalized search name
- category ID
- total and unit price

Use FTS5 for receipt merchant/notes/number and item names. Maintain projections and FTS entries in the same exclusive transaction as the canonical payload.

### Blob storage

Use sharded paths such as `blobs/ab/cd/<sha256>`. Write to a temporary file, verify the hash, then rename atomically. Store MIME type, dimensions, role, byte size, timestamps, and upload state in SQLite.

Never delete a referenced image during cleanup. Prefer deleting unreferenced originals before processed images or thumbnails.

## 10. Scanner And OCR Design

### Live camera

- VisionCamera renders the native preview.
- The native frame plugin analyzes YUV/native buffers at a measured cadence, initially 5–8 fps.
- It returns normalized corners, detection source, quality/confidence evidence, coverage, ink evidence, stillness-relevant geometry, and duration.
- The existing pure auto-capture state machine remains authoritative for arming, holding, stalling, and triggering.
- Manual shutter is always available.
- Support torch, zoom, interruption, denied permission, and photo-library fallback.

### Still processing

1. Stage the source file immediately after capture.
2. Normalize EXIF orientation.
3. Detect or apply user-specified corners.
4. Expand a trusted quad slightly where geometrically valid.
5. Apply perspective correction.
6. Flatten illumination and apply requested color/grayscale/binarize/none mode.
7. Resize to a maximum long edge of 1568 pixels.
8. Encode JPEG at configured quality.
9. Generate a thumbnail natively.
10. Hash and atomically store each retained image.

If detection is uncertain, preserve the full frame. A cosmetically imperfect full image is preferable to lost receipt content.

### OCR

Run `VNRecognizeTextRequest` against the untouched source unless fixture measurements prove the processed image consistently better.

- Use accurate recognition.
- Prefer `sv-SE`, then `en-US`, after checking runtime support.
- Enable language correction.
- Return text, confidence, line or word boxes, and duration.
- Run shared `scanReceiptText` over the result.
- Apply checksum-verified organization numbers and high-confidence dates only to blank fields.
- Never block receipt saving or editing on OCR completion.

## 11. Durable Jobs And Background Work

SQLite is the source of truth for background work. Do not rely on in-memory promise chains.

Job kinds:

- image processing
- OCR
- AI extraction
- company lookup
- metadata synchronization
- blob upload
- blob download

Every job stores:

- stable ID and kind
- source entity and source version
- state and priority
- attempt count
- next attempt time
- progress
- cancellation flag
- last error
- creation and update times

Handlers must be idempotent. Claims and state changes are transactional. On expiration or application termination, unfinished work remains retryable.

Use:

- Foreground workers for immediate work.
- `BGContinuedProcessingTask` for user-started processing that should continue after backgrounding.
- `BGProcessingTask` or Expo BackgroundTask for opportunistic bounded synchronization.
- Foreground activation, reconnect, local-change debounce, and manual sync as primary synchronization triggers.

Do not claim a guaranteed background interval. Swiping the application away terminates work.

## 12. AI Architecture

Keep current remote and server provider behavior:

- Anthropic
- OpenAI
- OpenAI-compatible endpoints
- Ollama over a configured endpoint
- Companion server proxy
- Manual/no-AI mode

Reuse shared prompt, normalization, validation, structured-output fallback, and correction behavior.

Introduce a provider capability model containing:

- availability
- text and image modality support
- structured generation support
- background-execution support
- privacy class
- model identity
- estimated resource requirements

Add a `FoundationModelsProvider` stub that can report capability and availability but cannot perform extraction in v1. Future implementation should use Apple guided generation and multimodal prompting without changing feature screens or job contracts.

AI completion must be rejected when its source image/version is stale. Provider errors remain visible and retryable without blocking manual editing.

## 13. Synchronization Design

Port behavior from the current client rather than redesigning the server.

### Identity and security

- Generate one stable device UUID.
- Store the pairing bearer token only in Keychain.
- Pair through the existing QR/manual code flow.
- On unpair, clear credentials and cursor state, dirty all entities, and reset blob upload state.
- Redact tokens, pairing codes, API keys, and receipt contents from logs.

### One synchronization pass

1. Reject duplicate concurrent passes by sharing the in-flight operation.
2. Count dirty entities.
3. If nothing is dirty, perform the cheap status/epoch probe.
4. Push dirty entities in dependency order and batches of 200.
5. Clear dirty only when the local `updatedAt` matches the pushed snapshot.
6. Pull global pages from the account cursor.
7. Apply records transactionally using shared conflict and receipt enrichment rules.
8. Persist cursor only after the page is safely applied.
9. Upload a bounded set of pending blobs, initially 12.
10. Download thumbnails before processed images; fetch remaining images lazily.
11. Persist the success timestamp and reset breaker state.

Contract tests must include records from every entity kind in interleaved revision order. Secrets arriving after other kinds are a required regression case.

## 14. PWA Migration Archive

Use `.kvitto`, a ZIP-based versioned archive.

### Version 1 contents

- `manifest.json`
- One NDJSON stream per entity kind, including tombstones
- Redacted non-secret settings
- `blobs/<sha256>` image entries
- Blob metadata containing MIME type, dimensions, size, and role

### Explicit omissions

- Pairing bearer token
- Device ID and device name
- Account ID
- Synced `secrets` entities
- AI and company API keys
- Debug logs

The export UI must warn that receipt images and financial data are sensitive and that v1 archives are not password-encrypted.

### Import requirements

1. Reject unsupported future versions.
2. Prevent absolute paths and path traversal.
3. Enforce entry-count, uncompressed-size, and per-entry limits.
4. Reject duplicate paths and malformed NDJSON.
5. Verify every blob’s SHA-256 and declared size.
6. Produce a preflight report before applying changes.
7. Stage files outside the live blob directory.
8. Apply entity changes in one database transaction.
9. Move validated blobs into place only as part of successful finalization.
10. Remove staged files on failure.

For a new imported entity, preserve its ID, timestamps, and tombstone, set `dirty = 1`, and reset `rev = 0`. For an existing entity, use shared conflict rules and preserve the local server revision needed for the next push while marking an imported winning value dirty.

Repeated import must be idempotent.

## 15. UI Feature Inventory

Implement these primary tabs:

1. Receipts
2. Purchases
3. Scan
4. Collections
5. Settings

Implement pushed/modal flows for:

- receipt details
- receipt editing
- extraction and OCR details
- filters
- category/tag management
- pairing scanner
- debug log
- archive preflight/import result

Use native controls, system colors, Dynamic Type, VoiceOver, Reduce Motion, safe areas, haptics, sheets, alerts, and swipe actions. Use SF Symbols through a native wrapper and do not redistribute symbol assets.

Lists use FlashList and keyset pagination. Search uses FTS and `useDeferredValue`. Expensive filter transitions use `startTransition`. Do not load all receipt images or all database rows into JavaScript to render one screen.

PWA-only install hints, service-worker update prompts, browser quota displays, and URL-bookmarkable filters are not required.

## 16. Implementation Packets

Each packet has exclusive ownership. Interface changes go through the shared contract owner before consumers are patched.

### Packet 1: Project scaffold

Ownership:

- `apps/ios/package.json`
- `apps/ios/app.config.ts`
- Metro, TypeScript, Jest, Babel, Expo, and Xcode configuration
- root scripts and iOS CI skeleton

Work:

- Create the Expo development-build/bare-minimum app.
- Commit the generated iOS project and remove Android output.
- Set iOS 26 deployment target, New Architecture, and Hermes.
- Configure workspace resolution, permissions, document types, privacy manifest, schemes, and test targets.
- Install native dependencies using versions compatible with the chosen Expo SDK.

Acceptance:

- Clean `npm ci` succeeds.
- CocoaPods install succeeds.
- Metro produces an iOS bundle.
- Simulator displays a minimal app.
- Minimal XCTest runs.

### Packet 2: Shared contracts

Ownership:

- `packages/shared/src/index.domain.ts`
- shared scan/settings/provider contracts
- `packages/client-core/src/ports/**`

Work:

- Create a Metro-safe `@kvitto/shared/domain` export without DOM or worker dependencies.
- Freeze storage, image, OCR, jobs, sync, transport, archive, network, logging, scheduler, and credential ports.
- Add dependency-boundary lint rules.
- Characterize merge, conflict, epoch, extraction, and auto-capture behavior with tests.

Acceptance:

- Existing shared, web, and server builds remain green.
- Metro imports the domain export without polyfills.
- In-memory fake adapters can execute CRUD, a sync pass, and a retried job.

### Packet 3: Database repositories

Ownership:

- `apps/ios/src/data/**`
- `apps/ios/drizzle/**`

Dependencies: Packet 2.

Work:

- SQLCipher initialization and Keychain key management.
- Migrations, WAL, FTS5, canonical payloads, projections, and repository subscriptions.
- Port all mutation and query behavior from web repositories.

Acceptance:

- Migration, CRUD, FTS, pagination, aggregates, tombstone/undo, dirty guard, and rollback tests pass on Simulator.

### Packet 4: Blob storage

Ownership:

- native storage/hash Swift files
- `apps/ios/src/data/blobs/**`

Dependencies: Packet 2.

Work:

- Streaming hash, sharded paths, atomic writes, metadata, thumbnails, file protection, reference-safe cleanup.

Acceptance:

- Known hashes match server output.
- Duplicate bytes deduplicate.
- Interrupted writes expose no partial blob.
- Cleanup preserves referenced data.

### Packet 5: Sync transport and identity

Ownership:

- `apps/ios/src/sync/transport/**`
- `apps/ios/src/sync/identity/**`
- `apps/ios/src/sync/retry/**`

Dependencies: Packet 2.

Work:

- Pairing, Keychain token handling, protocol transport, file uploads/downloads, retries, cancellation, breaker, redacted logging.

Acceptance:

- Real ephemeral-server tests cover pair, who-am-I, push/pull, stale data, pagination, blob transfer, Retry-After, cancellation, and re-pairing.

### Packet 6: Native Vision module

Ownership:

- `apps/ios/modules/kvitto-native/ios/Vision/**`
- native image processing and OCR files
- module TypeScript facade and XCTest files

Dependencies: Packet 1 and native fixture feasibility gate.

Work:

- Frame plugin, still processing, Core Image pipeline, OCR, cancellation, fixture injection, and timing output.

Acceptance:

- Every fixture produces a usable crop or full-frame fallback.
- OCR enrichment meets the recorded baseline.
- Orientation, cancellation, transform, and memory tests pass.

### Packet 7: App shell and design primitives

Ownership:

- `apps/ios/app/**`
- `apps/ios/src/app/**`
- `apps/ios/src/ui/**`

Dependencies: Packet 1 and Packet 2 interfaces.

Work:

- Tabs, native stacks, sheets, reusable controls, service contexts, boot/recovery states, accessibility foundations.

Acceptance:

- Navigation E2E passes with fakes.
- Dynamic Type, VoiceOver roles, light/dark screenshots, and reduced-motion behavior pass.

### Packet 8: Archive package and PWA export

Ownership:

- `packages/archive/**`
- narrow web export additions under settings/storage

Dependencies: Packet 2.

Work:

- Archive schema/validator/fixtures and streaming browser export.

Acceptance:

- Empty, normal, tombstoned, malformed, tampered, and future-version fixtures behave correctly.
- Browser export does not buffer all image bytes at once.

### Packet 9: Sync engine

Ownership:

- `packages/client-core/src/sync/**`
- `apps/ios/src/sync/engine/**`

Dependencies: Packets 3, 4, and 5.

Work:

- Push-before-pull orchestration, global paging, epoch reconciliation, conflict merge, bounded blob work, triggers, and React state hook.

Acceptance:

- Deterministic in-memory tests and real-server integration cover every synchronization invariant.

### Packet 10: Durable jobs and background adapters

Ownership:

- `packages/client-core/src/jobs/**`
- `apps/ios/src/jobs/**`
- native background-task bridge files

Dependencies: Packets 1 and 3.

Work:

- Job schema, claiming, retries, cancellation, progress, stale suppression, foreground runner, continued processing, and opportunistic background sync.

Acceptance:

- Fake-clock crash recovery and expiration tests pass.
- Physical device successfully invokes and expires background work.

### Packet 11: Receipt, purchase, and collection features

Ownership:

- `apps/ios/src/features/receipts/**`
- `apps/ios/src/features/purchases/**`
- `apps/ios/src/features/collections/**`

Dependencies: Packets 3 and 7.

Work:

- Lists, FTS search, filters, details, editing, tags/categories, deletion/undo, provenance, summaries, and price history.

Acceptance:

- Component and Maestro tests pass against thousands of seeded rows without visible list stalls.

### Packet 12: Scan feature

Ownership:

- `apps/ios/src/features/scan/**`

Dependencies: Packets 3, 4, 6, 7, and 10.

Work:

- Permission flow, camera overlay, auto/manual shutter, review, crop editor, rotation, confirmation, OCR queue, batch import, and crash-safe staging.

Acceptance:

- State-machine, fixture E2E, permissions, interruption, geometry, partial batch failure, and physical auto-capture tests pass.

### Packet 13: AI and company lookup

Ownership:

- `apps/ios/src/ai/**`
- `apps/ios/src/company/**`

Dependencies: Packets 3, 5, and 10.

Work:

- Provider registry/capabilities, current remote adapters, extraction jobs, correction, stale suppression, Foundation Models stub, and Apiverket cache/budget.

Acceptance:

- Mock provider contracts, optional real provider smoke tests, stale-result, correction, cache, and budget tests pass.

### Packet 14: Native migration and settings

Ownership:

- `apps/ios/src/migration/**`
- `apps/ios/src/features/settings/**`
- native ZIP adapter files

Dependencies: Packets 3, 4, 7, and 8.

Work:

- Streaming native ZIP, preflight, atomic import/export, Files/share integration, pairing, storage, debug, and settings screens.

Acceptance:

- Web export imports natively.
- Native re-export validates in shared/web tests.
- Repeated and conflicting imports converge.
- Tampering leaves no partial data.

### Packet 15: Integration and release hardening

Ownership:

- Cross-package wiring after other packets are merged.
- E2E, performance, accessibility, privacy, CI, and documentation additions.

Dependencies: All packets.

Work:

- Full boot wiring, workflow tests, redacted diagnostics, Instruments profiling, physical-device matrix, macOS CI, root README, and TestFlight preparation.

Acceptance:

- All automated and device gates in Sections 17 and 18 pass.

## 17. Parallel Execution Waves

Wave 0:

1. Scaffold project.
2. Run native Vision feasibility spike and shared contract extraction in parallel.
3. Freeze ports and types.

Wave 1, parallel:

- Database repositories
- Blob storage
- Sync transport
- Native Vision module
- App shell
- Archive package/PWA exporter

Wave 2, parallel after their listed dependencies:

- Sync engine
- Durable jobs
- Receipt/purchase/collection features
- Scan feature
- AI/company feature
- Native migration/settings

Wave 3:

1. One integration owner wires all features.
2. Performance and accessibility/privacy reviews run in parallel.
3. CI/documentation/release work follows stable integration.

Do not assign multiple agents to the same ownership directory concurrently.

## 18. Automated Verification

Preserve existing commands:

- `npm run lint`
- `npm run build --workspace @kvitto/shared`
- `npm run typecheck`
- `npm test`
- `npm run build`
- existing web production and pipeline verification

Add iOS checks:

- iOS workspace typecheck
- Jest Expo and React Native Testing Library tests
- Metro iOS bundle/export smoke test
- `xcodebuild test` on a named iOS 26 Simulator
- Swift fixture and image-pipeline XCTest suite
- real companion-server contract tests with temporary data paths
- Maestro fixture-driven E2E
- archive interoperability tests
- screenshot and accessibility checks

Linux CI continues to validate shared/web/server code. A separate macOS workflow validates native builds and Simulator tests. Full E2E and expensive device/performance checks may be nightly or manually dispatched.

## 19. Physical Device Verification

A Simulator cannot prove these behaviors:

- real camera permission and preview
- auto-capture quality and latency
- thermal and memory behavior
- local-network permission behavior
- actual BGTaskScheduler launch timing
- continued-processing cancellation and progress
- Keychain access after device lock/unlock
- TestFlight install and upgrade

These are release gates, not optional observations.

## 20. Performance Budgets

Measure on a named representative iPhone and record model, OS, build type, and fixture.

| Metric | Budget |
|---|---|
| Cold launch to interactive | under 2.0 seconds |
| Warm launch to interactive | under 1.0 second |
| Camera first frame after permission | under 1.0 second |
| Shutter to review p95 | under 1.5 seconds |
| Fixture OCR p95 | under 1.5 seconds |
| Receipt first-page query | under 200 ms |
| Search result after debounce | under 150 ms |
| Foreground metadata sync on LAN | under 2.0 seconds |
| 25-image batch | no unbounded memory growth |

Profile with Instruments Time Profiler, Allocations, Core Animation, Network, and os_signpost data from the native module.

## 21. Agent Working Rules

Every implementation agent must:

1. Read this document, its packet dependencies, the cited current implementation, and the frozen port/type files before editing.
2. Make the smallest packet-complete change within its ownership paths.
3. Reuse shared domain logic instead of copying it into the native app.
4. Add focused tests with the same change.
5. Run the narrowest executable check immediately after the first substantive edit.
6. Preserve unrelated user changes and avoid broad formatting churn.
7. Report changed files, interface assumptions, commands run, test results, device-only checks, and remaining risks.
8. Escalate an interface mismatch to the contract owner instead of silently creating a second abstraction.

No agent may claim completion based only on TypeScript compilation when its packet owns native code or user-visible behavior.

## 22. Primary Reference Files

- `README.md`: current product behavior and verification narrative.
- `package.json`: workspace scripts and conventions.
- `packages/shared/src/types.ts`: canonical entities.
- `packages/shared/src/sync.ts`: sync protocol v2.
- `packages/shared/src/merge.ts`: conservative receipt enrichment.
- `packages/shared/src/extraction.ts`: normalized extraction.
- `packages/shared/src/validate.ts`: arithmetic and domain validation.
- `packages/shared/src/receipt-scan.ts`: deterministic OCR enrichment.
- `apps/web/src/scan/session.ts`: scan state machine and lifecycle.
- `apps/web/src/scan/auto-capture.ts`: trusted automatic shutter rules.
- `apps/web/src/cv/types.ts`: image pipeline behavior contract.
- `apps/web/src/cv/pipeline.ts`: tuned processing reference.
- `apps/web/src/ocr/prepare.ts`: OCR source-image baseline.
- `apps/web/src/ocr/enrich.ts`: blank-only deterministic enrichment.
- `apps/web/src/db/db.ts`: current local tables and indexes.
- `apps/web/src/db/repo.ts`: mutation invariants.
- `apps/web/src/db/queries.ts`: user-facing query semantics.
- `apps/web/src/sync/client.ts`: network protocol details.
- `apps/web/src/sync/engine.ts`: orchestration, epoch, and conflict behavior.
- `apps/web/src/sync/identity.ts`: pairing and unpair behavior.
- `apps/web/src/sync/retry.ts`: retry and circuit breaker behavior.
- `apps/web/src/ai/types.ts`: provider contract.
- `apps/web/src/ai/index.ts`: extraction and correction flow.
- `apps/web/src/core/settings.ts`: settings defaults and secret redaction.
- `apps/web/src/app.ts`: feature inventory and navigation model.
- `apps/server/src/db/schema.ts`: server persistence shape.
- `apps/server/src/db/sync.ts`: server reconciliation behavior.
- `fixtures/receipts`: real scanning/OCR corpus.
- `.github/workflows/ci.yml`: existing checks that must remain green.

## 23. Completion Definition

The rewrite is complete when:

- The native app can scan or import a receipt, review it, save it offline, OCR it on device, edit it, search it, and organize it.
- It pairs and converges with the existing server and PWA, including conflicts, tombstones, secrets, and blobs.
- It resumes safely after termination during image, OCR, extraction, import, or sync work.
- PWA exports can be imported without losing unsynced records or images.
- Accessibility, privacy, resilience, and performance gates pass on Simulator and physical devices.
- Existing shared, web, server, and deployment workflows remain green.
- The future Foundation Models implementation can be added as a provider/job adapter without rewriting screens, repositories, or synchronization.
