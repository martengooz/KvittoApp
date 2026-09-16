import Foundation
import CoreImage

struct NormalizedPoint: Codable {
  let x: Double
  let y: Double
}

struct NormalizedQuad: Codable {
  let topLeft: NormalizedPoint
  let topRight: NormalizedPoint
  let bottomRight: NormalizedPoint
  let bottomLeft: NormalizedPoint

  func denormalized(extent: CGRect) -> CIVectorQuad {
    CIVectorQuad(
      topLeft: CGPoint(x: topLeft.x * extent.width, y: topLeft.y * extent.height),
      topRight: CGPoint(x: topRight.x * extent.width, y: topRight.y * extent.height),
      bottomRight: CGPoint(x: bottomRight.x * extent.width, y: bottomRight.y * extent.height),
      bottomLeft: CGPoint(x: bottomLeft.x * extent.width, y: bottomLeft.y * extent.height)
    )
  }
}

struct CIVectorQuad {
  let topLeft: CGPoint
  let topRight: CGPoint
  let bottomRight: CGPoint
  let bottomLeft: CGPoint
}

extension NormalizedQuad {
  static func fromVisionRect(_ rectangle: CGRect) -> NormalizedQuad {
    NormalizedQuad(
      topLeft: NormalizedPoint(x: rectangle.minX, y: rectangle.maxY),
      topRight: NormalizedPoint(x: rectangle.maxX, y: rectangle.maxY),
      bottomRight: NormalizedPoint(x: rectangle.maxX, y: rectangle.minY),
      bottomLeft: NormalizedPoint(x: rectangle.minX, y: rectangle.minY)
    )
  }
}
