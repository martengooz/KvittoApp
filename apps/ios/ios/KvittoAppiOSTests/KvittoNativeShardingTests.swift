import XCTest

@testable internal import kvitto_native

final class KvittoNativeShardingTests: XCTestCase {
  func testShardingUsesFirstFourHexCharacters() throws {
    let digest = "aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899"
    let shard = try BlobSharding.relativePath(for: digest)
    XCTAssertEqual(shard, "blobs/aa/bb/aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899")
  }

  func testShardingRejectsInvalidDigest() throws {
    XCTAssertThrowsError(try BlobSharding.relativePath(for: "not-a-digest"))
  }
}
