import Foundation

struct BlobMetadataRecord: Codable {
  let uri: String
  let mimeType: String
  let width: Int
  let height: Int
  let byteSize: Int
  let sha256Id: String?
  let role: String
  let createdAt: Int
  let uploadedAt: Int?
  let pendingUpload: Bool
  let shardPath: String
}

actor BlobMetadataStore {
  private let fileManager: FileManager
  private let metadataDirectory: URL

  init(rootDirectory: URL, fileManager: FileManager = .default) throws {
    self.fileManager = fileManager
    self.metadataDirectory = rootDirectory.appendingPathComponent("metadata", isDirectory: true)
    try fileManager.createDirectory(at: metadataDirectory, withIntermediateDirectories: true)
  }

  func put(_ record: BlobMetadataRecord) throws -> BlobMetadataRecord {
    let fileURL = fileURLForRecord(record.sha256Id ?? record.uri)
    let data = try JSONEncoder().encode(record)
    try data.write(to: fileURL, options: .atomic)
    return record
  }

  func get(_ id: String) throws -> BlobMetadataRecord? {
    let fileURL = fileURLForRecord(id)
    guard fileManager.fileExists(atPath: fileURL.path) else {
      return nil
    }
    let data = try Data(contentsOf: fileURL)
    return try JSONDecoder().decode(BlobMetadataRecord.self, from: data)
  }

  func markUploaded(_ id: String, uploadedAt: Int) throws {
    guard var record = try get(id) else {
      return
    }
    record = BlobMetadataRecord(
      uri: record.uri,
      mimeType: record.mimeType,
      width: record.width,
      height: record.height,
      byteSize: record.byteSize,
      sha256Id: record.sha256Id,
      role: record.role,
      createdAt: record.createdAt,
      uploadedAt: uploadedAt,
      pendingUpload: false,
      shardPath: record.shardPath
    )
    _ = try put(record)
  }

  func delete(_ id: String) -> Bool {
    let fileURL = fileURLForRecord(id)
    guard fileManager.fileExists(atPath: fileURL.path) else {
      return false
    }
    do {
      try fileManager.removeItem(at: fileURL)
      return true
    } catch {
      return false
    }
  }

  func listPendingUpload(limit: Int) throws -> [BlobMetadataRecord] {
    let entries = try fileManager.contentsOfDirectory(at: metadataDirectory, includingPropertiesForKeys: nil)
    var pending: [BlobMetadataRecord] = []
    for entry in entries {
      let data = try Data(contentsOf: entry)
      let decoded = try JSONDecoder().decode(BlobMetadataRecord.self, from: data)
      if decoded.pendingUpload {
        pending.append(decoded)
      }
    }

    pending.sort { lhs, rhs in
      lhs.createdAt < rhs.createdAt
    }

    if pending.count <= limit {
      return pending
    }
    return Array(pending.prefix(limit))
  }

  private func fileURLForRecord(_ id: String) -> URL {
    metadataDirectory.appendingPathComponent(id + ".json")
  }
}
