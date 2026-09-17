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

### 2026-09-17: Archive export, end to end

The ZIP writer was the last thing on the "possible without a device" list that
had no implementation at all. It is done, and so is the export that uses it.

`NativeArchiveZipWriter.swift` deflates entries in streaming chunks through
Apple's `Compression` framework. Unlike the reader it does **not** use data
descriptors: it knows each entry's size and CRC once written and patches the
local header, since seeking back on a local file is cheap. Writing real sizes
into local headers makes the result readable by the widest range of tools,
including ones that ignore the central directory. A failed write deletes the
partial archive, because a truncated archive looks complete to most readers.

It enforces the same path rules the reader does, so an archive this app produces
is one it would accept.

**The writer is tested against the reader.** A round trip through both is the
only evidence that matters, and the reader is already covered against the real
web writer's byte layout. One test also asserts the writer does *not* set the
data-descriptor flag and does write the true size at offset 22, so the two
halves cannot silently drift into the same blind spot.

`src/archive/export.ts` builds the archive: manifest, redacted settings, an
NDJSON stream per entity kind, blob metadata, and the blobs. Three things worth
keeping:

- **Blobs are passed as file URIs, never read into JavaScript.** The writer
  takes files, so exporting a few thousand receipt images is not a memory
  problem.
- **An excluded kind still gets an empty stream.** A missing entity stream is a
  preflight error, so omitting `secrets` would produce an archive this app would
  reject. The rows are dropped; the stream is not.
- **`btoa` alone is not enough.** It only accepts Latin-1, so UTF-8 is widened
  by hand first - otherwise every non-ASCII merchant name throws. There is a
  test with "Kött & Bröd åäö".

Secrets are dropped by `shouldExportEntityKind` and `redactSettings`, the same
implementations the web export uses, so the two cannot diverge. The redaction
test includes one allowed field so it cannot pass just because redaction emptied
the object.

Export needed one more native function, `listAllBlobMetadata`: the blob store
could only list what was pending upload, and an export that silently omitted
every receipt image would be a data-loss trap.

The export screen carries the warning section 14 requires - sensitive contents,
v1 archives not password-protected - both on the screen and in the
confirmation, because a screen can be skimmed and a confirmation cannot. Two
tests assert the warning is a *gate*: declining writes nothing, and the prompt
names the risk rather than asking "are you sure".

Settings now links export, import and pairing, so all of it is reachable.

Verified:
  - `xcodebuild test`: **33 Swift tests**, 0 failures (19 archive: 12 reader,
    7 writer).
  - `npx jest`: 55 suites, **300 tests**, passed.
  - `npm test` (monorepo): all suites passed.
  - `xcodebuild build` Release: succeeded. `npm run ios:smoke`: **25 routes**.
  - `npm run lint`: 10 errors, all pre-existing.

### What I cannot build here

This is the honest boundary, not a to-do list I ran out of time on.

**Needs a physical device — cannot be verified at all on this machine.**
  - Auto-capture's frame processor. A simulator has no camera, so
    `useCameraDevice` returns nothing, the preview never mounts and an `onFrame`
    worklet never runs. See the earlier entry for what VisionCamera 5 actually
    requires; the dependency is installed and the plan corrected.
  - Background task registration. Expiration, cancellation, termination and
    swipe-away cannot be observed on a simulator, and background entitlements
    added blind can break launch invisibly. The sweep itself is built and tested.
  - QR scanning for pairing. The parsing and the manual path are done and
    tested; only the camera path is missing.
  - Anything needing a tap or a drag: `simctl` cannot do either, and neither
    `idb` nor `fbsimctl` is installed. So the swipe gesture, the native alerts,
    and every Save button are covered by host tests only. **Installing `idb`
    would close this whole category** and is the highest-value thing available.
  - The physical-device matrix and Instruments performance budgets.

**Possible here, deliberately not attempted.**
  - **Applying a validated archive.** The last substantial piece. Reading and
    preflighting are done; the apply needs a transactional entity write, blob
    staging outside the live directory, promotion only on success, and staged-file
    cleanup on failure (section 14, requirements 7-10). `packages/archive` has
    the merge plan. I stopped rather than half-build it, because a partly-working
    import that writes some rows and leaves others is worse than one that
    honestly does nothing - which is what the result screen says today.
  - Maestro E2E flows, which would need the same tap tooling as above.

### 2026-09-17: The last placeholder routes

`grep -rln "RouteSkeletonScreen" apps/ios/app` now returns nothing. All eleven
pushed/modal routes are real screens.

**Archive import.** `src/archive/native-entry-source.ts` presents a `.kvitto`
file as the `ArchiveEntrySource` that `packages/archive` already expects, so the
preflight rules written for the web run here unchanged rather than being
reimplemented. Entries are extracted to scratch files one at a time and streamed
back in 256KB chunks: a receipt image can be several megabytes and an archive
can hold thousands, so nothing materialises a whole archive - or a whole entry -
in JavaScript memory. The scratch copy is deleted in a `finally`, so abandoning
the stream (which is what a rejected import does) does not leave the archive
unpacked in the caches directory. Three tests cover that: normal read, early
break, and extraction failure.

This needed one new native function, `readFileChunkBase64`, rather than a new
`expo-file-system` dependency.

The preflight screen reports what importing *would* do and changes nothing,
which is requirement 6 of section 14. The result screen says plainly that
applying an archive is not implemented yet, rather than offering an Import
button that would do nothing - a working-looking control that silently does
nothing is worse than an honest sentence. The report travels between the two
routes through a module value, not a route parameter, because it contains every
issue found including file paths and a route parameter would put that in
navigation history.

**Pairing.** `src/features/pairing/payload.ts` parses the pairing code as either
a `kvitto://pair?...` URL or the JSON behind it. Two decisions worth keeping:

- **http is refused, not warned about.** The pairing token is a bearer
  credential sent to that host on every sync; over http it is handed to anyone
  on the network.
- **No rejection reason echoes the input.** An error is shown on screen and may
  be copied into a bug report, and a bearer token must not travel with it.
  There is a test that pushes a recognisable token through every rejection path
  and asserts it appears in none of them.

Manual entry is a first-class path rather than a fallback: a simulator has no
camera, a code can arrive in a message, and a camera-only screen would be both
unusable here and untestable. Live scanning is not wired, and the screen says
so. The token is cleared from component state once stored.

Verified:
  - `npx jest`: 54 suites, **289 tests**, passed. 25 are new.
  - `npm test` (monorepo): all suites passed.
  - `xcodebuild build` Release: succeeded.
  - `npm run ios:smoke`: passed, **24 routes**, idle CPU 1-2%.
  - `npm run lint`: 10 errors, all pre-existing.

### What is left, and what it needs

Nothing further can be closed out from this machine. The remainder splits in two:

**Needs a physical device.** Auto-capture's frame processor (see the earlier
entry for what VisionCamera 5 actually requires), background task registration,
the camera and QR scanning paths, and the physical-device matrix. A simulator
has no camera, and background expiration and swipe-away cannot be observed on
one.

**Possible here, not done.** The ZIP *writer* for export, applying a validated
archive to the live database and blob store, and Maestro E2E flows. Applying an
archive is the largest: `packages/archive` has the merge plan, but the
transactional apply, blob staging and rollback against the real stores is a
substantial piece in its own right.

### 2026-09-17: A real ZIP reader, and the header quirk it has to survive

`NativeArchiveZipEngine.swift` was a single `notImplemented` throw, and
`packages/archive`'s `zip-adapter.ts` a matching stub, so the archive work had
its preflight, limits, hashing and merge rules but no way to open a file. The
reader is now real.

**The interop detail that decides whether this works at all.** The web writer
(`apps/web/src/migration/archive-export-browser-core.ts`) sets the
data-descriptor flag on every entry, which means local file headers carry
**zero** for the CRC and both sizes; the true values live only in the central
directory and in a descriptor after the payload. A reader that trusts local
headers gets a zero-length entry from every archive the web produces, and does
so silently. This engine reads the central directory. The round-trip tests only
pass because of that - their fixtures have zeroed local headers, exactly like a
real export.

What it does:

- Parses the end-of-central-directory record from the file tail, then the
  central directory.
- Refuses Zip64 by name rather than half-supporting it. The web writer never
  emits one, and a partly-understood container is worse than a rejected one.
- Supports stored (0) and deflate (8). Deflate goes through Apple's
  `Compression` framework in streaming chunks - `COMPRESSION_ZLIB` is raw
  DEFLATE, which is what `CompressionStream('deflate-raw')` produces. Nothing
  loads a whole entry into memory.
- Verifies CRC-32 and the declared uncompressed size on extraction, and
  **deletes the partial output before throwing**, so a failed extraction cannot
  leave a plausible-looking file behind.
- Enforces import requirement 2 at the index, before any caller sees a path:
  no absolute paths, no `..`, no backslash separators, no drive letters.

Exposed through the Expo module as `readArchiveIndex` and
`extractArchiveEntry`, with matching TypeScript contracts.

Verified:
  - `xcodebuild test` on the simulator: **26 Swift tests, 0 failures**, 12 of
    them new. This is the first time this session that native code has been
    covered by tests rather than only compiled - the XCTest target runs on a
    simulator, so it needs no physical device.
  - The new tests build ZIPs the way the web writer does, including the zeroed
    local headers, so they fail if the reader stops matching the writer it has
    to interoperate with.
  - Covered: deflate round-trip, stored round-trip, empty entry, multi-entry
    order, traversal, absolute path, backslash path, CRC mismatch on a flipped
    byte, non-ZIP input, unsupported method, per-entry limit.
  - `npx jest`: 52 suites, 264 tests, passed.
  - `xcodebuild build` Release: succeeded. `npm run ios:smoke`: 21 routes.
  - `npm run lint`: 10 errors, all pre-existing.

Not done: the **writer**. Export still has no ZIP sink on iOS. And nothing in
the app calls the reader yet - the archive preflight and result routes are still
placeholders, and wiring them means driving `packages/archive`'s preflight over
these entries. That is the next piece, and it does not need a device.

### 2026-09-17: A bounded background sweep

Section 11 asks for `BGProcessingTask` or Expo BackgroundTask for
"opportunistic bounded synchronization". The durable job store and the
foreground drain have been there for a while; what was missing was the part
that makes background work different from foreground work, and a way to trigger
it.

`src/jobs/background-runner.ts` is the first half. It is deliberately not the
foreground runner with a timer bolted on, because the two have different failure
modes:

- A foreground drain may stop whenever it likes, and the user is watching.
- A background window is **revocable**. Being killed mid-job is the one outcome
  that costs something: a claimed job whose process died has to wait for its
  claim to lapse before anything retries it.

So the sweep never starts a job it does not expect to finish. It measures what
jobs have actually cost *in this window*, and refuses to start another unless
that much time plus a reserve is still available. A window too small for any job
runs nothing at all rather than starting one that will be killed. That guard is
the load-bearing part of the file: removing the `worstJobMs` term from the
budget check fails three tests, which I verified by doing it.

It also handles what the OS actually does:

- **Expiration is polled, not awaited.** iOS calls an expiration handler on its
  own thread; the adapter flips a flag and the sweep notices at its next
  checkpoint. The job already in flight finishes; no further job starts.
- **A window with no deadline still gets a budget.** `BGProcessingTask` often
  reports none, which is not a licence to run until killed.
- Every stop reason - `idle`, `budget`, `expired`, `max-jobs`, `stopped` -
  leaves the remaining work retryable, as section 11 requires.

`createScanDurableJobService` now builds one alongside the foreground runner,
sharing the same `runOne` handlers, and exposes `sweepBackground(...)`. It is
composed into `AppServiceComposition.jobs`.

**Nothing calls it yet, and that is the honest state.** There is no background
task registered: `expo-background-task` is not installed, and `Info.plist` has
no `UIBackgroundModes` or `BGTaskSchedulerPermittedIdentifiers`. Registration is
the remaining half and it is the half that needs a device - expiration,
cancellation, termination and swipe-away behaviour cannot be observed on a
simulator, and adding background entitlements blind is a good way to break
launch without being able to see it.

Verified:
  - `npm run -w apps/ios typecheck`: clean.
  - `npx jest --config apps/ios/jest.config.js`: 52 suites, 264 tests, passed.
    12 are new, driven by a fake clock so the budget arithmetic is exact and
    nothing sleeps.
  - Mutation-checked the reserve guard: removing it fails 3 tests.
  - `xcodebuild` Release: succeeded.
  - `npm run ios:smoke`: passed, 21 routes. This change touches the boot
    composition, so the app starting at all is the thing worth checking.
  - `npm run lint`: 10 errors, all pre-existing.

### 2026-09-17: Auto-capture groundwork, and a correction to the plan for it

I picked up the VisionCamera frame processor as the largest remaining item, and
the first thing I found was that **the plan recorded for it in this document was
wrong**. Earlier entries (and `IOS-NEXT-STEPS.md`) said it needed "a Nitro
frame-processor plugin plus nitrogen codegen", describing the VisionCamera v3/v4
API. That API does not exist in the pinned version.

What is actually true of `react-native-vision-camera@5.2.3`:

- There is **no `FrameProcessorPlugin` class**. `grep -rl FrameProcessorPlugin
  node_modules/react-native-vision-camera/ios` returns nothing. The plugin
  registry and `VisionCameraProxy.initFrameProcessorPlugin` are gone.
- Frames are consumed through **`useFrameOutput({ onFrame })`**, whose callback
  is a synchronous worklet running on the frame output's own thread. The frame
  must be `dispose()`d immediately or the pipeline stalls and drops frames.
- That hook requires **`react-native-vision-camera-worklets`**, a separate
  package that was not installed. It is now (`5.2.3`, matching the camera), and
  its pod links: `[NitroModules] VisionCameraWorklets is boosted by nitro`.
- To do the Vision work natively rather than in JS, the worklet needs to hand
  `frame.getNativeBuffer()` to a **Nitro hybrid object** exposed by
  `kvitto-native`. That is where nitrogen codegen genuinely comes in - for a
  hybrid object, not for a frame-processor plugin.

So the nitrogen part of the old note survives; the shape of what it generates
does not.

**Current behaviour is inert, not subtly wrong.** `FrameAnalysisAdapter.swift`
returns `status: "unsupported"`, `pluginLinked: false`, `source: "stub"`, and
`toFrameReading` in the scan controller only trusts a frame when
`pluginLinked && evidenceScore >= 0.35`. Auto-capture therefore never arms from
a real frame today; it is disabled, not misbehaving. The auto-capture state
machine itself is already implemented and tested
(`scan-feature.state-machine.test.ts`), driven by injected readings.

**Why I stopped at the dependency rather than writing the worklet.** None of
this path can be exercised here: a simulator has no camera, so
`useCameraDevice('back')` returns nothing, the preview never mounts, and an
`onFrame` worklet never runs. A mistake in that worklet - most obviously a
missed `dispose()` - stalls the camera pipeline, and I would have no way to
observe it. Shipping a frame-thread worklet whose only evidence is "it
compiles" is the same shape as the two failures this project has already had,
where the suite was green and the app was unusable. The remaining work needs a
physical device in the loop, not more code written blind.

Verified (what landing the dependency does and does not change):
  - `xcodebuild` Release: succeeded with the new pod linked.
  - `npx jest --config apps/ios/jest.config.js`: 51 suites, 252 tests, passed.
  - `npm run ios:smoke`: passed, 21 routes, idle CPU 2%.
  - No behaviour change: nothing imports the new package yet.

Next person picking this up needs, in order: a Nitro spec in `kvitto-native`
declaring a hybrid object that takes a native buffer and returns the existing
`FrameAnalysisCompactResult`; nitrogen wired into that module's build; a Swift
implementation running `VNDetectRectanglesRequest`; `useFrameOutput` in
`src/app/camera-preview.tsx` calling it and disposing every frame; and a
`Synchronizable` (from `react-native-worklets`) to carry the reading back for
`readLatestFrameAnalysis`, which `camera-bridge.ts` already declares as an
optional handle. Do it with a device attached.

### 2026-09-17: Sheets, and the unreachable Apply button they exposed

Sheets were the last item on section 15's control list. Working out where one
genuinely belonged mattered more than adding one: the scan screen already shows
camera and "Import from library" as separate buttons, so hiding them behind an
action sheet would have been a regression. Filters is the real case - it is
adjusted against the list behind it, so a half-height detent that keeps that
context visible is better than the full modal it was.

`filters` is now a `formSheet` with detents `[0.5, 1]`, a grabber, and no
navigation bar.

**Presenting it exposed a defect I shipped earlier.** The filters screen had no
`ScrollView`. With the default nineteen category chips its content is taller
than the screen, so Apply and Clear were clipped off the bottom and could not be
pressed **at all** - the screen could be opened but not used. It is the only
screen that was missing one; edit, taxonomy and debug all scroll.

Three things went wrong on the way, all worth recording.

**Route options were set in two places.** The root layout maps every contract to
a `Stack.Screen`, and the route file set its own as well. The two disagreed: the
sheet took its presentation from one and its header from the other, and rendered
with the title twice - once in the native bar, once in the content behind it.
The contract in `src/app/routes.ts` is now the single source, including
`headerShown` and the sheet detents, and the route file sets nothing.

**A pinned footer would not clip inside the sheet.** Keeping the actions below a
bounded `ScrollView` is the nicer design and it is what I tried first; inside a
form sheet the scroll area painted over the buttons regardless of `flexGrow`
versus `flex: 1`. Rather than keep guessing at the cause, the actions now scroll
with the content in one column. That fixes the actual defect - unreachable
buttons - and behaves at every detent. The nicer version can come back if
someone works out why the scroll area does not clip there.

**`npx prettier --write` reformatted a whole file.** There is no Prettier config
in this repo, so it used its defaults and rewrote 194 lines of `filters-view.tsx`
to double quotes, against the style of every other file. Reverted and redone by
hand. Do not run Prettier here until the repo has a config.

Verified:
  - `npm run -w apps/ios typecheck`: clean.
  - `npx jest --config apps/ios/jest.config.js`: 51 suites, 252 tests, passed.
  - `npm test` (monorepo): all suites passed.
  - `npm run ios:smoke`: passed, 21 routes, idle CPU 1-2%.
  - Screenshot confirmed the sheet opens at the half detent with a grabber, the
    list visible behind it, one title, and no overlapping controls. Three
    earlier screenshots in this session caught the duplicate header and the
    overlap that the tests could not see.
  - `npm run lint`: 10 errors, all pre-existing.

Not verified on device: that Apply can be *scrolled to*. `simctl` cannot drag.
A test asserts it is inside the scroll view, which is what was wrong before.

Section 15's control list is now complete: native controls, system colours,
Dynamic Type, VoiceOver, Reduce Motion, safe areas, haptics, sheets, alerts and
swipe actions.

### 2026-09-17: Haptics, alerts, and swipe actions

Section 15 of the handoff asks for haptics, sheets, alerts and swipe actions.
Three of the four are in. Checking first was worth it: `useDeferredValue`,
`startTransition` and Reduce Motion were already done, so only the feedback
and gesture affordances were actually missing.

**Haptics** were a no-op `ScanHapticsPort`. `src/ui/haptics.ts` wraps
`expo-haptics` behind a vocabulary of outcomes - success, warning, error,
selection, impact - so callers say what happened and one file decides how it
feels. Every call is swallowed: a simulator has no Taptic Engine and a device
can refuse in Low Power Mode, and letting that reject would turn decoration
into a failed save. Fired on completed deletes, saves, and failures, not on
every tap.

**Alerts** closed a real gap rather than ticking a box. The detail screen's
"Delete receipt" deleted on the first press with nothing asked. It now confirms
through a native alert that names the receipt and counts the line items going
with it. The prompt is awaited *outside* the screen's `run()` helper, because
`run` sets its status label once the work resolves - inside it, declining would
have reported "Deleted." for a receipt that still existed. There is a test for
exactly that.

`ConfirmPort` is injectable (`nativeConfirm`, `alwaysConfirm`, `neverConfirm`)
because `Alert.alert` does nothing under `react-test-renderer`: a test that
cannot answer the prompt could never reach the code past it.

**Swipe actions** are on receipt rows: delete (confirmed) and, only where it
would change something, mark reviewed. The revealed actions are ordinary
`Pressable`s rather than gesture callbacks, so VoiceOver can reach them - it
cannot perform a swipe - and so tests can press them. The swipe only decides
whether the panel is visible. `GestureHandlerRootView` now wraps the whole app;
it was missing entirely, so any gesture would have silently done nothing.

One trap worth recording. `ReanimatedSwipeable` pulls in Reanimated, which
boots a worklets runtime at import time and throws under Jest. Adding the first
swipe action therefore made `features/receipts/view.tsx` impossible to import in
a test - and nothing would have caught it, because **no test had ever rendered
the receipts list**. `react-native-worklets` ships
`jest/resolver.js`, which steers those imports away from their `.native` entry
points; that is now in `jest.config.js`. The new test file renders the list for
the first time.

Verified:
  - `npm run -w apps/ios typecheck`: clean.
  - `npx jest --config apps/ios/jest.config.js`: 51 suites, 250 tests, passed.
    11 are new.
  - `npm run ios:smoke`: passed, 21 routes, idle CPU 1-2%. This matters more
    than usual here: a broken `GestureHandlerRootView` would break every screen,
    not just the list.
  - Screenshot confirmed the list rows are unchanged by the swipe wrapper - a
    plausible regression, since `Swipeable` wraps each row.
  - `npm run lint`: 10 errors, all pre-existing.

Not verified on device: the swipe gesture itself, and the alert. `simctl`
cannot drag or tap, and neither `idb` nor `fbsimctl` is installed. The revealed
actions and both confirm branches are covered by host tests that press the real
controls against a real database; what is unproven on device is that the
gesture reveals the panel and that the alert appears.

Dependency added: `expo-haptics@~57.0.3`, installed via `npx expo install` from
inside `apps/ios` (running it from the repo root scaffolds a stray `ios/`
directory - see the earlier entry). `pod install` was run; skipping it is what
made the crypto polyfill fail at runtime once before.

### 2026-09-17: Sample data on device, and a smoke check that can finally see a populated screen

The previous entry recorded a standing gap: the simulator has no camera and no
seeding path, so the device had no receipts, and every receipt-dependent screen
could only ever be checked in its empty state. The smoke check visited receipt
routes with an id that does not exist and passed - proving only that the
not-found branch renders.

That is closed. `src/data/sample-data.ts` writes six receipts chosen to be
awkward rather than tidy: confirmed, parsed, a draft with no lines, a failed
one, a fuel receipt with a single fractional-quantity line, and one whose lines
deliberately do not add up to its total, so the edit screen's warning has
something real to warn about. Ids are deterministic and prefixed `sample:`,
which makes seeding idempotent and clearing exact - `clearSampleData` cannot
touch a real receipt however it got onto the device.

`app/debug/log.tsx` is now a real screen: entity counts, startup steps, and the
seed/clear actions.

Three things about it are worth keeping.

**The gate is the simulator, not a debug build.** The smoke check drives a
*Release* build, so `__DEV__` would have made these actions unreachable exactly
where they are needed. A new `isSimulator()` on the native module answers with
`#if targetEnvironment(simulator)`; a real device never gets the controls,
Release or not. A device that cannot answer - no native module - is treated as
real.

**Seeding is reachable by deep link.** `simctl` cannot tap, so a button alone
would have left this as useless to automation as the camera was. `?seed=1`
seeds on open, which is what lets the smoke check drive it.

**The smoke check proves the seed happened.** The route logs
`sample-data:seeded` to the unified log and the check fails if it does not
appear before the populated routes. Without that, a seed that silently did
nothing would leave every populated route rendering "not found" - and still
passing. That is the same failure shape as the two this project has already
been bitten by, so it is guarded rather than assumed. Two tests keep the
hard-coded id and marker in `smoke.mjs` in step with the code; both were
mutation-checked by breaking them and confirming they fail.

The check now visits 21 routes: the old not-found pass, then a seed, then the
list, purchases, collections and all four receipt routes with real data.

Verified:
  - `npm run -w apps/ios typecheck`: clean.
  - `npx jest --config apps/ios/jest.config.js`: 50 suites, 239 tests, passed.
  - `npm run ios:smoke`: passed, 21 routes, idle CPU 1-2%.
  - Screenshots confirmed, **for the first time on device**, the receipts list
    rendering real rows (dates, totals, statuses, sorted by purchase date) and
    the populated edit screen with its status and category selections showing.
  - `npm run lint`: 10 errors, all pre-existing.

Still not driven on device: anything needing a tap - the two-step delete, the
edit screen's Save. `simctl` cannot tap and neither `idb` nor `fbsimctl` is
installed here. Those paths are covered by host tests that press the real
controls against a real SQLite database. Installing `idb` would close this last
gap.

Placeholder routes remaining: three files - pairing scanner, archive preflight,
and archive result. All three depend on work further down the list (the pairing
flow, native ZIP). Verify with
`grep -rln "RouteSkeletonScreen" apps/ios/app`.

### 2026-09-17: The receipt editor, and one receipt with one owner

`receipt/[receiptId]/edit.tsx` was the last self-contained placeholder. Filling
it in turned up a duplication worth removing first.

The detail screen already edited merchant, purchase date and notes inline, with
its own Save. `saveReceiptEdits` in the receipts controller has always handled
category, tags and status too - the detail screen simply never rendered controls
for them, and nothing anywhere edited line items, though `addItem`, `updateItem`
and `deleteItem` have existed on the repository the whole time.

So rather than add a second screen writing the same fields, editing now has one
owner. `src/features/receipts/edit-view.tsx` is the full editor: merchant, date,
notes, status, category, tags, and line items. The detail screen shows those
fields read-only and has an "Edit receipt" button. Two screens writing one
receipt is how they drift apart, and there was no test covering detail's inline
Save, so nothing was protecting the old arrangement.

Three decisions worth keeping:

- **Line fields commit on blur, not per keystroke.** Writing on every change
  persists a half-typed "1" on the way to "12.50", and each write wakes every
  subscriber. A test types a partial name and asserts the database still holds
  the old value.
- **Arithmetic disagreements are reported, never corrected.** If quantity times
  unit price misses the line total, or the lines do not add up to the receipt
  total, the screen says so and leaves the numbers alone. A printed receipt can
  legitimately disagree with itself - rounding, a basket-level discount, a
  missed line - and silently rewriting the total destroys evidence of what was
  actually printed. This follows the filters screen's inverted-range handling.
- **Blank is not zero.** An empty unit price stores `null`, meaning "not
  stated", not `0`. Unparseable input leaves the stored value untouched.

The tag-link logic moved from the controller to the repository as
`setReceiptTags` / `listTagIdsForReceipt`, so the modal and the controller share
one implementation. The controller's version used `Date.now()` directly rather
than the injected clock, which made it untestable at a fixed time; the
repository version uses `this.now()`. Links are tombstoned rather than dropped,
and re-attaching a removed tag revives the original deterministic link id
instead of creating a second row for the same pair, which would race itself on
the next sync.

Verified:
  - `npm run -w apps/ios typecheck`: clean.
  - `npx jest --config apps/ios/jest.config.js`: 49 suites, 226 tests, passed.
    22 are new (15 edit screen, 5 tag links, 2 detail).
  - `npm test` (monorepo): 55 passed.
  - `npm run ios:smoke`: passed, 12 routes including
    `/receipt/smoke-missing-id/edit`, idle CPU 1-2%.
  - `npm run lint`: 10 errors, all pre-existing.

Not verified on device: the *populated* editor. The smoke check visits receipt
routes with an id that does not exist, and the simulator has no camera and no
seeding path, so the device has no receipts at all - only the "Receipt
unavailable" branch can be reached there. The populated form, saving, and every
line-item path are covered by the 15 host tests, which drive the real controls
against a real SQLite database.

**This is a standing gap, not a one-off.** No receipt-dependent screen can be
exercised on device beyond its empty state. A debug-only "seed sample data"
action would fix it for every such screen at once, and `app/debug/log.tsx` - one
of the remaining placeholders - is the natural host.

Build note: `xcodebuild` failed twice with "database is locked" because a Debug
build was running against the same DerivedData. Building with an explicit
`-derivedDataPath` avoids contending with a dev build, which is what CI already
does.

Placeholder routes remaining: four files - pairing scanner, debug log, archive
preflight, and archive result. Verify with
`grep -rln "RouteSkeletonScreen" apps/ios/app`.

### 2026-09-17: Categories and tags are editable

Both taxonomy routes were placeholders, and nothing in the app linked to them at
all, so the seeded categories could be filtered on but never renamed, recoloured
or added to.

`src/features/taxonomy/taxonomy-view.tsx` is one screen serving both. Categories
and tags differ only in whether a row carries an emoji glyph and in what
deleting one costs, which is not enough to justify two files that drift apart,
so the screen takes a `kind` and branches in the two places that actually
differ.

The work that needed care was deletion, not the form. A receipt and an item each
hold a `categoryId`, and a `receiptTags` row holds a `tagId`. Tombstoning the
row those point at would leave a dangling reference that renders as a blank
category forever and is invisible until someone looks. `deleteCategory` and
`deleteTag` now clear every reference in the same transaction as the tombstone,
and return the counts so the screen can say what it is about to change.

Two details in the repository worth knowing:

- The clearing writes go through the private `writeEntity`, not `upsert`.
  `upsert` notifies subscribers on every call, so clearing a category used by
  two hundred receipts would wake every subscriber two hundred times *during*
  the transaction, each one reading a half-applied database. One event is
  emitted after the transaction commits. A test asserts exactly one event for a
  three-receipt delete.
- A new category's `sortOrder` is one past the highest existing one, so adding
  one does not reshuffle an order the user arranged.

Deletion is two-step in the UI. There is no `Alert` in this app yet, and a
destructive action needs a confirmation, so it lives in the row and spells out
the consequence: "Delete 'Fika'? Used by 1 receipt and 0 items. Deleting clears
it from them; the receipts themselves are kept." That is more honest than an
Alert's "Are you sure?" and needs no API that does not exist yet.

Validation is at the field: a `#rrggbb` colour and a non-blank, case-insensitively
unique name, both blocking Save rather than failing at the write.

Entry points: Settings grew a Taxonomy card. Navigation stays in the route and
arrives as `onOpenCategories` / `onOpenTags` props, matching how the receipts
list reaches `/filters`, which keeps `SettingsFeatureScreen` renderable in tests
without a router.

Verified:
  - `npm run -w apps/ios typecheck`: clean.
  - `npx jest --config apps/ios/jest.config.js`: 48 suites, 204 tests, passed.
    24 are new (13 repository, 11 screen).
  - `npm run ios:smoke`: passed, 11 routes including `/categories` and `/tags`,
    idle CPU 1%.
  - Screenshot confirmed the list renders 19 categories with swatches, glyphs
    and usage counts.
  - `npm run lint`: 10 errors, all pre-existing.

Not verified on device: the two-step delete could not be driven, because
`simctl` cannot tap and neither `idb` nor `fbsimctl` is installed here. The
confirm and delete paths are covered by the screen tests, which press the real
controls and then assert against the database.

Correction: an earlier entry said the filters modal rendered "all 20 seeded
categories". `DEFAULT_CATEGORIES` has 19.

Placeholder routes remaining: five files - receipt edit, pairing scanner, debug
log, archive preflight, and archive result. Verify with
`grep -rln "RouteSkeletonScreen" apps/ios/app` rather than trusting a count
written by hand.

### 2026-09-17: Filters modal, and the shared filter store it needed

The filters route was the awkward placeholder: the filter lived inside the
receipts controller, which is created inside the receipts screen's hook, so a
modal route could not reach it, and a per-screen controller would lose the
filter every time the list unmounted.

`src/features/receipts/filter-store.ts` now owns it. It is created once at boot,
exposed on the composition as `tabs.receipts.filters`, and both the list and the
modal talk to it. `ReceiptsFeatureController` takes it optionally, seeds from it,
refreshes on its notifications, and routes its own `setFilter` through it so the
two cannot disagree. The controller has a `dispose()` that detaches, and the
hook calls it on unmount.

An explicit `undefined` in a patch deletes the key rather than leaving it
present-and-undefined, because `{ needsReview: undefined }` reaching the SQL
layer is not the same thing as no filter at all.

`app/filters.tsx` renders a real modal: purchase date range, total range, status
chips, category chips read live from the repository, and needs-review. It opens
showing what is already applied, counts them, refuses to apply an inverted
amount or date range (saying which), and offers Clear all. The receipts list
gained a Filters button showing the active count.

Tests (`test/feature-receipt-filters.test.tsx`, 9 tests): undefined clears a
field; subscribers see real changes once and never a no-op; empty arrays, empty
strings and false do not count as active; a store write refreshes the list and a
disposed controller stops following it; `setFilter` routes through the store;
and the screen renders applied filters, category chips, and both inverted-range
warnings.

- Verification evidence:
  - `npm run typecheck:ios`, `npm run typecheck`: passed.
  - `npm run test:ios -- --runInBand`: 46 suites, 180 tests passed.
  - `npm test`, `npm run ios:bundle`: passed.
  - `npm run ios:smoke`: passed, 9 routes including `/filters`, idle CPU 1-2%.
  - Screenshot confirmed the modal renders with all 20 seeded categories.
  - `npm run lint`: 10 errors, all pre-existing.

Placeholder routes remaining at the time of this entry: seven files - receipt
edit, categories, tags, pairing scanner, debug log, archive preflight, and
archive result. Verify with `grep -rln "RouteSkeletonScreen" apps/ios/app`
rather than trusting a count written by hand; an earlier revision of this entry
said "five" and was wrong. (Categories and tags have since been implemented.)

### 2026-09-17: Extraction and OCR routes are real

The receipt detail screen added earlier links onward to extraction and OCR, and
both of those landed on placeholder skeletons - a dead end introduced by that
change. Both are now real, controller-free screens reading straight from the
repository and following later edits:

- **Extraction**: provider, model, completion time, duration, token usage, the
  failure reason when the pass failed, and every normalisation warning.
  Distinguishes "no extraction yet" (naming the receipt's status) from a
  missing receipt.
- **OCR**: engine, mean confidence, timing, every organisation number found
  (marking repaired ones) and every candidate date with its confidence, plus the
  verbatim recognised text in a scroll view. Calls out empty recognised text
  rather than rendering a blank box.

Tests (`test/feature-receipt-provenance.test.tsx`, 7 tests) render both screens
against a seeded database and cover the populated, failed, not-yet-run, and
missing-receipt paths for each.

The smoke check now also walks `/receipt/<id>`, `/receipt/<id>/extraction` and
`/receipt/<id>/ocr` with an id that does not exist, which exercises their real
loading and not-found paths rather than a placeholder.

- Verification evidence:
  - `npm run typecheck:ios`, `npm run typecheck`: passed.
  - `npm run test:ios -- --runInBand`: 46 suites, 180 tests passed.
  - `npm test`, `npm run ios:bundle`: passed.
  - `npm run ios:smoke`: passed, all 8 routes, idle CPU 1-2%.
  - Screenshot confirmed the OCR route pushes with a "Receipt" back title and
    renders its not-found state.
  - `npm run lint`: 10 errors, all pre-existing.

Placeholder routes remaining: eight files - receipt edit, filters, categories,
tags, pairing scanner, debug log, archive preflight, and archive result.

### 2026-09-17: Device smoke check in CI, proven against both past failures

The highest-value gap was that the test suite had passed green twice while the
app was unusable. There is now a device smoke check, and it is proven to catch
both failures that got through.

`apps/ios/scripts/smoke.mjs` installs the built Release app on a simulator,
launches it, and asserts:

- the app reports `boot:ready` within 90s, and never `boot:failed`,
- visiting every tab route produces no JavaScript exception,
- no screen trips the render error boundary,
- the app is not burning CPU on any route while idle.

Run with `npm run ios:smoke -- --app <path to .app> [--device <name or udid>]`.

To make boot and render outcomes observable at all, a native `logDiagnostic`
writes to the unified log under subsystem `com.kvitto.app.ios`, category
`diagnostics`. A Release build strips `console`, and a screenshot cannot tell a
rendered shell apart from a rendered error card, so automation needed one
unambiguous signal. `runBootAttempt` emits `boot:ready`/`boot:failed`, and the
router error boundary emits `render:failed`.

Proven in both directions, by rebuilding the app with each bug reintroduced:

- SecureStore key name with colons: **caught**, reporting
  `boot:failed ... Invalid key provided to SecureStore`.
- Unstable `actions` in the receipts hook: **caught** at the exact route,
  reporting `Visiting / tripped the render error boundary: Maximum update depth
  exceeded`.
- The fixed build passes, with idle CPU of 1-2% per route.

Two things learned while building it, both of which would have made the gate
useless:

- `ps -o %cpu` on macOS is an average over the whole process lifetime, so it
  hides a loop that started seconds ago. The check samples cumulative CPU time
  and computes a delta over a window instead.
- CPU alone cannot see a runaway render loop, because React trips its own depth
  guard and stops it, after which the app sits idle behind an error screen. That
  is why the error boundary reports itself.

Also fixed in CI: `Xcode build` and `Xcode test` used `CODE_SIGNING_ALLOWED=NO`,
which produces a binary with no entitlements, so SecureStore fails at startup.
Both steps now sign ad-hoc, and the build step produces the Release product the
smoke check consumes.

- Verification evidence:
  - `npm run typecheck:ios`: passed.
  - `npm run test:ios -- --runInBand`: 46 suites, 180 tests passed.
  - `npm run typecheck`, `npm test`: passed.
  - `npm run ios:smoke`: passed on the fixed build, failed on each reintroduced bug.
  - `npm run lint`: 10 errors, all pre-existing.

### 2026-09-17: Handoff gap audit, SF Symbols, FlashList, and a real receipt detail route

Audited the working app against `IOS-HANDOFF.md` section 15 (UI Feature
Inventory). The largest gap was that **all nine pushed/modal routes were
placeholder skeletons** rendering `RouteSkeletonScreen`, and nothing in the app
navigated to them - there was no `router.push` or `Link` anywhere.

Closed in this pass:

- **SF Symbols are real.** The wrapper reached for `react-native-sfsymbols`,
  which was never installed, so every symbol fell back to a letter - that is why
  the tab bar read "R P S C G". It now uses `expo-symbols`, keeping the text
  fallback for symbols a given iOS version does not have. The tab bar renders
  `doc.text`, `cart`, `camera.viewfinder`, `tray.full`, and `gearshape`.
- **FlashList replaces FlatList** in the receipts, purchases, and collections
  lists, which section 15 requires. Jest needed `@shopify/flash-list` added to
  `transformIgnorePatterns`; it ships ESM.
- **The receipt detail route is real.** `app/receipt/[receiptId].tsx` now renders
  a controller-backed screen with provenance, editable merchant/date/notes,
  save, mark-reviewed, delete, links to extraction and OCR, and the line items.
  Tapping a row in the receipts list pushes it. The list keeps its in-place
  selection when no navigation callback is supplied, so the screen stays
  testable without a navigator.
- **Rendering one receipt no longer loads every item in the database.**
  `loadDetails` called `listAllLive(repository, 'items')` and filtered in
  JavaScript, which section 15 explicitly forbids. Added
  `repository.listReceiptItems(receiptId)`, which reads through the existing
  `(receiptId, deletedAt, lineNo)` index.

Tests added (`test/feature-receipt-detail.test.tsx`, 6 tests): the detail screen
renders provenance and items in line order, reports a missing or deleted receipt
instead of spinning, handles a receipt with no items, follows repository changes
without remounting, and the indexed item lookup returns only that receipt's live
items in line order. These render real screens through `react-test-renderer`
against a seeded SQLite database.

- Verification evidence:
  - `npm run typecheck:ios`: passed.
  - `npm run test:ios -- --runInBand`: 46 suites, 180 tests passed.
  - `npm run ios:bundle`, `npm run typecheck`, `npm test`, `npm run build`: passed.
  - `xcodebuild test` on iPhone 17 Pro / iOS 26.5: 14 native tests, 0 failures.
  - Release build installed and launched: tab bar shows real SF Symbols, and
    `kvittoapp:///receipt/does-not-exist` pushes the detail route, which reports
    "Receipt unavailable" with a working back button. No JS exceptions.
  - `npm run lint`: 10 errors, all pre-existing.

**Known cosmetic defect:** two SF Symbols (the Receipts and Scan icons) also
render at the top edge of the window, above the status bar, on the tabs screen.
They are correct in the tab bar itself. Removing the wrapping `View` inside
`tabBarIcon` did not change it, so this looks like an expo-router `Tabs` and
iOS 26 tab bar interaction with native symbol views rather than something the
wrapper controls. Not chased further.

### Remaining gaps against the handoff

Measured against `IOS-HANDOFF.md`, not against the packet table:

1. **Three pushed/modal route files are still placeholders**: pairing scanner,
   archive preflight, archive result. (Receipt detail, edit, extraction, OCR,
   filters, categories, tags and debug are done.) Confirm with
   `grep -rln "RouteSkeletonScreen" apps/ios/app`.
2. **No haptics.** `ScanHapticsPort` is composed with a no-op; section 15 asks
   for haptics.
3. **No swipe actions, sheets, or alerts.** Section 15 lists them; the screens
   use plain buttons.
4. **Live VisionCamera frame processing** (auto-capture) - needs Nitro/nitrogen.
5. **Background work**: `BGContinuedProcessingTask` and bounded background sync.
6. **Native ZIP bridge** and web/native archive interoperability.
7. **Maestro E2E flows**, real-server convergence, the physical-device matrix,
   Instruments performance budgets, and the accessibility/appearance matrix
   (sections 18-20).
8. ~~A device smoke check in CI~~ - done, see the entry above. What it does not
   yet assert is screen *content*: it would not catch a screen that renders the
   wrong thing without erroring. Maestro flows (section 18) remain the answer
   for that.

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
  - `npm run test:ios -- --runInBand`: 46 suites, 180 tests passed.
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
  - `npm run test:ios -- --runInBand`: 46 suites, 180 tests passed.
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
  - `npm run test:ios -- --runInBand`: 46 suites, 180 tests passed.
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
  - `npm run test:ios -- --runInBand`: 46 suites, 180 tests passed.
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
- `npm run test:ios -- --runInBand`: 46 suites, 180 tests passed
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
| 7. App shell/UI | Implemented | Real SF Symbols via expo-symbols. Needs the remaining pushed/modal routes, haptics, swipe actions, and the accessibility/appearance matrix. |
| 8. Archive/PWA export | Mostly complete | PWA streaming ZIP exists; cross-platform interoperability still needs end-to-end validation. |
| 9. Sync engine | Implemented and composed | Automatic triggers, real connectivity, and blob download persistence are wired and tested. Background execution and a real-server app run remain. |
| 10. Durable jobs | Partial | Repository-backed durable queue/store, strict multi-kind foreground handlers, and lifecycle service are composed; native background bridge behavior (BGTask) remains. |
| 11. Receipt/purchase/collection | Implemented | FlashList lists, indexed per-receipt item reads, and a real pushed receipt detail route. Needs E2E, large-data profiling, and interaction polish. |
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

1. Register a background task so `jobs.sweepBackground(...)` is actually
  called: install `expo-background-task` (or register `BGProcessingTask`
  natively), declare the identifier and `UIBackgroundModes` in `Info.plist`,
  and have the handler build a `JobBackgroundWindow` from the OS deadline and
  flip the expiration flag from the OS expiration handler. Needs a device.
  Without hardware, the next piece is the archive import flow: the ZIP reader
  now exists and is tested, so what remains is driving `packages/archive`'s
  preflight over its entries and replacing the archive preflight/result
  placeholder routes. The ZIP writer is also still missing.
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