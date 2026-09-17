import Compression
import Foundation

struct NativeArchiveEntryIndex {
  let path: String
  let uncompressedSize: Int64
  let compressedSize: Int64
  /// ZIP compression method. 0 = stored, 8 = deflate; nothing else is accepted.
  let method: UInt16
  let crc32: UInt32
  let localHeaderOffset: UInt64
}

enum NativeArchiveZipEngineError: Error, Equatable {
  case notAZipFile
  case unsupportedZip64
  case unsupportedMethod(UInt16)
  case malformed(String)
  case unsafePath(String)
  case checksumMismatch(path: String, expected: UInt32, actual: UInt32)
  case sizeMismatch(path: String, expected: Int64, actual: Int64)
}

/// Streaming CRC-32 (IEEE), which ZIP requires and Foundation does not provide.
struct Crc32 {
  private static let table: [UInt32] = {
    (0..<256).map { index -> UInt32 in
      var value = UInt32(index)
      for _ in 0..<8 {
        value = (value & 1) == 1 ? (0xEDB8_8320 ^ (value >> 1)) : (value >> 1)
      }
      return value
    }
  }()

  private var value: UInt32 = 0xFFFF_FFFF

  mutating func update(_ bytes: UnsafeRawBufferPointer) {
    var current = value
    for byte in bytes {
      current = Crc32.table[Int((current ^ UInt32(byte)) & 0xFF)] ^ (current >> 8)
    }
    value = current
  }

  mutating func update(_ data: Data) {
    data.withUnsafeBytes { update($0) }
  }

  var checksum: UInt32 { value ^ 0xFFFF_FFFF }
}

private enum Signature {
  static let localFileHeader: UInt32 = 0x0403_4B50
  static let centralDirectoryHeader: UInt32 = 0x0201_4B50
  static let endOfCentralDirectory: UInt32 = 0x0605_4B50
  static let zip64EndOfCentralDirectory: UInt32 = 0x0606_4B50
}

private extension Data {
  func u16(_ offset: Int) -> UInt16 {
    UInt16(self[startIndex + offset]) | (UInt16(self[startIndex + offset + 1]) << 8)
  }

  func u32(_ offset: Int) -> UInt32 {
    var value: UInt32 = 0
    for byte in (0..<4).reversed() {
      value = (value << 8) | UInt32(self[startIndex + offset + byte])
    }
    return value
  }
}

/// How much of the file tail is searched for the end-of-central-directory
/// record. The record is 22 bytes plus a comment of at most 65535.
private let eocdSearchWindow = 22 + 0xFFFF

/// Reads `.kvitto` archives produced by the web app.
///
/// The web writer sets the data-descriptor flag, which means **local file
/// headers carry zero for the CRC and both sizes**. The real values live only
/// in the central directory, so that is what this reads; a reader that trusts
/// the local header gets zero-length entries from every archive the web
/// produces. See `apps/web/src/migration/archive-export-browser-core.ts`.
final class NativeArchiveZipEngine {
  private let maxEntryBytes: Int64

  init(maxEntryBytes: Int64 = 512 * 1024 * 1024) {
    self.maxEntryBytes = maxEntryBytes
  }

  // MARK: - Index

  func openIndex(fileURL: URL) throws -> [NativeArchiveEntryIndex] {
    let handle = try FileHandle(forReadingFrom: fileURL)
    defer { try? handle.close() }

    let fileSize = Int64(try handle.seekToEnd())
    guard fileSize >= 22 else { throw NativeArchiveZipEngineError.notAZipFile }

    let tailLength = Int(min(fileSize, Int64(eocdSearchWindow)))
    try handle.seek(toOffset: UInt64(fileSize - Int64(tailLength)))
    let tail = try handle.read(upToCount: tailLength) ?? Data()

    guard let eocdOffset = lastIndex(of: Signature.endOfCentralDirectory, in: tail) else {
      throw NativeArchiveZipEngineError.notAZipFile
    }
    guard tail.count - eocdOffset >= 22 else { throw NativeArchiveZipEngineError.malformed("truncated EOCD") }

    let eocd = tail.subdata(in: (tail.startIndex + eocdOffset)..<tail.endIndex)
    let entryCount = Int(eocd.u16(10))
    let directorySize = Int(eocd.u32(12))
    let directoryOffset = eocd.u32(16)

    // Zip64 archives report these as all-ones and put the truth in a separate
    // record. The web writer never produces one, so rather than half-support
    // the format this refuses it by name.
    if directoryOffset == 0xFFFF_FFFF || eocd.u16(10) == 0xFFFF || directorySize == 0xFFFF_FFFF {
      throw NativeArchiveZipEngineError.unsupportedZip64
    }
    if lastIndex(of: Signature.zip64EndOfCentralDirectory, in: tail) != nil {
      throw NativeArchiveZipEngineError.unsupportedZip64
    }

    try handle.seek(toOffset: UInt64(directoryOffset))
    let directory = try handle.read(upToCount: directorySize) ?? Data()
    guard directory.count == directorySize else {
      throw NativeArchiveZipEngineError.malformed("truncated central directory")
    }

    var entries: [NativeArchiveEntryIndex] = []
    var cursor = 0

    for _ in 0..<entryCount {
      guard directory.count - cursor >= 46 else {
        throw NativeArchiveZipEngineError.malformed("truncated central directory entry")
      }
      let record = directory.subdata(in: (directory.startIndex + cursor)..<directory.endIndex)
      guard record.u32(0) == Signature.centralDirectoryHeader else {
        throw NativeArchiveZipEngineError.malformed("bad central directory signature")
      }

      let method = record.u16(10)
      let crc = record.u32(16)
      let compressedSize = record.u32(20)
      let uncompressedSize = record.u32(24)
      let nameLength = Int(record.u16(28))
      let extraLength = Int(record.u16(30))
      let commentLength = Int(record.u16(32))
      let localOffset = record.u32(42)

      if compressedSize == 0xFFFF_FFFF || uncompressedSize == 0xFFFF_FFFF || localOffset == 0xFFFF_FFFF {
        throw NativeArchiveZipEngineError.unsupportedZip64
      }

      let nameStart = record.startIndex + 46
      guard record.count >= 46 + nameLength else {
        throw NativeArchiveZipEngineError.malformed("truncated entry name")
      }
      let nameData = record.subdata(in: nameStart..<(nameStart + nameLength))
      guard let path = String(data: nameData, encoding: .utf8) else {
        throw NativeArchiveZipEngineError.malformed("entry name is not UTF-8")
      }

      try validate(path: path)
      if Int64(uncompressedSize) > maxEntryBytes {
        throw NativeArchiveZipEngineError.malformed("entry exceeds the per-entry limit: \(path)")
      }

      entries.append(
        NativeArchiveEntryIndex(
          path: path,
          uncompressedSize: Int64(uncompressedSize),
          compressedSize: Int64(compressedSize),
          method: method,
          crc32: crc,
          localHeaderOffset: UInt64(localOffset)
        )
      )

      cursor += 46 + nameLength + extraLength + commentLength
    }

    return entries
  }

  // MARK: - Extraction

  /// Writes one entry to `destinationURL`, verifying its CRC and declared size.
  ///
  /// Verification happens here rather than in the caller because a mismatch
  /// must not leave a plausible-looking file behind: the partial output is
  /// deleted before the error is thrown.
  func extract(entry: NativeArchiveEntryIndex, from fileURL: URL, to destinationURL: URL) throws {
    guard entry.method == 0 || entry.method == 8 else {
      throw NativeArchiveZipEngineError.unsupportedMethod(entry.method)
    }

    let handle = try FileHandle(forReadingFrom: fileURL)
    defer { try? handle.close() }

    try handle.seek(toOffset: entry.localHeaderOffset)
    guard let header = try handle.read(upToCount: 30), header.count == 30 else {
      throw NativeArchiveZipEngineError.malformed("truncated local header")
    }
    guard header.u32(0) == Signature.localFileHeader else {
      throw NativeArchiveZipEngineError.malformed("bad local header signature")
    }

    // Only the name and extra lengths are trustworthy here; the sizes are zero
    // whenever the data-descriptor flag is set, which the web writer always does.
    let dataOffset = entry.localHeaderOffset + 30 + UInt64(header.u16(26)) + UInt64(header.u16(28))
    try handle.seek(toOffset: dataOffset)

    FileManager.default.createFile(atPath: destinationURL.path, contents: nil)
    guard let output = try? FileHandle(forWritingTo: destinationURL) else {
      throw NativeArchiveZipEngineError.malformed("could not open destination")
    }

    var crc = Crc32()
    var written: Int64 = 0
    var failure: Error?

    do {
      if entry.method == 0 {
        var remaining = entry.compressedSize
        while remaining > 0 {
          let chunkSize = Int(min(remaining, 256 * 1024))
          guard let chunk = try handle.read(upToCount: chunkSize), !chunk.isEmpty else {
            throw NativeArchiveZipEngineError.malformed("truncated entry data: \(entry.path)")
          }
          crc.update(chunk)
          try output.write(contentsOf: chunk)
          written += Int64(chunk.count)
          remaining -= Int64(chunk.count)
        }
      } else {
        try inflate(from: handle, compressedSize: entry.compressedSize, path: entry.path) { chunk in
          crc.update(chunk)
          try output.write(contentsOf: chunk)
          written += Int64(chunk.count)
        }
      }

      if written != entry.uncompressedSize {
        throw NativeArchiveZipEngineError.sizeMismatch(
          path: entry.path, expected: entry.uncompressedSize, actual: written
        )
      }
      if crc.checksum != entry.crc32 {
        throw NativeArchiveZipEngineError.checksumMismatch(
          path: entry.path, expected: entry.crc32, actual: crc.checksum
        )
      }
    } catch {
      failure = error
    }

    try? output.close()
    if let failure {
      try? FileManager.default.removeItem(at: destinationURL)
      throw failure
    }
  }

  // MARK: - Internals

  /// Raw-deflate stream decode. `COMPRESSION_ZLIB` is Apple's raw DEFLATE,
  /// which is what `CompressionStream('deflate-raw')` on the web produces.
  private func inflate(
    from handle: FileHandle,
    compressedSize: Int64,
    path: String,
    emit: (Data) throws -> Void
  ) throws {
    let streamPointer = UnsafeMutablePointer<compression_stream>.allocate(capacity: 1)
    defer { streamPointer.deallocate() }

    guard compression_stream_init(streamPointer, COMPRESSION_STREAM_DECODE, COMPRESSION_ZLIB)
      == COMPRESSION_STATUS_OK else {
      throw NativeArchiveZipEngineError.malformed("could not start the decoder")
    }
    defer { compression_stream_destroy(streamPointer) }

    let outputCapacity = 256 * 1024
    let outputBuffer = UnsafeMutablePointer<UInt8>.allocate(capacity: outputCapacity)
    defer { outputBuffer.deallocate() }

    var remaining = compressedSize
    var input = Data()
    var finished = false

    streamPointer.pointee.dst_ptr = outputBuffer
    streamPointer.pointee.dst_size = outputCapacity

    while !finished {
      if streamPointer.pointee.src_size == 0 && remaining > 0 {
        let chunkSize = Int(min(remaining, 256 * 1024))
        guard let chunk = try handle.read(upToCount: chunkSize), !chunk.isEmpty else {
          throw NativeArchiveZipEngineError.malformed("truncated entry data: \(path)")
        }
        input = chunk
        remaining -= Int64(chunk.count)
      }

      let status: compression_status = try input.withUnsafeBytes { raw -> compression_status in
        if streamPointer.pointee.src_size == 0, let base = raw.bindMemory(to: UInt8.self).baseAddress {
          streamPointer.pointee.src_ptr = base
          streamPointer.pointee.src_size = raw.count
        }
        let flags = remaining == 0 ? Int32(COMPRESSION_STREAM_FINALIZE.rawValue) : 0
        return compression_stream_process(streamPointer, flags)
      }

      switch status {
      case COMPRESSION_STATUS_OK, COMPRESSION_STATUS_END:
        let produced = outputCapacity - streamPointer.pointee.dst_size
        if produced > 0 {
          try emit(Data(bytes: outputBuffer, count: produced))
          streamPointer.pointee.dst_ptr = outputBuffer
          streamPointer.pointee.dst_size = outputCapacity
        }
        if status == COMPRESSION_STATUS_END { finished = true }
        if status == COMPRESSION_STATUS_OK && produced == 0 && remaining == 0
          && streamPointer.pointee.src_size == 0 {
          finished = true
        }
      default:
        throw NativeArchiveZipEngineError.malformed("corrupt deflate stream: \(path)")
      }
    }
  }

  /// Import requirement 2: no absolute paths, no traversal.
  private func validate(path: String) throws {
    if path.isEmpty { throw NativeArchiveZipEngineError.unsafePath(path) }
    if path.hasPrefix("/") { throw NativeArchiveZipEngineError.unsafePath(path) }
    // A backslash is a separator on the writer's side, so it cannot be treated
    // as an ordinary character in a name.
    if path.contains("\\") { throw NativeArchiveZipEngineError.unsafePath(path) }
    // A Windows drive letter is absolute even though it does not start with "/".
    if path.count >= 2, path[path.index(path.startIndex, offsetBy: 1)] == ":" {
      throw NativeArchiveZipEngineError.unsafePath(path)
    }
    for component in path.split(separator: "/", omittingEmptySubsequences: false) {
      if component == ".." { throw NativeArchiveZipEngineError.unsafePath(path) }
    }
  }

  private func lastIndex(of signature: UInt32, in data: Data) -> Int? {
    guard data.count >= 4 else { return nil }
    var index = data.count - 4
    while index >= 0 {
      if data.u32(index) == signature { return index }
      index -= 1
    }
    return nil
  }
}
