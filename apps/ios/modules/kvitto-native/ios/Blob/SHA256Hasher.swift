import Foundation
import CryptoKit

enum SHA256HasherError: Error {
  case cannotOpenStream
  case readFailed
}

struct SHA256Hasher {
  private static let chunkSize = 64 * 1024

  static func hashFile(at url: URL) throws -> String {
    guard let stream = InputStream(url: url) else {
      throw SHA256HasherError.cannotOpenStream
    }

    stream.open()
    defer {
      stream.close()
    }

    var hasher = SHA256()
    let buffer = UnsafeMutablePointer<UInt8>.allocate(capacity: chunkSize)
    defer {
      buffer.deallocate()
    }

    while stream.hasBytesAvailable {
      let read = stream.read(buffer, maxLength: chunkSize)
      if read < 0 {
        throw SHA256HasherError.readFailed
      }
      if read == 0 {
        break
      }
      hasher.update(bufferPointer: UnsafeRawBufferPointer(start: buffer, count: read))
    }

    let digest = hasher.finalize()
    return digest.map { String(format: "%02x", $0) }.joined()
  }
}
