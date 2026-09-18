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
VisionCamera, and live document detection now runs as a Nitro hybrid object in
`modules/kvitto-frames`.

The app **boots on a physical device** (iPhone 15 Pro, iOS 26.6.2) as a signed
Release build, and iOS accepts its `BGProcessingTask` submission there. What
has *not* happened on hardware is the camera: no frame has reached the
detector, because every attempt found the phone locked.

All pushed/modal route files under `apps/ios/app` are real screens —
`grep -rln "RouteSkeletonScreen" apps/ios/app` returns nothing. The simulator
smoke check drives 25 routes; `npm run ios:device-smoke` drives 18 on real
hardware.

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

On a physical device, `simctl` is not available and `devicectl` cannot open a
URL or tap. The app therefore drives itself, from a route list handed to it in
its launch environment:

```bash
xcodebuild build -configuration Release \
  -workspace apps/ios/ios/KvittoAppiOS.xcworkspace -scheme KvittoAppiOS \
  -destination "platform=iOS,id=<device udid>" \
  -derivedDataPath "$DD" -allowProvisioningUpdates
npm run ios:device-smoke -- \
  --app "$DD/Build/Products/Release-iphoneos/KvittoAppiOS.app" \
  --device <device udid> --screenshot /tmp/device.png
```

**The phone must be unlocked**, or the launch is refused before the app starts.
The check fails immediately and says so rather than waiting out its boot
timeout. Unlike the simulator check there is no sample-data seeding — that is
gated on `isSimulator()` deliberately, because someone's own receipts are not
somewhere to write six fake ones — and no CPU check, since `ps` cannot reach a
process on a device.

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

- **A physical device shows you nothing by default.** `devicectl ... --console`
  attaches to the launched process and streams only its stdout and stderr;
  nothing available can stream a device's unified log. `os_log` alone is
  invisible there, which is why `logDiagnostic` mirrors every diagnostic to
  stderr. If you add a marker automation depends on, put it through
  `logDiagnostic` — a `console.log` is stripped from Release and an `os_log`
  cannot be read from a device.

- **A locked phone refuses the launch, and the error does not say "locked"
  anywhere obvious.** `devicectl device process launch` fails with
  `FBSOpenApplicationErrorDomain error 7`. `device-smoke.mjs` detects this and
  says so; if you write your own device tooling, expect it.

- **Nitro and Expo modules cannot share a pod.** Nitro sets
  `SWIFT_OBJC_INTEROP_MODE = objcxx`, and under C++ interop Swift rebuilds
  `ExpoModulesCore` from its `.swiftinterface` — which fails against the
  precompiled XCFramework Expo ships, with a message about SDK and compiler
  versions that names neither Nitro nor Expo. That is why `kvitto-frames` is
  its own pod. For the same reason the Objective-C XCTest target cannot import
  it, so `FrameDocumentScoring.swift` is compiled into the test target
  directly.

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

1. **Archives round-trip, end to end.** Reading, preflighting, writing and
   applying are all done: the Swift reader and writer (round-tripped against
   each other), `src/archive/native-entry-source.ts`, `export.ts`, `apply.ts`,
   and the export, preflight and result screens.

   The ordering in `apply.ts` is the part to preserve. Blobs are extracted to
   staging files **outside** the live blob directory and their SHA-256
   verified there; entities are applied in one transaction; blobs are promoted
   only after that transaction commits. Promoting first would leave orphaned
   images behind a failed import. The reader's CRC says the bytes survived the
   container; the digest says they are the bytes the archive claims. Those are
   different questions, so both are asked.

2. **Checking populated screens on device — read this before adding a screen.**
   The simulator has no camera, so for a long time the device had no receipts
   and the smoke check could only ever prove that empty states render.

   `kvittoapp:///debug/log?seed=1` now seeds six deliberately awkward sample
   receipts (see `src/data/sample-data.ts`), and the smoke check drives it
   before visiting receipt routes with real data. Ids are deterministic and
   prefixed `sample:`, so seeding is idempotent and clearing is exact.

   The gate is `isSimulator()` on the native module, not `__DEV__`: the smoke
   check drives a **Release** build, so a debug-build gate would have made the
   seeding unreachable precisely where it is needed. A real device never gets
   these controls.

   The seed is *proved*, not assumed — the route logs `sample-data:seeded` and
   the check fails if it is missing before the populated routes. A seed that
   silently did nothing would otherwise leave every populated route rendering
   "not found" and still passing, which is the same failure shape this project
   has already been bitten by twice. Two tests keep the id and marker in
   `smoke.mjs` in step with the code.

   **What still cannot be checked: anything needing a tap.** `simctl` cannot
   tap, and neither `idb` nor `fbsimctl` is installed. On a device,
   `devicectl` cannot tap either — but it *can* set environment variables, so
   the app drives its own navigation (`src/app/route-driver.ts`) and
   `devicectl device screenshot` captures the result. Saving from the edit
   screen and the two-step delete are still covered only by host tests.
   Installing `idb` would close the last of it, and remains the single
   highest-value thing available to the next person.

3. **Section 15's control list is complete.** Haptics, alerts, swipe actions
   and sheets are all in, alongside the native controls, system colours,
   Dynamic Type, VoiceOver, Reduce Motion and safe areas that were already
   there. Two conventions to keep when adding a route:

   - **Route options live in `src/app/routes.ts` only.** The root layout maps
     each contract to a `Stack.Screen`. Setting options again on the screen's
     own `Stack.Screen` makes the two disagree — the filters sheet took its
     presentation from one and its header from the other and rendered with a
     duplicate title bar.
   - **Every screen that can grow needs a `ScrollView`.** Filters shipped
     without one and its Apply button was clipped off the bottom of the screen,
     unreachable. A pinned footer below a bounded scroll area does *not* clip
     correctly inside a form sheet — the scroll content paints over it — so put
     the actions in the scroll column until someone works out why.

4. **What still cannot be checked on device: anything needing a tap or a drag.**
   `simctl` can open URLs and screenshot, but cannot tap, and neither `idb` nor
   `fbsimctl` is installed. So the swipe gesture, the native delete alert, and
   every Save button are covered only by host tests. Those tests press the real
   controls against a real SQLite database, so they are not weak — but they
   cannot see a gesture that fails to register or an alert that never appears.
   Installing `idb` is probably the single highest-value thing available here.

   Conventions the finished screens settled on, worth keeping:

   - Haptics go through `src/ui/haptics.ts`, which takes an *outcome*
     (`success`, `error`, `selection`…) rather than a generator, and swallows
     every failure. Feedback is decoration; a simulator has no Taptic Engine and
     a device can refuse in Low Power Mode, and that must never become a failed
     save.
   - Anything that prompts takes an injectable `ConfirmPort`
     (`src/ui/confirm.ts`). `Alert.alert` does nothing under
     `react-test-renderer`, so a screen that calls it directly is a screen whose
     post-confirmation code no test can reach.
   - Swipe actions are real `Pressable`s inside the revealed panel, never
     gesture callbacks. VoiceOver cannot swipe.
   - Adding a swipe pulls Reanimated's worklets into the import graph, which
     throws under Jest. `jest.config.js` sets
     `resolver: 'react-native-worklets/jest/resolver.js'` to handle that — if a
     new screen suddenly fails to import in a test, this is why.

5. **Auto-capture has a detector; nobody has watched it work.**

   `modules/kvitto-frames` is a Nitro hybrid object wrapping
   `VNDetectRectanglesRequest`. `useFrameOutput`'s worklet hands it a
   `CVPixelBufferRef` from `frame.getNativeBuffer()`, and
   `src/app/camera-preview.tsx` reads the newest result back on the JS thread
   for `readLatestFrameAnalysis`.

   Things to know before touching it:

   - **It is a separate pod from `kvitto-native`, and must stay one.** Nitro
     compiles with `SWIFT_OBJC_INTEROP_MODE = objcxx`; under C++ interop Swift
     rebuilds `ExpoModulesCore` from its `.swiftinterface` and fails outright
     against the precompiled XCFramework Expo ships. Merging them breaks the
     build. `modules/kvitto-frames/README.md` says this too.
   - **The frame and its native buffer are released in a `finally`.** Hold
     either past `onFrame` and the camera pipeline stalls — which shows up as
     a preview that freezes, not as an error.
   - **Generated bindings are committed.** After editing anything in
     `modules/kvitto-frames/src/specs`, rerun nitrogen (the command is in the
     README) and `pod install`.
   - **Quads are in Vision's bottom-left space**, matching
     `ReceiptImageProcessor.detectRectangle`, because the same quad goes back
     in as `forcedQuad`. Flipping one side only would crop a live capture
     differently from a still.
   - **A reading older than 900ms is discarded** (`src/features/scan/frame-analysis.ts`).
     The analyzer holds its last result until the next replaces it, which is
     right while frames arrive and wrong when they stop.

   **What is left is verification.** No frame has reached the detector on
   hardware. Run `npm run ios:device-smoke` with the phone unlocked, open the
   Scan tab, and point it at a receipt. What to watch for: whether the preview
   keeps its frame rate (a missed release stalls it), whether `evidenceScore`
   clears 0.35 for a receipt a person would consider well framed, and whether
   the quad lands on the paper rather than on a table edge. The thresholds in
   `FrameDocumentScoring.swift` are reasoned, not measured.

6. **A background task is registered; no granted window has been observed.**

   `src/jobs/background-task.ts` connects iOS background windows to
   `jobs.sweepBackground`. Registration is in the app delegate, because
   `BGTaskScheduler.register` must run before `didFinishLaunchingWithOptions`
   returns. On the device, iOS accepts the submission
   (`[kvitto] background:scheduled scheduled`).

   Rules the code exists to enforce, worth reading before changing it:

   - **Windows are buffered, not pushed.** iOS can launch the app straight
     into the background, before there is a JS runtime to receive an event. A
     cold background launch always arrives through
     `drainPendingBackgroundLaunches()`.
   - **Every window is completed exactly once.** iOS kills an app that never
     completes a launched task and traps on a second completion.
   - **Expiration marks, it does not complete.** Completing from the
     expiration handler would pull the window out from under a running job,
     and a claim whose process died blocks its own retry until it lapses.
   - **An unknown handle reads as expired.** The only safe answer to "may I
     start another job?" for a window nobody owns is no.

   What is left: watching a window iOS actually grants. It may defer the task
   for hours and there is no way to force it from `devicectl`. Attaching LLDB
   and calling `_simulateLaunchForTaskWithIdentifier:` is the usual trick and
   has not been tried here. The debug screen's **Sweep now** runs the same
   drain with no OS window behind it, which proves the drain and nothing about
   scheduling.

7. **Archive reading is done — the notes that matter if you touch it.**
   `NativeArchiveZipEngine.swift` parses the central directory, streams stored
   and deflate entries through Apple's `Compression` framework, verifies CRC-32
   and size, and rejects traversal/absolute/backslash paths. 12 XCTest cases
   cover it, run by `xcodebuild test` on a simulator — no device needed.

   The web writer sets the data-descriptor flag, so local file headers carry
   **zero** for the CRC and both sizes; the real values are only in the central
   directory. A reader that trusts local headers silently returns empty entries
   for every real archive. The test fixtures reproduce that, so they catch a
   regression.

   On the JS side, `src/archive/native-entry-source.ts` streams entries in
   256KB chunks through scratch files and deletes each one in a `finally` —
   abandoning the stream, which is what a rejected import does, must not leave
   the archive unpacked in the caches directory.

8. **Maestro E2E, physical-device matrix, performance budgets.** None of
   this has run yet. Section 18-20 of the handoff spell out what's needed:
   Maestro flows against seeded fixtures, real companion-server convergence
   from the native app, light/dark + Dynamic Type + VoiceOver + Reduce Motion
   checks, and the Instruments-measured budgets in section 20 (cold launch
   under 2.0s, shutter-to-review p95 under 1.5s, etc. — none of these numbers
   have been measured on this codebase). Also outstanding: SQLCipher-key
   failure/recovery tests (need a simulator; the Jest test adapter uses
   plain better-sqlite3 with no SQLCipher support) and query profiling
   against a large seeded database.

   `npm run ios:device-smoke` plus `devicectl device screenshot` now covers
   part of the device matrix cheaply: drive the routes, capture the screen,
   and change the device's appearance or text size between runs. That is not
   Maestro, but it is more than the nothing that was available before.

9. **Things nobody has built yet**, carried forward so they do not get lost:
   company lookup by organisation number, blob upload and download job kinds,
   and sync convergence against a real companion server (the engine is tested
   against fakes; no native client has talked to a running server).

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

- **Nothing camera-related has run on a physical device.** The detector is
  built, tested and links into a device build, but no frame has reached it:
  every attempt found the phone locked. Real-server convergence is likewise
  untried from the native app. Simulator coverage is not a substitute for
  either.

- **The device smoke check cannot see content, only survival.** Like the
  simulator one it proves no exception and no render-boundary trip per route.
  It also cannot check CPU — `ps` does not reach a process on a device — so a
  render loop on hardware would show up only as a route that never finishes.

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
