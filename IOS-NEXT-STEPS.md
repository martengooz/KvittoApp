# iOS Rewrite: Next Steps

This is a practical handoff for whoever picks up `apps/ios` next. It assumes
you know React Native and iOS but have not seen this repository before. It is
forward-looking: for the detailed history of what broke and how it was fixed,
read `IOS-IMPLEMENTATION-STATUS.md` (especially the 2026-09-17 entries) and
`git log` on `claude/ios-direct-sql-persistence`. The original spec is
`IOS-HANDOFF.md`; this document assumes you'll refer back to its section 15
(UI inventory), 16 (packets), 18-20 (verification/device/performance), and 23
(completion definition) rather than repeating them here.

## Where this stands

The app builds as a native iOS project (Expo SDK 57, React Native New
Architecture, Hermes) and boots successfully as a standalone Release build on
an iOS 26.5 simulator. All five tabs (Receipts, Purchases, Scan, Collections,
Settings) render and load real data through direct SQL against SQLite. Sync
runs automatically from lifecycle/connectivity/local-edit triggers and pulls
receipt images. The camera preview, capture, torch, and zoom work through
VisionCamera, but only host-tested — nothing camera-related has run on real
hardware, since a simulator has no camera.

Of the eleven pushed/modal route files under `apps/ios/app`, four are real: receipt
detail, extraction, OCR, and filters. Seven route files still render
`RouteSkeletonScreen` placeholders (see "What is left" below) — check with
`grep -rn "RouteSkeletonScreen" apps/ios/app` before trusting any older count
in the status doc, which has described this number inconsistently across
entries as the work progressed.

This was not always true. Earlier checkpoints in `IOS-IMPLEMENTATION-STATUS.md`
claimed a working launch and got it wrong twice — once because the app never
actually started (a startup crash caught only by running it), once because
Jest passed green while a render loop made every tab unusable. Do not trust
"the tests pass" as evidence the app works. See "Traps" below.

## How to run and verify it

Install once from the repo root: `npm install`.

Run the app:

```bash
npm run ios
```

This must be run through the workspace script (`npm run ios`, which runs
`expo run:ios` inside `apps/ios`). Do **not** run `npx expo run:ios` from the
repository root — it does not find the native project, starts scaffolding a
new one, and edits the root `package.json` on the way.

For a Debug or Release build via `xcodebuild` (e.g. to produce the artifact
the smoke check needs), code signing must be turned on even for the
simulator, with an ad-hoc identity:

```bash
export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
cd apps/ios/ios && pod install && cd ../../..

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

`CODE_SIGNING_ALLOWED=NO` produces a binary with no entitlements at all, and
SecureStore then fails at startup with "A required entitlement isn't
present". This has bitten this project twice, including once in CI.

Device smoke check, once you have a built `.app`:

```bash
npm run ios:smoke -- --app <path to the .app> --device "iPhone 17 Pro"
```

`apps/ios/scripts/smoke.mjs` installs the app, launches it, and asserts:
boots to `boot:ready` within 90s and never reports `boot:failed`; every tab
route plus `/receipt/<missing-id>`, its `/extraction` and `/ocr` children, and
`/filters` produce no JavaScript exception and never trip the router's render
error boundary (`render:failed`); and the app is not burning CPU (a delta of
cumulative CPU time over a 3s window, not `ps %cpu`) after visiting each
route. It reads the unified log via `xcrun simctl log stream`, because a
Release build strips `console` and a screenshot can't tell a rendered shell
from a rendered error card — a native `logDiagnostic` call is what makes boot
and render outcomes observable at all. This is the single highest-value check
in this repo; run it after any change that touches boot, composition, hooks,
or navigation.

The full gate list, in the order the status doc uses:

```bash
npm run typecheck:ios
npm run test:ios -- --runInBand
npm run ios:bundle
npm run typecheck        # workspace-wide, includes shared/web/server
npm test                 # workspace-wide
npm run build            # shared, web, server
npm run lint
# then the xcodebuild build/test above, then npm run ios:smoke
```

Current baseline: `npm run test:ios -- --runInBand` passes 46 suites / 180
tests. `npm run lint` reports 10 pre-existing errors (all in files unrelated
to recent iOS work) and a handful of unnecessary-type-assertion warnings —
neither blocks a PR, but don't let the count silently grow.

## Traps this codebase has already sprung

Each of these cost real debugging time on this project. Know them before you
repeat them.

- **Jest passing does not mean the app runs.** The test suite was green twice
  while the app was completely unusable — once because startup crashed before
  the first screen could render, once because a render loop made every tab
  spin forever with no exception thrown. Jest renders in a host environment
  with fakes; it cannot see a SecureStore entitlement failure or a runaway
  effect that only manifests against the real event loop. Run
  `npm run ios:smoke` (or launch on a simulator and watch it) before trusting
  a change to boot, composition, or a tab's data hook.

- **expo-sqlite's `withExclusiveTransactionAsync` opens a second native
  connection** (`useNewConnection: true`). This app applies the SQLCipher key
  (`PRAGMA key`) only to the original connection, so any statement run through
  that helper's second connection fails outright. `src/data/expo-sqlite-adapter.ts`
  works around this with explicit `BEGIN IMMEDIATE` / `COMMIT` / `ROLLBACK` on
  the one keyed connection, with a queue serializing top-level transactions
  (an awaited `BEGIN IMMEDIATE` otherwise lets two concurrent callers both pass
  the depth check and issue a second `BEGIN`, whose failed `ROLLBACK` discards
  the other's work). If you're tempted to use expo-sqlite's transaction
  helpers directly, don't — go through `ExpoSqliteAdapter.transaction`.

- **SecureStore rejects key names with `:` in them.** Only alphanumerics,
  `.`, `-`, and `_` are accepted. `ios:data:sqlcipher-key` failed at startup
  with "Invalid key provided to SecureStore" before the database could even
  open; it's `ios.data.sqlcipher-key` now. There's a regression test
  (`test/data-sql-persistence.test.ts`) asserting every SecureStore key the
  app owns matches the accepted pattern — extend it if you add a new key.

- **Hermes has no `globalThis.crypto`.** `@kvitto/shared` reads it at module
  load to generate ids. The polyfill (installed via `expo-crypto`) is wired
  from `apps/ios/index.js`, which must run before anything imports shared
  code. If you add a new entry point or change the app's bootstrap order,
  keep the polyfill import first. Without it `@kvitto/shared` throws
  "Web Crypto is unavailable; KvittoApp requires a secure context." during
  boot, which surfaces as the startup recovery screen rather than as anything
  naming crypto.

- **`useSyncExternalStore`'s `getSnapshot` must return a stable reference**
  when nothing changed. `Object.is` is the comparison; a fresh object built on
  every call reads as "always changed" and the component re-renders forever,
  eventually tripping React's own depth guard. This app's tab controllers
  build a snapshot once per state change and hand out the same reference
  until the next `emit()` — don't build a fresh object inside `getSnapshot`.

- **A hook's returned actions object must be memoized if any effect depends
  on it.** The receipts hook returned `actions` as a fresh literal every
  render; a screen effect had `actions` in its dependency array, so the
  effect re-ran every render, called `setFilter`, which called `refresh()`,
  which emitted, which re-rendered — unbounded. This one was invisible in
  Jest until a dedicated test rendered the same effect shape and reproduced
  the loop (`test/feature-hook-stability.test.tsx`; it's written to abort the
  process if the loop comes back, rather than just failing an assertion).
  Live, it was invisible too — no exception, no error boundary trip, just an
  idle-looking process saturating the single SQLite connection: 11,337
  queries issued, 218 completed, every other screen's queries queued behind
  it. If you add an effect depending on a controller's returned object, check
  that object is memoized on the controller side first.

- **`ps -o %cpu` on macOS averages over the whole process lifetime.** It
  cannot see a loop that started seconds ago — the number stays low no matter
  how hard the loop is spinning right now. The smoke check instead samples
  `ps -o time=` (cumulative CPU seconds) twice across a window and computes
  the delta. If you write your own device-side CPU check, do the same; `%cpu`
  will lie to you.

- **CPU alone can't catch every render loop, either.** React trips its own
  "Maximum update depth exceeded" guard and stops, leaving an idle process
  sitting behind an error screen — which then reads as healthy on a CPU
  check. That's why the router's error boundary also logs `render:failed` to
  the unified log, and the smoke check treats that as a hard failure
  independent of CPU.

- **`CODE_SIGNING_ALLOWED=NO` strips entitlements.** Without entitlements,
  SecureStore fails at startup even for a plain simulator build. CI used to
  build this way for both `xcodebuild build` and `xcodebuild test`, meaning
  it could never have actually run the app it built. Always sign ad-hoc for
  simulator builds (see the commands above).

- **The workspace hoists a different React version than `apps/ios` pins.**
  npm hoists React 19.3.0 to the repo root while `apps/ios/package.json` pins
  19.2.3. Without a fix, any test that renders a hook sees two React
  dispatchers and every hook call fails. `apps/ios/jest.config.js` pins
  `moduleNameMapper` for `^react$` / `^react/(.*)$` to `apps/ios/node_modules/react`
  — if you touch Jest config, keep that mapping or hook tests will fail in a
  confusing way that has nothing to do with your change.

## What is left

Ordered roughly by the project's own recommended resume order, with effort
and risk notes.

1. **Seven placeholder routes** still render `RouteSkeletonScreen`:
   - `apps/ios/app/receipt/[receiptId]/edit.tsx` (receipt editing)
   - `apps/ios/app/categories.tsx`
   - `apps/ios/app/tags.tsx`
   - `apps/ios/app/pairing/scanner.tsx`
   - `apps/ios/app/debug/log.tsx`
   - `apps/ios/app/archive/preflight.tsx`
   - `apps/ios/app/archive/result.tsx`

   Detail, extraction, OCR, and filters were done in this recent batch of
   work and are a good template: controller-free screens read straight from
   the repository, real not-found/loading states, tests that render the
   actual screen via `react-test-renderer` against a seeded database, and an
   entry added to the smoke check's route list. Categories and tags are
   probably the easiest next (similar shape to filters' category-chip list);
   archive preflight/result and the pairing scanner depend on work further
   down this list (native ZIP, pairing flow) and are more naturally sequenced
   after it.

2. **Haptics.** `ScanHapticsPort` in `src/app/services.tsx` is composed with
   a no-op (`impact() { return; }`). Section 15 of the handoff asks for
   haptics throughout. Small, low-risk — wire `expo-haptics` (not yet a
   dependency) into that port and into whatever else calls for tactile
   feedback (delete, save, capture).

3. **Swipe actions, sheets, and alerts.** Screens currently use plain
   buttons. Section 15 lists these as expected native affordances. Moderate
   effort, no architectural risk — this is UI work on top of the existing
   controllers.

4. **VisionCamera frame processor for auto-capture — the largest remaining
   piece.** `analyzeFrameCompact` currently reports `unsupported` with
   `pluginLinked: false` rather than inventing a detection; the camera bridge
   (`src/features/scan/camera-bridge.ts`) already passes a real reading
   through the moment a plugin supplies one, so the JS/controller side needs
   no rework. What's missing is the native plugin itself: VisionCamera 5
   routes frame processors through Nitro hybrid objects and the
   `react-native-vision-camera-worklets` package, which means adding nitrogen
   codegen to the `kvitto-native` Expo module — a genuinely separate,
   native-Swift-and-codegen-heavy piece of work, not a small addition. Budget
   real time for this; it's the one item on this list requiring new native
   tooling. Tap-to-focus and pinch-to-zoom gestures (zoom is currently
   stepped buttons) are smaller and unrelated, and could be done first if you
   want a native-camera warm-up before tackling the plugin.

5. **BGTask background work.** The periodic sync sweep only runs in the
   foreground; `BGContinuedProcessingTask` registration and bounded
   background sync are not implemented. Needs claim/progress persisted
   against the real jobs table (`src/jobs`, already durable and tested in the
   foreground), plus expiration/cancellation/termination/swipe-away testing —
   all of which require a physical device.

6. **Native ZIP + archive interop.** The Swift ZIP reader/writer isn't
   exposed through the Expo module yet. Once it is: import a real
   web-produced `.kvitto` archive on-device, re-export it, and validate
   round-trips, tampering, rollback, repeated import, and conflicts against
   real files and the real SQLite/blob stores (`packages/archive` already has
   the schema/validation logic from the PWA side).

7. **Maestro E2E, physical-device matrix, performance budgets.** None of
   this has run yet. Section 18-20 of the handoff spell out what's needed:
   Maestro flows against seeded fixtures, real companion-server convergence
   from the native app, light/dark + Dynamic Type + VoiceOver + Reduce Motion
   checks, and the Instruments-measured budgets in section 20 (cold launch
   under 2.0s, shutter-to-review p95 under 1.5s, etc. — none of these numbers
   have been measured on this codebase). Also outstanding: SQLCipher-key
   failure/recovery tests (need a simulator; the Jest test adapter uses
   plain better-sqlite3 with no SQLCipher support) and query profiling
   against a large seeded database.

## Known defects not fixed

- **Two stray SF Symbols render at the top edge of the window**, above the
  status bar, on the tabs screen (the Receipts and Scan icons). They render
  correctly inside the tab bar itself. Removing the wrapping `View` inside
  `tabBarIcon` did not change it; this looks like an interaction between
  expo-router's `Tabs` and the iOS 26 tab bar with native symbol views, not
  something the app's wrapper code controls. Not chased further — worth a
  fresh look if you touch the tab bar or upgrade expo-router/react-native.

- **The smoke check proves the app doesn't break; it does not prove a screen
  shows the right thing.** It asserts no exception, no render-boundary trip,
  and no idle CPU burn per route — it would not catch a screen that renders
  confidently wrong content (e.g. the wrong receipt, a stale total). Maestro
  flows (handoff section 18) are the intended answer for content-level
  assertions and don't exist yet.

- Background sync, real-server convergence, and anything camera-related are
  unverified on a physical device — see "What is left" above. Simulator
  coverage is not a substitute for any of these.

## Architecture notes worth knowing before you change things

- **Boot-owned composition.** `apps/ios/src/app/services.tsx` builds one
  `AppServiceComposition` at boot (`bootstrapProductionAppServices`) —
  repository, sync service, jobs, and a `TabFeatureServices` object handed to
  each tab. `AppServicesProvider` runs this once per boot attempt, retries on
  demand, and disposes the previous composition on teardown or a new attempt.
  Screens and hooks pull their services from `useAppServices()`, not from
  module-level singletons — this is what makes it possible for tests to boot
  a whole fake composition and for `retryBoot()` to cleanly replace a failed
  one.

- **Repository / port boundary.** `IosDataRepository` is the only thing that
  talks SQL; features go through it and through named ports
  (`ScanCameraPort`, `ScanHapticsPort`, `NetworkPort`, etc. — see
  `packages/client-core/src/ports`). This is why VisionCamera, SecureStore,
  and native crypto/hashing can be swapped for fakes in tests without
  touching feature or controller code. Keep new native integrations behind a
  port rather than importing the native module directly into a controller.

- **The filter store and why it exists.** `src/features/receipts/filter-store.ts`
  holds the receipts list's filter outside any one screen, created once at
  boot and exposed as `tabs.receipts.filters`. It exists because the filters
  modal is a separate route from the receipts list, and the list's
  controller is created inside the list screen's own hook — a modal route
  can't reach into that controller, and a controller re-created per screen
  mount would lose the filter every time the list unmounted. Both the list
  controller and the modal read and write through the same store instance.
  Note the delete-vs-undefined distinction: `setFilter({ needsReview:
  undefined })` deletes that key from the filter rather than leaving it
  present-and-undefined, because those two states mean different things to
  the SQL query layer.

- **The camera bridge split.** `src/features/scan/camera-bridge.ts` is a
  plain, non-React `ScanCameraPort` that the scan controller drives
  imperatively. `src/app/camera-preview.tsx` is the React component that
  actually owns the native VisionCamera session for as long as the screen is
  mounted, and registers itself with the bridge. This split means the scan
  controller and its tests never import VisionCamera or React, and a screen
  can mount/unmount without the controller ever holding a stale camera
  reference. If you extend camera behavior, decide whether the new state
  belongs in the bridge (something the controller needs to read/drive) or in
  the preview component (something purely about the native session's
  lifecycle, like releasing the torch on unmount).

- **Tests render real screens against a real database.** Feature tests
  (`apps/ios/test/feature-*.test.tsx`) use `react-test-renderer` to mount
  actual screen components — not shallow renders — wired to
  `SqliteTestAdapter` (`test/support/sqlite-test-adapter.ts`), which is
  backed by real `better-sqlite3`, not an in-memory Map fake. This means
  tests exercise the same SQL, triggers, and FTS index the device runs
  (minus SQLCipher, which better-sqlite3 doesn't support — that gap is
  called out above). When you add a feature test, follow this pattern rather
  than mocking the repository; mocking is exactly what let past defects
  (the render loop, the unindexed item scan) through Jest undetected.

## Where to look next

- `IOS-IMPLEMENTATION-STATUS.md` — full history, "Residual gaps" notes per
  area, and the "Recommended Resume Order" / "Resume Commands" sections this
  document builds on.
- `IOS-HANDOFF.md` — the original spec; sections 15, 16, 18-20, and 23 in
  particular for the feature inventory, packet ownership, verification gates,
  and completion definition.
- `apps/ios/scripts/smoke.mjs`, `apps/ios/src/app/services.tsx`,
  `apps/ios/src/data/expo-sqlite-adapter.ts`,
  `apps/ios/src/features/receipts/filter-store.ts` — read these before
  touching boot, persistence, or the receipts filter flow.
