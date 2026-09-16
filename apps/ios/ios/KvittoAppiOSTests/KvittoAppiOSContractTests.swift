import XCTest

final class KvittoAppiOSContractTests: XCTestCase {
    func testHostedAppBundleContract() throws {
        let environment = ProcessInfo.processInfo.environment
        let hostExecutablePaths = ["TEST_HOST", "XCInjectBundleInto"].compactMap { environment[$0] }
        let hostBundleCandidates = hostExecutablePaths
            .map { URL(fileURLWithPath: $0).deletingLastPathComponent() }
            .compactMap(Bundle.init(url:))

        let discoveredBundle = Bundle.allBundles.first { bundle in
            bundle.bundleIdentifier == "com.kvitto.app.ios"
        }

        let appBundle = try XCTUnwrap(
            discoveredBundle ?? hostBundleCandidates.first,
            "Expected to resolve hosted app bundle for contract checks"
        )

        XCTAssertEqual(appBundle.bundleIdentifier, "com.kvitto.app.ios")

        let minimumOSVersion = try XCTUnwrap(
            appBundle.object(forInfoDictionaryKey: "MinimumOSVersion") as? String,
            "MinimumOSVersion should be available in app Info.plist"
        )
        XCTAssertEqual(minimumOSVersion, "26.0")
    }
}
