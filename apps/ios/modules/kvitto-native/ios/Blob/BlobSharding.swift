import Foundation

enum BlobShardingError: Error {
  case invalidDigest
}

struct BlobSharding {
  static func relativePath(for digest: String) throws -> String {
    let normalized = digest.lowercased()
    let pattern = "^[a-f0-9]{64}$"
    let regex = try NSRegularExpression(pattern: pattern)
    let range = NSRange(location: 0, length: normalized.utf16.count)
    guard regex.firstMatch(in: normalized, options: [], range: range) != nil else {
      throw BlobShardingError.invalidDigest
    }

    let shard1 = String(normalized.prefix(2))
    let shard2 = String(normalized.dropFirst(2).prefix(2))
    return "blobs/\(shard1)/\(shard2)/\(normalized)"
  }
}
