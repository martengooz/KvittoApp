import XCTest

@testable internal import kvitto_native

/// The coordinator's launch path cannot be driven by the real scheduler:
/// `BGTask` has no public initializer and `BGTaskScheduler` will not launch a
/// task on demand. These tests drive the seam instead, and cover the three
/// things that are expensive to get wrong - the plist contract, buffering a
/// window that arrives before JavaScript, and completing each window once.
final class KvittoNativeBackgroundTaskTests: XCTestCase {
    private var coordinator: KvittoBackgroundTaskCoordinator {
        KvittoBackgroundTaskCoordinator.shared
    }

    override func setUp() {
        super.setUp()
        coordinator.resetForTesting()
    }

    override func tearDown() {
        coordinator.resetForTesting()
        super.tearDown()
    }

    /// The failure this exists to prevent is silent: `BGTaskScheduler.register`
    /// returns false for an identifier missing from the plist, the app launches
    /// normally, and background work simply never happens.
    func testProcessingIdentifierIsPermittedByTheAppBundle() throws {
        let appBundle = try XCTUnwrap(
            Bundle.allBundles.first { $0.bundleIdentifier == "com.kvitto.app.ios" },
            "Expected to resolve the hosted app bundle"
        )

        let permitted = try XCTUnwrap(
            appBundle.object(forInfoDictionaryKey: "BGTaskSchedulerPermittedIdentifiers") as? [String],
            "Info.plist must list BGTaskSchedulerPermittedIdentifiers or registration is refused"
        )

        XCTAssertTrue(
            permitted.contains(KvittoBackgroundTaskCoordinator.processingIdentifier),
            "Registered identifier \(KvittoBackgroundTaskCoordinator.processingIdentifier) is not permitted by Info.plist"
        )

        let modes = try XCTUnwrap(
            appBundle.object(forInfoDictionaryKey: "UIBackgroundModes") as? [String],
            "Info.plist must declare UIBackgroundModes"
        )
        XCTAssertTrue(modes.contains("processing"), "BGProcessingTask requires the `processing` background mode")
    }

    func testLaunchesArrivingBeforeAListenerAreBuffered() {
        let launch = coordinator.simulateLaunchForTesting(handle: "cold")
        XCTAssertEqual(launch.identifier, KvittoBackgroundTaskCoordinator.processingIdentifier)

        let drained = coordinator.drainPendingLaunches()
        XCTAssertEqual(drained.count, 1)
        XCTAssertEqual(drained.first?["handle"] as? String, "cold")

        // Draining hands over ownership; a second call must not replay it, or
        // the same window would be swept twice.
        XCTAssertTrue(coordinator.drainPendingLaunches().isEmpty)
    }

    func testInstallingAListenerHandsOverWhatWasBuffered() {
        _ = coordinator.simulateLaunchForTesting(handle: "waiting")

        var delivered: [String] = []
        coordinator.setListener { launch in
            delivered.append(launch.handle)
        }

        XCTAssertEqual(delivered, ["waiting"])
        // ...and nothing is left behind for a later drain to run again.
        XCTAssertTrue(coordinator.drainPendingLaunches().isEmpty)
    }

    func testAListenerReceivesLaunchesDirectlyRatherThanThroughTheBuffer() {
        var delivered: [String] = []
        coordinator.setListener { launch in
            delivered.append(launch.handle)
        }

        _ = coordinator.simulateLaunchForTesting(handle: "live")

        XCTAssertEqual(delivered, ["live"])
        XCTAssertTrue(coordinator.drainPendingLaunches().isEmpty)
    }

    func testFinishingIsIdempotentPerHandle() {
        _ = coordinator.simulateLaunchForTesting(handle: "once")

        XCTAssertTrue(coordinator.finish(handle: "once", success: true))
        // `setTaskCompleted` traps on a second call, so the second finish has
        // to be refused here rather than passed through.
        XCTAssertFalse(coordinator.finish(handle: "once", success: true))
    }

    func testAnUnknownHandleReadsAsExpired() {
        // "May I start another job?" for a window that does not exist has one
        // safe answer, and it is no.
        XCTAssertTrue(coordinator.isExpired(handle: "never-existed"))
    }

    func testExpirationIsVisibleWithoutCompletingTheTask() {
        _ = coordinator.simulateLaunchForTesting(handle: "running")
        XCTAssertFalse(coordinator.isExpired(handle: "running"))

        coordinator.markExpiredForTesting(handle: "running")

        XCTAssertTrue(coordinator.isExpired(handle: "running"))
        // The sweep is still mid-job and still owes a completion; expiring must
        // not finish the task out from under it, or a claimed job is left with
        // nobody to release it.
        XCTAssertTrue(coordinator.finish(handle: "running", success: false))
    }
}
