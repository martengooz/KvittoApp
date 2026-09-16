import XCTest
import Foundation

@testable internal import kvitto_native

final class KvittoNativeHashTests: XCTestCase {
  func testKnownSha256MatchesReference() throws {
    let data = Data("kvitto-native-contract".utf8)
    let tempURL = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try data.write(to: tempURL, options: .atomic)
    defer { try? FileManager.default.removeItem(at: tempURL) }

    let digest = try SHA256Hasher.hashFile(at: tempURL)
    XCTAssertEqual(digest, "6e61064e438a12a775145b565b1863837112a3d8d84d6ac676328b544ec22d50")
  }
}
