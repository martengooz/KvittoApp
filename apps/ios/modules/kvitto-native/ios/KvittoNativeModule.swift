import ExpoModulesCore
import Foundation
import ImageIO
import os

public final class KvittoNativeModule: Module {
  private let cancellationRegistry = CancellationRegistry()
  private let frameAdapter = VisionFrameAnalysisAdapter()
  private let archiveZipEngine = NativeArchiveZipEngine()
  private let orientationNormalizer = ImageOrientationNormalizer()
  private let processor = ReceiptImageProcessor()
  private let textRecognizer = VisionTextRecognizer()

  private lazy var blobRoot: URL = {
    let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
      ?? URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
    return base.appendingPathComponent("kvitto-native", isDirectory: true)
  }()

  private lazy var scratchRoot: URL = {
    let base = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first
      ?? URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
    return base.appendingPathComponent("kvitto-scratch", isDirectory: true)
  }()

  private lazy var blobStore: ContentAddressedBlobStore = {
    do {
      return try ContentAddressedBlobStore(rootDirectory: blobRoot)
    } catch {
      fatalError("Unable to initialize blob store: \(error)")
    }
  }()

  private lazy var metadataStore: BlobMetadataStore = {
    do {
      return try BlobMetadataStore(rootDirectory: blobRoot)
    } catch {
      fatalError("Unable to initialize metadata store: \(error)")
    }
  }()

  public func definition() -> ModuleDefinition {
    Name("KvittoNative")

    AsyncFunction("hashFileSha256") { (fileUri: String) -> String in
      let fileURL = try self.requireFileURL(fileUri)
      return try SHA256Hasher.hashFile(at: fileURL)
    }

    // Archive import. The engine reads the central directory rather than local
    // headers, because the web writer zeroes the latter; see the engine.
    AsyncFunction("readArchiveIndex") { (fileUri: String) async throws -> [[String: Any]] in
      let fileURL = try self.requireFileURL(fileUri)
      return try self.archiveZipEngine.openIndex(fileURL: fileURL).map { entry in
        [
          "path": entry.path,
          "uncompressedSize": entry.uncompressedSize,
          "compressedSize": entry.compressedSize,
          "method": Int(entry.method),
        ]
      }
    }

    AsyncFunction("extractArchiveEntry") { (fileUri: String, path: String, destinationUri: String) async throws -> Int in
      let fileURL = try self.requireFileURL(fileUri)
      let destinationURL = try self.requireFileURL(destinationUri)
      let entries = try self.archiveZipEngine.openIndex(fileURL: fileURL)
      guard let entry = entries.first(where: { $0.path == path }) else {
        throw NativeArchiveZipEngineError.malformed("no such entry: \(path)")
      }
      try self.archiveZipEngine.extract(entry: entry, from: fileURL, to: destinationURL)
      return Int(entry.uncompressedSize)
    }

    AsyncFunction("computeBlobShardPath") { (sha256Id: String) -> String in
      try BlobSharding.relativePath(for: sha256Id)
    }

    AsyncFunction("storeContentAddressedFile") { (input: [String: Any]) async throws -> [String: Any] in
      let sourceUri = try self.requireString(input, key: "sourceUri")
      let mimeType = try self.requireString(input, key: "mimeType")
      let width = try self.requireInt(input, key: "width")
      let height = try self.requireInt(input, key: "height")
      let byteSize = try self.requireInt(input, key: "byteSize")
      let role = try self.requireString(input, key: "role")
      let knownSha = input["knownSha256Id"] as? String

      let stored = try self.blobStore.storeFile(sourceURI: sourceUri, knownDigest: knownSha)
      let now = Int(Date().timeIntervalSince1970 * 1000)
      let record = BlobMetadataRecord(
        uri: stored.fileURL.absoluteString,
        mimeType: mimeType,
        width: width,
        height: height,
        byteSize: byteSize,
        sha256Id: stored.digest,
        role: role,
        createdAt: now,
        uploadedAt: nil,
        pendingUpload: true,
        shardPath: stored.shardPath
      )

      _ = try await self.metadataStore.put(record)
      return self.encodeRecord(record)
    }

    AsyncFunction("putBlobMetadata") { (input: [String: Any]) async throws -> [String: Any] in
      let record = try self.decodeRecord(input)
      let saved = try await self.metadataStore.put(record)
      return self.encodeRecord(saved)
    }

    AsyncFunction("getBlobMetadata") { (sha256Id: String) async throws -> [String: Any]? in
      guard let record = try await self.metadataStore.get(sha256Id) else {
        return nil
      }
      return self.encodeRecord(record)
    }

    AsyncFunction("markBlobUploaded") { (sha256Id: String) async throws -> Void in
      let now = Int(Date().timeIntervalSince1970 * 1000)
      try await self.metadataStore.markUploaded(sha256Id, uploadedAt: now)
    }

    AsyncFunction("listBlobMetadataPendingUpload") { (limit: Int) async throws -> [[String: Any]] in
      let rows = try await self.metadataStore.listPendingUpload(limit: max(0, limit))
      return rows.map(self.encodeRecord)
    }

    AsyncFunction("deleteBlobMetadata") { (sha256Id: String) async -> Bool in
      await self.metadataStore.delete(sha256Id)
    }

    // Whether this build is running on a simulator. Debug-only affordances that
    // write sample data are gated on this rather than on a debug build flag,
    // because the automated smoke check drives a *Release* build on a simulator
    // and would otherwise be unable to reach them - while a real device, Release
    // or not, never can.
    Function("isSimulator") { () -> Bool in
      #if targetEnvironment(simulator)
        return true
      #else
        return false
      #endif
    }

    // Release builds strip `console.log`, so milestones that automation needs to
    // observe (boot completing, boot failing) go to the unified log instead.
    Function("logDiagnostic") { (category: String, message: String) -> Void in
      os_log("%{public}@ %{public}@", log: OSLog(subsystem: "com.kvitto.app.ios", category: "diagnostics"), type: .default, category, message)
    }

    // iOS sandboxes the app: `/tmp` is not writable, so scratch files have to be
    // created under the app's own caches directory.
    Function("makeScratchFileUri") { (prefix: String, fileExtension: String) -> String in
      let directory = self.scratchRoot
      try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
      let safePrefix = prefix.isEmpty ? "scratch" : prefix
      return directory
        .appendingPathComponent("\(safePrefix)-\(UUID().uuidString).\(fileExtension)")
        .absoluteString
    }

    AsyncFunction("deleteScratchFile") { (fileUri: String) -> Bool in
      guard let url = URL(string: fileUri), url.isFileURL else { return false }
      guard url.path.hasPrefix(self.scratchRoot.path) else { return false }
      do {
        try FileManager.default.removeItem(at: url)
        return true
      } catch {
        return false
      }
    }

    AsyncFunction("resetBlobUploadState") { () async throws -> Int in
      try await self.metadataStore.resetUploadState()
    }

    // A blob pulled from the server: the bytes are verified against the id the
    // server indexed them under, stored content-addressed, and recorded as
    // already uploaded so the next sync pass does not push them straight back.
    AsyncFunction("storeDownloadedBlob") { (input: [String: Any]) async throws -> [String: Any] in
      let base64 = try self.requireString(input, key: "base64")
      let mimeType = try self.requireString(input, key: "mimeType")
      let expectedId = try self.requireString(input, key: "sha256Id")
      let role = try self.requireString(input, key: "role")

      guard let data = Data(base64Encoded: base64) else {
        throw NSError(
          domain: "KvittoNative",
          code: 5003,
          userInfo: [NSLocalizedDescriptionKey: "Downloaded blob payload was not valid base64"]
        )
      }

      let stagingDirectory = self.blobRoot.appendingPathComponent("staging", isDirectory: true)
      try FileManager.default.createDirectory(at: stagingDirectory, withIntermediateDirectories: true)
      let tempURL = stagingDirectory.appendingPathComponent("download-" + UUID().uuidString)
      try data.write(to: tempURL, options: .atomic)
      defer {
        try? FileManager.default.removeItem(at: tempURL)
      }

      let stored = try self.blobStore.storeFile(sourceURI: tempURL.absoluteString, knownDigest: expectedId)
      let size = (try? self.imageDimensions(at: stored.fileURL)) ?? (width: 0, height: 0)
      let now = Int(Date().timeIntervalSince1970 * 1000)
      let record = BlobMetadataRecord(
        uri: stored.fileURL.absoluteString,
        mimeType: mimeType,
        width: size.width,
        height: size.height,
        byteSize: data.count,
        sha256Id: stored.digest,
        role: role,
        createdAt: now,
        uploadedAt: now,
        pendingUpload: false,
        shardPath: stored.shardPath
      )

      _ = try await self.metadataStore.put(record)
      return self.encodeRecord(record)
    }

    AsyncFunction("normalizeOrientation") { (sourceUri: String, outputUri: String, jpegQuality: Double, cancellationId: String?) async throws -> [String: Any] in
      if await self.cancellationRegistry.isCancelled(cancellationId) {
        throw KvittoCancellationError()
      }

      let sourceURL = try self.requireFileURL(sourceUri)
      let outputURL = try self.requireFileURL(outputUri)
      let normalized = try self.orientationNormalizer.normalize(sourceURL: sourceURL, destinationURL: outputURL, jpegQuality: jpegQuality)
      let digest = try SHA256Hasher.hashFile(at: outputURL)

      return [
        "uri": outputURL.absoluteString,
        "mimeType": "image/jpeg",
        "width": normalized.width,
        "height": normalized.height,
        "byteSize": normalized.bytes,
        "sha256Id": digest,
        "role": "processed",
      ]
    }

    AsyncFunction("detectRectangle") { (sourceUri: String, cancellationId: String?) async throws -> [String: Any]? in
      if await self.cancellationRegistry.isCancelled(cancellationId) {
        return nil
      }

      let sourceURL = try self.requireFileURL(sourceUri)
      guard let quad = try self.processor.detectRectangle(sourceURL: sourceURL) else {
        return nil
      }
      return try self.encodeQuad(quad)
    }

    AsyncFunction("processReceiptImage") { (input: [String: Any]) async throws -> [String: Any] in
      let cancellationId = input["cancellationId"] as? String
      if await self.cancellationRegistry.isCancelled(cancellationId) {
        throw KvittoCancellationError()
      }

      guard let source = input["source"] as? [String: Any] else {
        throw NSError(domain: "KvittoNative", code: 4001, userInfo: [NSLocalizedDescriptionKey: "Missing source descriptor"])
      }

      let sourceUri = try self.requireString(source, key: "uri")
      let outputUri = try self.requireString(input, key: "outputUri")
      let thumbnailUri = try self.requireString(input, key: "thumbnailUri")
      let maxLongEdge = try self.requireInt(input, key: "maxLongEdge")
      let jpegQuality = try self.requireDouble(input, key: "jpegQuality")
      let enhancement = try self.requireString(input, key: "enhancement")
      let forcedQuad = try self.decodeQuad(input["forcedQuad"])

      let sourceURL = try self.requireFileURL(sourceUri)
      let outputURL = try self.requireFileURL(outputUri)
      let thumbnailURL = try self.requireFileURL(thumbnailUri)

      let processed = try self.processor.process(
        sourceURL: sourceURL,
        outputURL: outputURL,
        thumbnailURL: thumbnailURL,
        maxLongEdge: maxLongEdge,
        jpegQuality: jpegQuality,
        enhancement: enhancement,
        forcedQuad: forcedQuad
      )

      let outputHash = try SHA256Hasher.hashFile(at: outputURL)
      let thumbHash = try SHA256Hasher.hashFile(at: thumbnailURL)

      return [
        "output": [
          "uri": outputURL.absoluteString,
          "mimeType": "image/jpeg",
          "width": processed.outputWidth,
          "height": processed.outputHeight,
          "byteSize": processed.outputBytes,
          "sha256Id": outputHash,
          "role": "processed",
        ],
        "thumbnail": [
          "uri": thumbnailURL.absoluteString,
          "mimeType": "image/jpeg",
          "width": processed.thumbnailWidth,
          "height": processed.thumbnailHeight,
          "byteSize": processed.thumbnailBytes,
          "sha256Id": thumbHash,
          "role": "thumb",
        ],
        "rectangle": try self.encodeOptionalQuad(processed.rectangle),
        "detectionSource": processed.detectionSource,
        "fallbackUsed": processed.fallbackUsed,
        "timing": [
          "startedAtMs": processed.timing.startedAtMs,
          "endedAtMs": processed.timing.endedAtMs,
          "durationMs": processed.timing.durationMs,
        ],
      ]
    }

    AsyncFunction("recognizeText") { (input: [String: Any]) async throws -> [String: Any] in
      let cancellationId = input["cancellationId"] as? String
      if await self.cancellationRegistry.isCancelled(cancellationId) {
        let now = Int(Date().timeIntervalSince1970 * 1000)
        return [
          "text": "",
          "observations": [],
          "usedLanguages": [],
          "supportedLanguages": self.textRecognizer.supportedLanguages(),
          "cancelled": true,
          "timing": [
            "startedAtMs": now,
            "endedAtMs": now,
            "durationMs": 0,
          ],
        ]
      }

      guard let source = input["source"] as? [String: Any] else {
        throw NSError(domain: "KvittoNative", code: 4002, userInfo: [NSLocalizedDescriptionKey: "Missing source descriptor"])
      }
      let sourceUri = try self.requireString(source, key: "uri")
      let preferredLanguages = (input["preferredLanguages"] as? [String]) ?? ["sv-SE", "en-US"]
      let sourceURL = try self.requireFileURL(sourceUri)

      let result = try self.textRecognizer.recognize(sourceURL: sourceURL, preferredLanguages: preferredLanguages)
      let now = Int(Date().timeIntervalSince1970 * 1000)

      return [
        "text": result.text,
        "observations": result.observations,
        "usedLanguages": result.usedLanguages,
        "supportedLanguages": self.textRecognizer.supportedLanguages(),
        "cancelled": false,
        "timing": [
          "startedAtMs": now - result.durationMs,
          "endedAtMs": now,
          "durationMs": result.durationMs,
        ],
      ]
    }

    AsyncFunction("cancelOperation") { (cancellationId: String) async -> Bool in
      await self.cancellationRegistry.cancel(cancellationId)
      return true
    }

    AsyncFunction("analyzeFrameCompact") { (frameTimestampMs: Double, cancellationId: String?) async throws -> [String: Any] in
      if await self.cancellationRegistry.isCancelled(cancellationId) {
        let now = Int(Date().timeIntervalSince1970 * 1000)
        return [
          "status": "cancelled",
          "pluginLinked": false,
          "evidenceScore": 0,
          "coverage": 0,
          "normalizedQuad": NSNull(),
          "source": "stub",
          "timing": [
            "startedAtMs": now,
            "endedAtMs": now,
            "durationMs": 0,
          ],
        ]
      }

      let analysis = self.frameAdapter.analyzeCompactFrame(frameTimestampMs: frameTimestampMs)
      return [
        "status": analysis.status,
        "pluginLinked": analysis.pluginLinked,
        "evidenceScore": analysis.evidenceScore,
        "coverage": analysis.coverage,
        "normalizedQuad": try self.encodeOptionalQuad(analysis.normalizedQuad),
        "source": analysis.source,
        "timing": [
          "startedAtMs": analysis.timing.startedAtMs,
          "endedAtMs": analysis.timing.endedAtMs,
          "durationMs": analysis.timing.durationMs,
        ],
      ]
    }
  }

  /// Reads pixel dimensions from the image header, without decoding the image.
  private func imageDimensions(at url: URL) throws -> (width: Int, height: Int) {
    guard
      let source = CGImageSourceCreateWithURL(url as CFURL, nil),
      let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
      let width = properties[kCGImagePropertyPixelWidth] as? Int,
      let height = properties[kCGImagePropertyPixelHeight] as? Int
    else {
      throw NSError(
        domain: "KvittoNative",
        code: 5002,
        userInfo: [NSLocalizedDescriptionKey: "Could not read image dimensions"]
      )
    }
    return (width, height)
  }

  private func requireFileURL(_ uri: String) throws -> URL {
    guard let url = URL(string: uri), url.isFileURL else {
      throw NSError(domain: "KvittoNative", code: 5001, userInfo: [NSLocalizedDescriptionKey: "Expected file:// URI"])
    }

    let parent = url.deletingLastPathComponent()
    try? FileManager.default.createDirectory(at: parent, withIntermediateDirectories: true)
    return url
  }

  private func requireString(_ input: [String: Any], key: String) throws -> String {
    guard let value = input[key] as? String else {
      throw NSError(domain: "KvittoNative", code: 5100, userInfo: [NSLocalizedDescriptionKey: "Missing string key \(key)"])
    }
    return value
  }

  private func requireInt(_ input: [String: Any], key: String) throws -> Int {
    if let value = input[key] as? Int {
      return value
    }
    if let value = input[key] as? Double {
      return Int(value)
    }
    throw NSError(domain: "KvittoNative", code: 5101, userInfo: [NSLocalizedDescriptionKey: "Missing int key \(key)"])
  }

  private func requireDouble(_ input: [String: Any], key: String) throws -> Double {
    if let value = input[key] as? Double {
      return value
    }
    if let value = input[key] as? Int {
      return Double(value)
    }
    throw NSError(domain: "KvittoNative", code: 5102, userInfo: [NSLocalizedDescriptionKey: "Missing double key \(key)"])
  }

  private func decodeRecord(_ input: [String: Any]) throws -> BlobMetadataRecord {
    BlobMetadataRecord(
      uri: try requireString(input, key: "uri"),
      mimeType: try requireString(input, key: "mimeType"),
      width: try requireInt(input, key: "width"),
      height: try requireInt(input, key: "height"),
      byteSize: try requireInt(input, key: "byteSize"),
      sha256Id: input["sha256Id"] as? String,
      role: try requireString(input, key: "role"),
      createdAt: try requireInt(input, key: "createdAt"),
      uploadedAt: input["uploadedAt"] as? Int,
      pendingUpload: (input["pendingUpload"] as? Bool) ?? true,
      shardPath: try requireString(input, key: "shardPath")
    )
  }

  private func encodeRecord(_ record: BlobMetadataRecord) -> [String: Any] {
    [
      "uri": record.uri,
      "mimeType": record.mimeType,
      "width": record.width,
      "height": record.height,
      "byteSize": record.byteSize,
      "sha256Id": record.sha256Id as Any,
      "role": record.role,
      "createdAt": record.createdAt,
      "uploadedAt": record.uploadedAt as Any,
      "pendingUpload": record.pendingUpload,
      "shardPath": record.shardPath,
    ]
  }

  private func decodeQuad(_ value: Any?) throws -> NormalizedQuad? {
    guard let dictionary = value as? [String: Any] else {
      return nil
    }

    func point(_ key: String) throws -> NormalizedPoint {
      guard let raw = dictionary[key] as? [String: Any],
            let x = raw["x"] as? Double ?? (raw["x"] as? Int).map(Double.init),
            let y = raw["y"] as? Double ?? (raw["y"] as? Int).map(Double.init) else {
        throw NSError(domain: "KvittoNative", code: 5200, userInfo: [NSLocalizedDescriptionKey: "Invalid quad point \(key)"])
      }
      return NormalizedPoint(x: x, y: y)
    }

    return NormalizedQuad(
      topLeft: try point("topLeft"),
      topRight: try point("topRight"),
      bottomRight: try point("bottomRight"),
      bottomLeft: try point("bottomLeft")
    )
  }

  private func encodeQuad(_ quad: NormalizedQuad) throws -> [String: Any] {
    [
      "topLeft": ["x": quad.topLeft.x, "y": quad.topLeft.y],
      "topRight": ["x": quad.topRight.x, "y": quad.topRight.y],
      "bottomRight": ["x": quad.bottomRight.x, "y": quad.bottomRight.y],
      "bottomLeft": ["x": quad.bottomLeft.x, "y": quad.bottomLeft.y],
    ]
  }

  private func encodeOptionalQuad(_ quad: NormalizedQuad?) throws -> Any {
    guard let quad else {
      return NSNull()
    }
    return try encodeQuad(quad)
  }
}
