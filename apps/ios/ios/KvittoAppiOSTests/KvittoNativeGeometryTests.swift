import XCTest
import CoreGraphics

@testable internal import kvitto_native

final class KvittoNativeGeometryTests: XCTestCase {
  func testVisionRectToNormalizedQuadMapping() throws {
    let quad = NormalizedQuad.fromVisionRect(CGRect(x: 0.1, y: 0.2, width: 0.7, height: 0.5))
    XCTAssertEqual(quad.topLeft.x, 0.1, accuracy: 0.0001)
    XCTAssertEqual(quad.topLeft.y, 0.7, accuracy: 0.0001)
    XCTAssertEqual(quad.bottomRight.x, 0.8, accuracy: 0.0001)
    XCTAssertEqual(quad.bottomRight.y, 0.2, accuracy: 0.0001)
  }

  func testFrameAdapterExplicitlyReportsUnavailablePlugin() throws {
    let adapter = VisionFrameAnalysisAdapter()
    let result = adapter.analyzeCompactFrame(frameTimestampMs: 0)
    XCTAssertEqual(result.status, "unsupported")
    XCTAssertFalse(result.pluginLinked)
    XCTAssertEqual(result.source, "stub")
  }
}
