import Compression
import XCTest

@testable internal import kvitto_native

/// Builds ZIPs the way `apps/web/src/migration/archive-export-browser-core.ts`
/// does, so these tests fail if the reader stops matching the writer it has to
/// interoperate with.
private struct TestZipBuilder {
    private struct Entry {
        let path: String
        let crc: UInt32
        let compressedSize: UInt32
        let uncompressedSize: UInt32
        let offset: UInt32
        let method: UInt16
        let useDataDescriptor: Bool
    }

    private var payload = Data()
    private var entries: [Entry] = []

    /// The web writer always sets the data-descriptor flag, which zeroes the
    /// sizes in the local header. That default is the interop case.
    mutating func add(path: String, bytes: Data, method: UInt16 = 8, useDataDescriptor: Bool = true) {
        let offset = UInt32(payload.count)
        let crc = Self.crc32(bytes)
        let body = method == 8 ? Self.deflate(bytes) : bytes

        var local = Data()
        local.append(u32: 0x0403_4B50)
        local.append(u16: 20)
        local.append(u16: useDataDescriptor ? (0x0800 | 0x0008) : 0x0800)
        local.append(u16: method)
        local.append(u16: 0)
        local.append(u16: 0)
        // Zeroed when a data descriptor follows; this is the trap for readers
        // that trust the local header.
        local.append(u32: useDataDescriptor ? 0 : crc)
        local.append(u32: useDataDescriptor ? 0 : UInt32(body.count))
        local.append(u32: useDataDescriptor ? 0 : UInt32(bytes.count))
        let nameBytes = Data(path.utf8)
        local.append(u16: UInt16(nameBytes.count))
        local.append(u16: 0)
        local.append(nameBytes)

        payload.append(local)
        payload.append(body)

        if useDataDescriptor {
            var descriptor = Data()
            descriptor.append(u32: 0x0807_4B50)
            descriptor.append(u32: crc)
            descriptor.append(u32: UInt32(body.count))
            descriptor.append(u32: UInt32(bytes.count))
            payload.append(descriptor)
        }

        entries.append(
            Entry(
                path: path,
                crc: crc,
                compressedSize: UInt32(body.count),
                uncompressedSize: UInt32(bytes.count),
                offset: offset,
                method: method,
                useDataDescriptor: useDataDescriptor
            )
        )
    }

    func build() -> Data {
        var output = payload
        let directoryOffset = UInt32(output.count)
        var directory = Data()

        for entry in entries {
            directory.append(u32: 0x0201_4B50)
            directory.append(u16: 20)
            directory.append(u16: 20)
            directory.append(u16: entry.useDataDescriptor ? (0x0800 | 0x0008) : 0x0800)
            directory.append(u16: entry.method)
            directory.append(u16: 0)
            directory.append(u16: 0)
            directory.append(u32: entry.crc)
            directory.append(u32: entry.compressedSize)
            directory.append(u32: entry.uncompressedSize)
            let nameBytes = Data(entry.path.utf8)
            directory.append(u16: UInt16(nameBytes.count))
            directory.append(u16: 0)
            directory.append(u16: 0)
            directory.append(u16: 0)
            directory.append(u16: 0)
            directory.append(u32: 0)
            directory.append(u32: entry.offset)
            directory.append(nameBytes)
        }

        output.append(directory)
        output.append(u32: 0x0605_4B50)
        output.append(u16: 0)
        output.append(u16: 0)
        output.append(u16: UInt16(entries.count))
        output.append(u16: UInt16(entries.count))
        output.append(u32: UInt32(directory.count))
        output.append(u32: directoryOffset)
        output.append(u16: 0)
        return output
    }

    static func deflate(_ data: Data) -> Data {
        if data.isEmpty { return Data([0x03, 0x00]) }
        let capacity = data.count + 64 * 1024
        let destination = UnsafeMutablePointer<UInt8>.allocate(capacity: capacity)
        defer { destination.deallocate() }
        let written = data.withUnsafeBytes { raw -> Int in
            compression_encode_buffer(
                destination, capacity,
                raw.bindMemory(to: UInt8.self).baseAddress!, data.count,
                nil, COMPRESSION_ZLIB
            )
        }
        return Data(bytes: destination, count: written)
    }

    static func crc32(_ data: Data) -> UInt32 {
        var table = [UInt32](repeating: 0, count: 256)
        for index in 0..<256 {
            var value = UInt32(index)
            for _ in 0..<8 {
                value = (value & 1) == 1 ? (0xEDB8_8320 ^ (value >> 1)) : (value >> 1)
            }
            table[index] = value
        }
        var crc: UInt32 = 0xFFFF_FFFF
        for byte in data {
            crc = table[Int((crc ^ UInt32(byte)) & 0xFF)] ^ (crc >> 8)
        }
        return crc ^ 0xFFFF_FFFF
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

final class KvittoNativeArchiveZipTests: XCTestCase {
    private var directory: URL!

    override func setUpWithError() throws {
        directory = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: directory)
    }

    private func write(_ data: Data, named name: String = "archive.kvitto") throws -> URL {
        let url = directory.appendingPathComponent(name)
        try data.write(to: url)
        return url
    }

    func testReadsIndexFromCentralDirectoryWhenLocalHeadersAreZeroed() throws {
        var builder = TestZipBuilder()
        let manifest = Data(#"{"version":1}"#.utf8)
        builder.add(path: "manifest.json", bytes: manifest)
        let url = try write(builder.build())

        let entries = try NativeArchiveZipEngine().openIndex(fileURL: url)

        XCTAssertEqual(entries.count, 1)
        let entry = try XCTUnwrap(entries.first)
        XCTAssertEqual(entry.path, "manifest.json")
        // The local header says zero; only the central directory is truthful.
        XCTAssertEqual(entry.uncompressedSize, Int64(manifest.count))
        XCTAssertEqual(entry.method, 8)
    }

    func testRoundTripsDeflatedContent() throws {
        var builder = TestZipBuilder()
        let ndjson = Data(
            (0..<500).map { "{\"id\":\"receipt-\($0)\"}" }.joined(separator: "\n").utf8
        )
        builder.add(path: "entities/receipts.ndjson", bytes: ndjson)
        let url = try write(builder.build())

        let engine = NativeArchiveZipEngine()
        let entry = try XCTUnwrap(try engine.openIndex(fileURL: url).first)
        let destination = directory.appendingPathComponent("out.ndjson")
        try engine.extract(entry: entry, from: url, to: destination)

        XCTAssertEqual(try Data(contentsOf: destination), ndjson)
    }

    func testRoundTripsStoredContent() throws {
        var builder = TestZipBuilder()
        let blob = Data((0..<4096).map { UInt8($0 % 251) })
        builder.add(path: "blobs/abc123", bytes: blob, method: 0)
        let url = try write(builder.build())

        let engine = NativeArchiveZipEngine()
        let entry = try XCTUnwrap(try engine.openIndex(fileURL: url).first)
        XCTAssertEqual(entry.method, 0)
        let destination = directory.appendingPathComponent("blob.bin")
        try engine.extract(entry: entry, from: url, to: destination)

        XCTAssertEqual(try Data(contentsOf: destination), blob)
    }

    func testRoundTripsEmptyEntry() throws {
        var builder = TestZipBuilder()
        builder.add(path: "entities/tags.ndjson", bytes: Data())
        let url = try write(builder.build())

        let engine = NativeArchiveZipEngine()
        let entry = try XCTUnwrap(try engine.openIndex(fileURL: url).first)
        let destination = directory.appendingPathComponent("empty.ndjson")
        try engine.extract(entry: entry, from: url, to: destination)

        XCTAssertEqual(try Data(contentsOf: destination).count, 0)
    }

    func testReadsSeveralEntriesInOrder() throws {
        var builder = TestZipBuilder()
        builder.add(path: "manifest.json", bytes: Data(#"{"version":1}"#.utf8))
        builder.add(path: "entities/receipts.ndjson", bytes: Data("{}".utf8))
        builder.add(path: "blobs/deadbeef", bytes: Data(repeating: 7, count: 1024), method: 0)
        let url = try write(builder.build())

        let entries = try NativeArchiveZipEngine().openIndex(fileURL: url)

        XCTAssertEqual(entries.map(\.path), ["manifest.json", "entities/receipts.ndjson", "blobs/deadbeef"])
    }

    func testRejectsPathTraversal() throws {
        var builder = TestZipBuilder()
        builder.add(path: "../../etc/passwd", bytes: Data("nope".utf8))
        let url = try write(builder.build())

        XCTAssertThrowsError(try NativeArchiveZipEngine().openIndex(fileURL: url)) { error in
            XCTAssertEqual(error as? NativeArchiveZipEngineError, .unsafePath("../../etc/passwd"))
        }
    }

    func testRejectsAbsolutePath() throws {
        var builder = TestZipBuilder()
        builder.add(path: "/etc/passwd", bytes: Data("nope".utf8))
        let url = try write(builder.build())

        XCTAssertThrowsError(try NativeArchiveZipEngine().openIndex(fileURL: url))
    }

    func testRejectsBackslashSeparators() throws {
        var builder = TestZipBuilder()
        builder.add(path: "blobs\\..\\..\\escape", bytes: Data("nope".utf8))
        let url = try write(builder.build())

        XCTAssertThrowsError(try NativeArchiveZipEngine().openIndex(fileURL: url))
    }

    func testRejectsCorruptedContentByChecksum() throws {
        var builder = TestZipBuilder()
        let blob = Data(repeating: 0xAB, count: 2048)
        builder.add(path: "blobs/corrupt", bytes: blob, method: 0)
        var bytes = builder.build()

        // Flip a byte inside the stored payload, leaving every header intact.
        bytes[60] = bytes[60] ^ 0xFF
        let url = try write(bytes)

        let engine = NativeArchiveZipEngine()
        let entry = try XCTUnwrap(try engine.openIndex(fileURL: url).first)
        let destination = directory.appendingPathComponent("corrupt.bin")

        XCTAssertThrowsError(try engine.extract(entry: entry, from: url, to: destination))
        // A failed extraction must not leave a plausible-looking file behind.
        XCTAssertFalse(FileManager.default.fileExists(atPath: destination.path))
    }

    func testRejectsNonZipFile() throws {
        let url = try write(Data("this is not a zip".utf8))
        XCTAssertThrowsError(try NativeArchiveZipEngine().openIndex(fileURL: url)) { error in
            XCTAssertEqual(error as? NativeArchiveZipEngineError, .notAZipFile)
        }
    }

    func testRejectsUnsupportedCompressionMethod() throws {
        var builder = TestZipBuilder()
        // Method 12 is bzip2: a legal ZIP method this reader does not implement.
        builder.add(path: "weird.bin", bytes: Data("x".utf8), method: 12)
        let url = try write(builder.build())

        let engine = NativeArchiveZipEngine()
        let entry = try XCTUnwrap(try engine.openIndex(fileURL: url).first)
        XCTAssertThrowsError(
            try engine.extract(entry: entry, from: url, to: directory.appendingPathComponent("x.bin"))
        ) { error in
            XCTAssertEqual(error as? NativeArchiveZipEngineError, .unsupportedMethod(12))
        }
    }

    func testEnforcesPerEntryLimit() throws {
        var builder = TestZipBuilder()
        builder.add(path: "big.bin", bytes: Data(repeating: 1, count: 4096), method: 0)
        let url = try write(builder.build())

        let engine = NativeArchiveZipEngine(maxEntryBytes: 1024)
        XCTAssertThrowsError(try engine.openIndex(fileURL: url))
    }
}

/// The writer is checked against the reader, because a round trip through the
/// two is the only evidence that matters: an archive this app produces has to
/// be one it would accept, and the reader is already covered against the real
/// web writer's byte layout.
final class KvittoNativeArchiveZipWriterTests: XCTestCase {
    private var directory: URL!

    override func setUpWithError() throws {
        directory = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: directory)
    }

    private func source(_ name: String, _ data: Data) throws -> URL {
        let url = directory.appendingPathComponent(name)
        try data.write(to: url)
        return url
    }

    func testRoundTripsThroughItsOwnReader() throws {
        let manifest = Data(#"{"version":1}"#.utf8)
        let ndjson = Data((0..<300).map { "{\"id\":\"r-\($0)\"}" }.joined(separator: "\n").utf8)
        let blob = Data((0..<20_000).map { UInt8($0 % 251) })

        let entries = [
            NativeArchiveWriteEntry(path: "manifest.json", sourceURL: try source("m.json", manifest)),
            NativeArchiveWriteEntry(path: "entities/receipts.ndjson", sourceURL: try source("r.ndjson", ndjson)),
            NativeArchiveWriteEntry(path: "blobs/abc", sourceURL: try source("b.bin", blob)),
        ]
        let archive = directory.appendingPathComponent("out.kvitto")

        try NativeArchiveZipWriter().write(entries: entries, to: archive)

        let engine = NativeArchiveZipEngine()
        let index = try engine.openIndex(fileURL: archive)
        XCTAssertEqual(index.map(\.path), ["manifest.json", "entities/receipts.ndjson", "blobs/abc"])

        for (entry, expected) in zip(index, [manifest, ndjson, blob]) {
            XCTAssertEqual(entry.uncompressedSize, Int64(expected.count))
            let destination = directory.appendingPathComponent("extracted-\(entry.uncompressedSize)")
            try engine.extract(entry: entry, from: archive, to: destination)
            XCTAssertEqual(try Data(contentsOf: destination), expected)
        }
    }

    func testWritesSizesIntoLocalHeadersRatherThanDataDescriptors() throws {
        let payload = Data("hello".utf8)
        let archive = directory.appendingPathComponent("out.kvitto")
        try NativeArchiveZipWriter().write(
            entries: [NativeArchiveWriteEntry(path: "a.txt", sourceURL: try source("a.txt", payload))],
            to: archive
        )

        let bytes = try Data(contentsOf: archive)
        // Local header: flags at 6, uncompressed size at 22.
        let flags = UInt16(bytes[6]) | (UInt16(bytes[7]) << 8)
        XCTAssertEqual(flags & 0x0008, 0, "the writer should not set the data-descriptor flag")

        var uncompressed: UInt32 = 0
        for offset in (22..<26).reversed() {
            uncompressed = (uncompressed << 8) | UInt32(bytes[offset])
        }
        XCTAssertEqual(uncompressed, UInt32(payload.count))
    }

    func testRoundTripsAnEmptyEntry() throws {
        let archive = directory.appendingPathComponent("out.kvitto")
        try NativeArchiveZipWriter().write(
            entries: [NativeArchiveWriteEntry(path: "entities/tags.ndjson", sourceURL: try source("t", Data()))],
            to: archive
        )

        let engine = NativeArchiveZipEngine()
        let entry = try XCTUnwrap(try engine.openIndex(fileURL: archive).first)
        XCTAssertEqual(entry.uncompressedSize, 0)
        let destination = directory.appendingPathComponent("empty")
        try engine.extract(entry: entry, from: archive, to: destination)
        XCTAssertEqual(try Data(contentsOf: destination).count, 0)
    }

    func testRefusesUnsafePathsOnTheWayOut() throws {
        let archive = directory.appendingPathComponent("out.kvitto")
        let payload = try source("p", Data("x".utf8))

        for path in ["../escape", "/absolute", "blobs\\win", "C:/drive"] {
            XCTAssertThrowsError(
                try NativeArchiveZipWriter().write(
                    entries: [NativeArchiveWriteEntry(path: path, sourceURL: payload)],
                    to: archive
                ),
                "should refuse \(path)"
            )
        }
    }

    func testRefusesDuplicatePaths() throws {
        let payload = try source("p", Data("x".utf8))
        XCTAssertThrowsError(
            try NativeArchiveZipWriter().write(
                entries: [
                    NativeArchiveWriteEntry(path: "a.txt", sourceURL: payload),
                    NativeArchiveWriteEntry(path: "a.txt", sourceURL: payload),
                ],
                to: directory.appendingPathComponent("out.kvitto")
            )
        ) { error in
            XCTAssertEqual(error as? NativeArchiveZipWriterError, .duplicatePath("a.txt"))
        }
    }

    func testLeavesNoPartialArchiveWhenAnEntryIsMissing() throws {
        let archive = directory.appendingPathComponent("out.kvitto")
        let good = try source("good", Data("ok".utf8))

        XCTAssertThrowsError(
            try NativeArchiveZipWriter().write(
                entries: [
                    NativeArchiveWriteEntry(path: "a.txt", sourceURL: good),
                    NativeArchiveWriteEntry(
                        path: "b.txt",
                        sourceURL: directory.appendingPathComponent("does-not-exist")
                    ),
                ],
                to: archive
            )
        )

        // A truncated archive looks complete to most readers, so a failed
        // export must not leave one behind.
        XCTAssertFalse(FileManager.default.fileExists(atPath: archive.path))
    }

    func testWritesAnArchiveWithNoEntries() throws {
        let archive = directory.appendingPathComponent("empty.kvitto")
        try NativeArchiveZipWriter().write(entries: [], to: archive)

        XCTAssertEqual(try NativeArchiveZipEngine().openIndex(fileURL: archive).count, 0)
    }
}
