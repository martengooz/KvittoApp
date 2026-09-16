import Foundation

struct NativeArchiveEntryIndex {
  let path: String
  let uncompressedSize: Int64
}

enum NativeArchiveZipEngineError: Error {
  case notImplemented(String)
}

final class NativeArchiveZipEngine {
  func openIndex(fileURL: URL) throws -> [NativeArchiveEntryIndex] {
    throw NativeArchiveZipEngineError.notImplemented(
      "ZIP index parsing is implemented in Packet 14 source, but not yet wired into KvittoNativeModule.definition()."
    )
  }
}
