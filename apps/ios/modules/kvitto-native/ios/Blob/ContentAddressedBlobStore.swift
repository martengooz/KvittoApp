import Foundation

enum ContentAddressedBlobStoreError: Error {
  case invalidSourceURL
  case hashMismatch
}

struct StoredBlobResult {
  let digest: String
  let shardPath: String
  let fileURL: URL
  let deduplicated: Bool
}

final class ContentAddressedBlobStore {
  private let rootDirectory: URL
  private let fileManager: FileManager

  init(rootDirectory: URL, fileManager: FileManager = .default) throws {
    self.rootDirectory = rootDirectory
    self.fileManager = fileManager
    try fileManager.createDirectory(at: rootDirectory, withIntermediateDirectories: true)
  }

  func storeFile(sourceURI: String, knownDigest: String?) throws -> StoredBlobResult {
    guard let sourceURL = URL(string: sourceURI), sourceURL.isFileURL else {
      throw ContentAddressedBlobStoreError.invalidSourceURL
    }

    let digest = try SHA256Hasher.hashFile(at: sourceURL)
    if let knownDigest, !knownDigest.isEmpty, knownDigest.lowercased() != digest {
      throw ContentAddressedBlobStoreError.hashMismatch
    }

    let shardPath = try BlobSharding.relativePath(for: digest)
    let targetURL = rootDirectory.appendingPathComponent(shardPath)
    let targetDirectory = targetURL.deletingLastPathComponent()
    let stagingDirectory = rootDirectory.appendingPathComponent("staging", isDirectory: true)

    try fileManager.createDirectory(at: targetDirectory, withIntermediateDirectories: true)
    try fileManager.createDirectory(at: stagingDirectory, withIntermediateDirectories: true)

    if fileManager.fileExists(atPath: targetURL.path) {
      return StoredBlobResult(digest: digest, shardPath: shardPath, fileURL: targetURL, deduplicated: true)
    }

    let tempURL = stagingDirectory.appendingPathComponent(UUID().uuidString)
    try fileManager.copyItem(at: sourceURL, to: tempURL)
    defer {
      try? fileManager.removeItem(at: tempURL)
    }

    try fileManager.moveItem(at: tempURL, to: targetURL)
    return StoredBlobResult(digest: digest, shardPath: shardPath, fileURL: targetURL, deduplicated: false)
  }
}
