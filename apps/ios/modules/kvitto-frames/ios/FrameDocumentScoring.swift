import CoreGraphics
import Foundation
import Vision

/**
 The judgement inside the live document detector, with nothing native attached.

 It is a separate, dependency-free file for one practical reason: the hybrid
 object it serves is compiled with Nitro's C++ interop, and the app's XCTest
 target cannot import a module built that way - `NitroModules`' headers need
 Objective-C++ and the test target is Objective-C. This file is compiled into
 the test target directly instead, so the rules that decide whether to fire the
 shutter are covered without a device.
 */
enum FrameDocumentScoring {
  /// How much one observation argues a receipt is squarely in frame.
  ///
  /// Vision's own confidence says "this is a quadrilateral", which a table
  /// edge or a laptop lid satisfies just as well as a receipt. The two extra
  /// terms are what separate them:
  ///
  /// - **Coverage** rejects both a receipt too far away to read and a frame
  ///   filled edge to edge, where the paper is almost certainly clipped.
  /// - **Squareness** compares opposite sides. A real rectangle seen at a
  ///   moderate angle keeps them close to equal; a shape whose opposite sides
  ///   differ wildly is either badly skewed or not a rectangle at all.
  static func score(for observation: VNRectangleObservation) -> (evidence: Double, coverage: Double) {
    let topLeft = observation.topLeft
    let topRight = observation.topRight
    let bottomRight = observation.bottomRight
    let bottomLeft = observation.bottomLeft

    let coverage = polygonArea([topLeft, topRight, bottomRight, bottomLeft])
    let coverageScore = rampedCoverage(coverage)

    let horizontal = ratio(distance(topLeft, topRight), distance(bottomLeft, bottomRight))
    let vertical = ratio(distance(topLeft, bottomLeft), distance(topRight, bottomRight))
    let squareness = min(horizontal, vertical)

    let confidence = Double(observation.confidence)
    return (evidence: confidence * coverageScore * squareness, coverage: coverage)
  }

  /// 0 below a floor, 1 across the useful band, falling again once the quad
  /// fills the frame - at which point the paper's edges are probably outside it.
  static func rampedCoverage(_ coverage: Double) -> Double {
    if coverage < 0.10 { return 0 }
    if coverage < 0.25 { return (coverage - 0.10) / 0.15 }
    if coverage <= 0.88 { return 1 }
    if coverage >= 0.98 { return 0 }
    return (0.98 - coverage) / 0.10
  }

  /// Maps VisionCamera's `Frame.orientation` onto Vision's expectation.
  ///
  /// VisionCamera reports how far the buffer is rotated from upright, and
  /// `CGImagePropertyOrientation` says how to get it back - the two use the
  /// same names for the same rotation, so this is a direct mapping rather
  /// than an inversion.
  static func cgOrientation(degrees: Double, isMirrored: Bool) -> CGImagePropertyOrientation {
    let normalized = ((Int(degrees.rounded()) % 360) + 360) % 360
    switch normalized {
    case 90:
      return isMirrored ? .rightMirrored : .right
    case 180:
      return isMirrored ? .downMirrored : .down
    case 270:
      return isMirrored ? .leftMirrored : .left
    default:
      return isMirrored ? .upMirrored : .up
    }
  }

  private static func ratio(_ a: Double, _ b: Double) -> Double {
    let larger = max(a, b)
    guard larger > 0 else { return 0 }
    return min(a, b) / larger
  }

  private static func distance(_ a: CGPoint, _ b: CGPoint) -> Double {
    let dx = Double(a.x - b.x)
    let dy = Double(a.y - b.y)
    return (dx * dx + dy * dy).squareRoot()
  }

  /// Shoelace formula. The points are already normalized, so this is the
  /// fraction of the frame the quad covers.
  private static func polygonArea(_ points: [CGPoint]) -> Double {
    guard points.count > 2 else { return 0 }
    var sum = 0.0
    for index in points.indices {
      let current = points[index]
      let next = points[(index + 1) % points.count]
      sum += Double(current.x * next.y) - Double(next.x * current.y)
    }
    return abs(sum) / 2
  }
}
