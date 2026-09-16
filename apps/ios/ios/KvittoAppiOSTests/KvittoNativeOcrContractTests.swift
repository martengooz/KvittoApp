import XCTest
import CoreImage

@testable internal import kvitto_native

final class KvittoNativeOcrContractTests: XCTestCase {
  func testCancellationContractMarksOperation() async throws {
    let registry = CancellationRegistry()
    await registry.cancel("ocr-job-1")
    let cancelled = await registry.isCancelled("ocr-job-1")
    XCTAssertTrue(cancelled)
  }

  func testFallbackLanguageContractIncludesEnglish() throws {
    let recognizer = VisionTextRecognizer()
    let supported = recognizer.supportedLanguages()
    XCTAssertTrue(supported.contains("en-US"))
  }

  func testProcessReceiptImageFallsBackToFullFrameForSolidImage() throws {
    let fixtureRoot = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
    try FileManager.default.createDirectory(at: fixtureRoot, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: fixtureRoot) }

    let sourceURL = fixtureRoot.appendingPathComponent("solid.jpeg")
    let outputURL = fixtureRoot.appendingPathComponent("processed.jpeg")
    let thumbURL = fixtureRoot.appendingPathComponent("thumb.jpeg")

    let solidImage = CIImage(color: CIColor(red: 1.0, green: 1.0, blue: 1.0)).cropped(to: CGRect(x: 0, y: 0, width: 128, height: 96))
    let context = CIContext()
    let jpeg = try XCTUnwrap(
      context.jpegRepresentation(
        of: solidImage,
        colorSpace: CGColorSpaceCreateDeviceRGB(),
        options: [kCGImageDestinationLossyCompressionQuality as CIImageRepresentationOption: 0.8]
      )
    )
    try jpeg.write(to: sourceURL, options: .atomic)

    let processor = ReceiptImageProcessor()
    let result = try processor.process(
      sourceURL: sourceURL,
      outputURL: outputURL,
      thumbnailURL: thumbURL,
      maxLongEdge: 2048,
      jpegQuality: 0.85,
      enhancement: "none",
      forcedQuad: nil
    )

    XCTAssertTrue(result.fallbackUsed)
    XCTAssertEqual(result.detectionSource, "fallback-full-frame")
    XCTAssertNil(result.rectangle)
    XCTAssertTrue(FileManager.default.fileExists(atPath: outputURL.path))
    XCTAssertTrue(FileManager.default.fileExists(atPath: thumbURL.path))
  }

  func testRecognizeTextPreferredLanguageFallsBackToEnglishUsingFixture() throws {
    guard let fixtureURL = findReceiptFixtureURL() else {
      throw XCTSkip("No receipt fixture found in repository checkout")
    }

    let recognizer = VisionTextRecognizer()
    let result = try recognizer.recognize(sourceURL: fixtureURL, preferredLanguages: ["zz-ZZ"])

    XCTAssertTrue(result.usedLanguages.contains("en-US"))
    XCTAssertGreaterThanOrEqual(result.durationMs, 0)
  }

  private func findReceiptFixtureURL() -> URL? {
    let sourcePath = URL(fileURLWithPath: #filePath)
    var cursor = sourcePath.deletingLastPathComponent()
    let manager = FileManager.default

    while cursor.path != "/" {
      let fixturesDir = cursor.appendingPathComponent("fixtures/receipts", isDirectory: true)
      if let entries = try? manager.contentsOfDirectory(at: fixturesDir, includingPropertiesForKeys: nil),
         let firstImage = entries.first(where: { ["jpeg", "jpg", "png"].contains($0.pathExtension.lowercased()) }) {
        return firstImage
      }
      cursor.deleteLastPathComponent()
    }

    return nil
  }
}
