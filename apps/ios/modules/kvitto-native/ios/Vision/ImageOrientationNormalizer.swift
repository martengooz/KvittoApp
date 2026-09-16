import Foundation
import CoreImage
import ImageIO

final class ImageOrientationNormalizer {
  private let context = CIContext()

  func normalize(sourceURL: URL, destinationURL: URL, jpegQuality: Double) throws -> (width: Int, height: Int, bytes: Int) {
    let source = CIImage(contentsOf: sourceURL, options: [.applyOrientationProperty: true])
    guard let source else {
      throw NSError(domain: "KvittoNative", code: 1001, userInfo: [NSLocalizedDescriptionKey: "Unable to load image for normalization"])
    }

    let normalized = source.oriented(.up)
    guard let jpeg = context.jpegRepresentation(of: normalized, colorSpace: CGColorSpaceCreateDeviceRGB(), options: [kCGImageDestinationLossyCompressionQuality as CIImageRepresentationOption: jpegQuality]) else {
      throw NSError(domain: "KvittoNative", code: 1002, userInfo: [NSLocalizedDescriptionKey: "Unable to encode normalized JPEG"])
    }

    try jpeg.write(to: destinationURL, options: .atomic)
    let extent = normalized.extent.integral
    return (width: Int(extent.width), height: Int(extent.height), bytes: jpeg.count)
  }
}
