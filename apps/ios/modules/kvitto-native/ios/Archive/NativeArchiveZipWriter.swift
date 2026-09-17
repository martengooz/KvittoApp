import Compression
import Foundation

struct NativeArchiveWriteEntry {
  let path: String
  /// File whose contents become the entry body.
  let sourceURL: URL
}

enum NativeArchiveZipWriterError: Error, Equatable {
  case unsafePath(String)
  case duplicatePath(String)
  case sourceMissing(String)
  case writeFailed(String)
}

/**
 Writes `.kvitto` archives.

 Unlike the reader, this does **not** use data descriptors: it knows each
 entry's size and CRC once the entry is written, and seeking back to patch the
 local header is cheap on a local file. Writing the sizes into the local header
 directly means the result is readable by the widest range of tools, including
 ones that ignore the central directory.

 Entries are deflated in streaming chunks, so exporting a thousand receipt
 images never holds more than one chunk of one image in memory.
 */
final class NativeArchiveZipWriter {
  private let chunkBytes: Int

  init(chunkBytes: Int = 256 * 1024) {
    self.chunkBytes = chunkBytes
  }

  func write(entries: [NativeArchiveWriteEntry], to destinationURL: URL) throws {
    var seen = Set<String>()
    for entry in entries {
      try validate(path: entry.path)
      guard seen.insert(entry.path).inserted else {
        throw NativeArchiveZipWriterError.duplicatePath(entry.path)
      }
      guard FileManager.default.fileExists(atPath: entry.sourceURL.path) else {
        throw NativeArchiveZipWriterError.sourceMissing(entry.path)
      }
    }

    FileManager.default.createFile(atPath: destinationURL.path, contents: nil)
    guard let output = try? FileHandle(forWritingTo: destinationURL) else {
      throw NativeArchiveZipWriterError.writeFailed("could not open \(destinationURL.lastPathComponent)")
    }

    var directory = Data()
    var count: UInt16 = 0
    var failure: Error?

    do {
      for entry in entries {
        let offset = try output.offset()
        let nameBytes = Data(entry.path.utf8)

        // Placeholder header; the sizes and CRC are patched in once known.
        var header = Data()
        header.append(u32: 0x0403_4B50)
        header.append(u16: 20)
        header.append(u16: 0x0800)
        header.append(u16: 8)
        header.append(u16: 0)
        header.append(u16: 0)
        header.append(u32: 0)
        header.append(u32: 0)
        header.append(u32: 0)
        header.append(u16: UInt16(nameBytes.count))
        header.append(u16: 0)
        try output.write(contentsOf: header)
        try output.write(contentsOf: nameBytes)

        let result = try deflateFile(at: entry.sourceURL, into: output)

        let afterData = try output.offset()
        try output.seek(toOffset: offset + 14)
        var patch = Data()
        patch.append(u32: result.crc)
        patch.append(u32: UInt32(result.compressedSize))
        patch.append(u32: UInt32(result.uncompressedSize))
        try output.write(contentsOf: patch)
        try output.seek(toOffset: afterData)

        directory.append(u32: 0x0201_4B50)
        directory.append(u16: 20)
        directory.append(u16: 20)
        directory.append(u16: 0x0800)
        directory.append(u16: 8)
        directory.append(u16: 0)
        directory.append(u16: 0)
        directory.append(u32: result.crc)
        directory.append(u32: UInt32(result.compressedSize))
        directory.append(u32: UInt32(result.uncompressedSize))
        directory.append(u16: UInt16(nameBytes.count))
        directory.append(u16: 0)
        directory.append(u16: 0)
        directory.append(u16: 0)
        directory.append(u16: 0)
        directory.append(u32: 0)
        directory.append(u32: UInt32(offset))
        directory.append(nameBytes)

        count += 1
      }

      let directoryOffset = try output.offset()
      try output.write(contentsOf: directory)

      var eocd = Data()
      eocd.append(u32: 0x0605_4B50)
      eocd.append(u16: 0)
      eocd.append(u16: 0)
      eocd.append(u16: count)
      eocd.append(u16: count)
      eocd.append(u32: UInt32(directory.count))
      eocd.append(u32: UInt32(directoryOffset))
      eocd.append(u16: 0)
      try output.write(contentsOf: eocd)
    } catch {
      failure = error
    }

    try? output.close()
    if let failure {
      // A partial archive is indistinguishable from a complete one to most
      // readers, so it must not survive a failed export.
      try? FileManager.default.removeItem(at: destinationURL)
      throw failure
    }
  }

  // MARK: - Internals

  private struct DeflateResult {
    let crc: UInt32
    let compressedSize: Int64
    let uncompressedSize: Int64
  }

  private func deflateFile(at sourceURL: URL, into output: FileHandle) throws -> DeflateResult {
    let input = try FileHandle(forReadingFrom: sourceURL)
    defer { try? input.close() }

    let streamPointer = UnsafeMutablePointer<compression_stream>.allocate(capacity: 1)
    defer { streamPointer.deallocate() }
    guard compression_stream_init(streamPointer, COMPRESSION_STREAM_ENCODE, COMPRESSION_ZLIB)
      == COMPRESSION_STATUS_OK else {
      throw NativeArchiveZipWriterError.writeFailed("could not start the encoder")
    }
    defer { compression_stream_destroy(streamPointer) }

    let outputBuffer = UnsafeMutablePointer<UInt8>.allocate(capacity: chunkBytes)
    defer { outputBuffer.deallocate() }
    streamPointer.pointee.dst_ptr = outputBuffer
    streamPointer.pointee.dst_size = chunkBytes

    var crc = Crc32()
    var uncompressed: Int64 = 0
    var compressed: Int64 = 0
    var sourceExhausted = false
    var pending = Data()

    while true {
      if streamPointer.pointee.src_size == 0 && !sourceExhausted {
        if let chunk = try input.read(upToCount: chunkBytes), !chunk.isEmpty {
          crc.update(chunk)
          uncompressed += Int64(chunk.count)
          pending = chunk
        } else {
          sourceExhausted = true
          pending = Data()
        }
      }

      let status: compression_status = pending.withUnsafeBytes { raw -> compression_status in
        if streamPointer.pointee.src_size == 0, let base = raw.bindMemory(to: UInt8.self).baseAddress {
          streamPointer.pointee.src_ptr = base
          streamPointer.pointee.src_size = raw.count
        }
        let flags = sourceExhausted ? Int32(COMPRESSION_STREAM_FINALIZE.rawValue) : 0
        return compression_stream_process(streamPointer, flags)
      }

      guard status == COMPRESSION_STATUS_OK || status == COMPRESSION_STATUS_END else {
        throw NativeArchiveZipWriterError.writeFailed("deflate failed for \(sourceURL.lastPathComponent)")
      }

      let produced = chunkBytes - streamPointer.pointee.dst_size
      if produced > 0 {
        try output.write(contentsOf: Data(bytes: outputBuffer, count: produced))
        compressed += Int64(produced)
        streamPointer.pointee.dst_ptr = outputBuffer
        streamPointer.pointee.dst_size = chunkBytes
      }

      if status == COMPRESSION_STATUS_END { break }
    }

    return DeflateResult(crc: crc.checksum, compressedSize: compressed, uncompressedSize: uncompressed)
  }

  /// The same rules the reader enforces, applied on the way out: an archive
  /// this app produces must be one it would accept.
  private func validate(path: String) throws {
    if path.isEmpty || path.hasPrefix("/") || path.contains("\\") {
      throw NativeArchiveZipWriterError.unsafePath(path)
    }
    if path.count >= 2, path[path.index(path.startIndex, offsetBy: 1)] == ":" {
      throw NativeArchiveZipWriterError.unsafePath(path)
    }
    for component in path.split(separator: "/", omittingEmptySubsequences: false) {
      if component == ".." { throw NativeArchiveZipWriterError.unsafePath(path) }
    }
  }
}

private extension Data {
  mutating func append(u16 value: UInt16) {
    append(contentsOf: [UInt8(value & 0xFF), UInt8((value >> 8) & 0xFF)])
  }

  mutating func append(u32 value: UInt32) {
    append(contentsOf: [
      UInt8(value & 0xFF),
      UInt8((value >> 8) & 0xFF),
      UInt8((value >> 16) & 0xFF),
      UInt8((value >> 24) & 0xFF),
    ])
  }
}
