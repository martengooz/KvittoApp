import Foundation

protocol NativeArchiveSharePort {
  func shareArchive(fileURL: URL, mimeType: String, filename: String) throws
}

enum NativeArchiveShareAdapterError: Error {
  case notImplemented(String)
}

final class NativeArchiveShareAdapter: NativeArchiveSharePort {
  func shareArchive(fileURL: URL, mimeType: String, filename: String) throws {
    throw NativeArchiveShareAdapterError.notImplemented(
      "Files/share integration source exists, but Expo module entry wiring is intentionally pending."
    )
  }
}
