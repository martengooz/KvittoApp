import XCTest

@testable internal import kvitto_native

final class KvittoNativeBlobStoreTests: XCTestCase {
  private var root: URL!

  override func setUpWithError() throws {
    root = URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
      .appendingPathComponent("kvitto-blob-tests-" + UUID().uuidString, isDirectory: true)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
  }

  override func tearDownWithError() throws {
    try? FileManager.default.removeItem(at: root)
  }

  private func writeSource(_ contents: String) throws -> URL {
    let url = root.appendingPathComponent("source-" + UUID().uuidString + ".bin")
    try Data(contents.utf8).write(to: url)
    return url
  }

  private func record(id: String, uploaded: Bool) -> BlobMetadataRecord {
    BlobMetadataRecord(
      uri: "file:///blobs/\(id)",
      mimeType: "image/jpeg",
      width: 1,
      height: 2,
      byteSize: 3,
      sha256Id: id,
      role: "thumb",
      createdAt: 10,
      uploadedAt: uploaded ? 20 : nil,
      pendingUpload: !uploaded,
      shardPath: "blobs/\(id)"
    )
  }

  func testStoreRejectsBytesThatDoNotMatchTheExpectedDigest() throws {
    let store = try ContentAddressedBlobStore(rootDirectory: root.appendingPathComponent("cas"))
    let source = try writeSource("receipt bytes")

    // A download indexed under one id must not be stored under another: this is
    // the integrity gate for blobs pulled from the server.
    XCTAssertThrowsError(
      try store.storeFile(
        sourceURI: source.absoluteString,
        knownDigest: "0000000000000000000000000000000000000000000000000000000000000000"
      )
    ) { error in
      XCTAssertEqual(error as? ContentAddressedBlobStoreError, .hashMismatch)
    }
  }

  func testStoreAcceptsMatchingDigestAndDeduplicates() throws {
    let store = try ContentAddressedBlobStore(rootDirectory: root.appendingPathComponent("cas"))
    let source = try writeSource("receipt bytes")
    let digest = try SHA256Hasher.hashFile(at: source)

    let first = try store.storeFile(sourceURI: source.absoluteString, knownDigest: digest)
    XCTAssertFalse(first.deduplicated)
    XCTAssertTrue(FileManager.default.fileExists(atPath: first.fileURL.path))

    let second = try store.storeFile(sourceURI: try writeSource("receipt bytes").absoluteString, knownDigest: digest)
    XCTAssertTrue(second.deduplicated)
    XCTAssertEqual(second.digest, first.digest)
  }

  func testResetUploadStateMarksUploadedBlobsPendingAgain() async throws {
    let store = try BlobMetadataStore(rootDirectory: root.appendingPathComponent("meta"))
    _ = try await store.put(record(id: "uploaded-1", uploaded: true))
    _ = try await store.put(record(id: "uploaded-2", uploaded: true))
    _ = try await store.put(record(id: "pending-1", uploaded: false))

    let reset = try await store.resetUploadState()

    // Only the two already-uploaded blobs change; the pending one is untouched.
    XCTAssertEqual(reset, 2)
    let pending = try await store.listPendingUpload(limit: 10)
    XCTAssertEqual(Set(pending.compactMap(\.sha256Id)), ["uploaded-1", "uploaded-2", "pending-1"])

    let restored = try await store.get("uploaded-1")
    XCTAssertEqual(restored?.pendingUpload, true)
    XCTAssertNil(restored?.uploadedAt)
    XCTAssertEqual(restored?.role, "thumb")
    XCTAssertEqual(restored?.shardPath, "blobs/uploaded-1")
  }

  func testResetUploadStateIsIdempotent() async throws {
    let store = try BlobMetadataStore(rootDirectory: root.appendingPathComponent("meta"))
    _ = try await store.put(record(id: "uploaded-1", uploaded: true))

    let first = try await store.resetUploadState()
    let second = try await store.resetUploadState()
    XCTAssertEqual(first, 1)
    XCTAssertEqual(second, 0)
  }
}
